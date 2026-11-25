// dsh-guard native plugin -- a single-file Cordis plugin for the dsh desktop profile.
//
// WHY THIS SHAPE
//   The profile has no node_modules tree and `@deepseek-ai/*` cannot be resolved from it by
//   ordinary Node resolution, so a package-shaped plugin cannot be installed reliably (an
//   earlier attempt made the app fail to start). This file therefore imports NO
//   `@deepseek-ai/*` symbol: everything arrives through `apply(ctx, config)`.
//
// WHY NOT createRequire
//   An earlier revision reached `node:fs` through `createRequire(import.meta.url)`. Under
//   Electron's asar layer that is a landmine: if `import.meta.url` is an asar-internal URL,
//   `createRequire` throws while the MODULE is still being evaluated, so `apply()` never runs
//   and the plugin leaves no trace at all. The builtin is now reached with a plain dynamic
//   `import()` and top-level await, which needs no path at all.
//
// WHAT IT DOES
//   - `tools/pre-execute`: judges bulk / traversal / mass-scope `pwsh` and `write` calls and
//     returns `ask` (the panel approval dialog) or `deny` (hard block). A directly named
//     single file, and scoped work inside the workspace, fall through to `next()`.
//   - `agent/created`: injects one line of guard state before the session's first request.
//
// HONEST LIMITS
//   Pattern matching on a command string cannot see inside scripts, `python -c`, or compiled
//   binaries. This is a semantic gate in front of the filesystem sandbox, not a sandbox.

// Builtins through plain dynamic import + top-level await: no path, no createRequire, and
// nothing that can throw while this module is still being evaluated inside the asar layer.
const fs = await import('node:fs');
const { randomUUID } = await import('node:crypto');
const { fileURLToPath } = await import('node:url');
const { dirname } = await import('node:path');

/**
 * The profile directory this module belongs to, derived from its own URL.
 *
 * `DSH_PROFILE_DIR` is documented as set in every SHELL call of a profile-launched Harness — the
 * host process that imports this module does not necessarily have it (measured 2026-11-19: the
 * bundle applied with no env var, so it never found dsh-guard.json and never wrote its receipt).
 * Module-derived is always available:
 *   <profile>\node_modules\dsh-guard-native\lib\index.mjs  -> <profile>
 *   <profile>\dsh-guard-native.mjs                         -> <profile>   (legacy loose mode)
 */
export function profileDirOf(moduleUrl) {
  let dir = '';
  try { dir = dirname(fileURLToPath(moduleUrl)); } catch { return ''; }
  const lower = dir.toLowerCase().replace(/\//g, '\\');
  const at = lower.indexOf('\\node_modules\\');
  if (at !== -1) return dir.slice(0, at);
  return dir;
}

const MODULE_PROFILE_DIR = profileDirOf(import.meta.url);
const MODULE_DIR = (() => { try { return dirname(fileURLToPath(import.meta.url)); } catch { return ''; } })();
const MODULE_INSTALLED_IN_PROFILE = MODULE_DIR.toLowerCase().replace(/\//g, '\\').includes('\\node_modules\\');
// Set by apply(): where config and the load receipt live. Empty before the first apply, so the pure
// helpers keep working in tests and in the legacy loose mode.
let APPLY_PROFILE_DIR = '';

/**
 * Locate the profile directory for discovery. An installed package already yields it from the module
 * path. A `link:` install (plugin_manager installs a local package directory by linking it) leaves the
 * module in its source checkout, so the only reliable signal is the profile that declares us as a
 * bundle: the host does not export DSH_PROFILE_DIR to plugin code (measured 2026-11-19, re-measured
 * 2026-11-25 when the receipt landed in the repository instead of the profile).
 */
export function locateProfileDir(moduleProfileDir, installed, dshHome, opts = {}) {
  if (installed) return moduleProfileDir;
  const envDir = process.env.DSH_PROFILE_DIR;
  if (typeof envDir === 'string' && envDir !== '') return envDir;
  const home = String(dshHome || '').replace(/[\\/]+$/, '');
  if (!home) return moduleProfileDir;
  const profiles = home + '\\profiles';
  const readDir = opts.readDir || ((p) => fs.readdirSync(p));
  const readFile = opts.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const existsFn = opts.exists || exists;
  try {
    for (const name of readDir(profiles)) {
      const dir = profiles + '\\' + name;
      const pkgPath = dir + '\\package.json';
      if (existsFn(pkgPath)) {
        try {
          const doc = JSON.parse(readFile(pkgPath));
          const bundles = (doc && doc.dsh && doc.dsh.profile && doc.dsh.profile.bundles) || [];
          if (Array.isArray(bundles) && bundles.indexOf('dsh-guard-native') !== -1) return dir;
        } catch { /* keep scanning */ }
      }
      if (existsFn(dir + '\\node_modules\\dsh-guard-native')) return dir;
    }
  } catch { /* a machine without profiles still works from the module path */ }
  return moduleProfileDir;
}

// Every message the harness persists must carry a non-empty `id` (MessageBase.id). The
// session validator (`assertMessageEventShape`) rejects a stored `user/message` without one
// on resume -- that is what turns an injected status line into a CORRECT-but-corrupt session
// ("session event at seq N lacks an identified message"). Never inject without it.

// ---------------------------------------------------------------------------
// Which workspace does THIS call belong to?
// ---------------------------------------------------------------------------

// The scope of a call is defined by the session it runs in, not by a fixed path: the harness
// records one immutable workspace root per session (`SessionHeader.cwd`, "the root for every
// call in that session"). A configured constant can therefore only ever be a fallback -- when
// it drifts from the session actually in front of the gate, every in-workspace write outside
// that stale path is misreported as "outside the workspace". That is exactly what happened on
// 2026-10-15: the configured workspace was F:\work\proj while the live session's
// cwd was F:\work\app, so two ordinary single-file writes were escalated as if they
// were bulk operations. Resolution order is therefore:
//   1. an explicit override (tests only),
//   2. the live agent's session cwd,
//   3. the configured fallback.
/** Agent -> its resolved session workspace; the header is immutable, so one lookup is enough. */
const workspaceByAgent = new WeakMap();

/**
 * The workspace root of the session an agent is running in, or '' when the host does not
 * expose one (an unavailable field must degrade to the configured fallback, never throw).
 */
export function sessionWorkspaceOf(agent) {
  if (!agent || typeof agent !== 'object') return '';
  if (workspaceByAgent.has(agent)) return workspaceByAgent.get(agent);
  let found = '';
  try {
    const cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined;
    if (typeof cwd === 'string' && cwd.trim() !== '') found = cwd;
  } catch { found = ''; }
  try { workspaceByAgent.set(agent, found); } catch { /* a non-weak-referenceable agent */ }
  return found;
}

/** The workspace root this call is judged against, and where it came from (for the record). */
export function resolveWorkspace(input) {
  const opts = input || {};
  if (typeof opts.sessionWorkspace === 'string' && opts.sessionWorkspace.trim() !== '') {
    // A cwd that is not a rooted path cannot be a scope; refuse it rather than widen the gate.
    return isAbsolutePath(opts.sessionWorkspace)
      ? { workspace: opts.sessionWorkspace, source: 'session' }
      : { workspace: '', source: 'session-invalid' };
  }
  const configured = typeof opts.configuredWorkspace === 'string' ? opts.configuredWorkspace : '';
  const fromAgent = sessionWorkspaceOf(opts.agent);
  if (fromAgent) return { workspace: fromAgent, source: 'session' };
  return { workspace: configured, source: configured ? 'config-fallback' : 'unknown' };
}

/** Rooted on Windows (`C:\x`, `\\server\share`) or posix (`/x`). */
export function isAbsolutePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const s = value.trim();
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s) || /^\//.test(s);
}

// ---------------------------------------------------------------------------
// Rule tables (pure data -- no I/O, so the matrix is testable offline)
// ---------------------------------------------------------------------------

const BULK_RULES = {
  // A rule that inspects "the same statement" must stop at every statement separator, not just at a
  // newline or a pipe: `Remove-Item one.py; Get-ChildItem -Filter '_tmp*'` had the read-side wildcard
  // of the SECOND statement counted against the delete in the FIRST one.
  'ps-recursive-delete': /(?:^|[\s;&|])(?:Remove-Item|rm|ri|del|erase|rmdir|rd)\b[^\r\n|;&]*?(\s-Recurse\b|\s-r\b|\/s\b)/i,
  'ps-wildcard-write': /\b(?:Remove-Item|Remove-ItemProperty|Clear-Content|Set-Content|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty)\b[^\r\n|;&]*\*/i,
  // A pipeline is "mass" when the MODIFYING cmdlet consumes the piped objects as its TARGETS
  // (`Get-ChildItem … | Remove-Item` deletes every item). `… | Set-Content onefile` is different: the
  // piped objects are the CONTENT and the target is a separate literal argument, so the read side's
  // wildcards must not make it mass. That distinction is why Set-Content / Out-File / Add-Content are
  // absent here -- see the write-segment scope check in judge().
  'ps-mass-pipeline': /\|\s*(?:Remove-Item|Remove-ItemProperty|Move-Item|Copy-Item|Rename-Item|Clear-Item|Clear-ItemProperty|Set-ItemProperty)/i,
  'cmd-recursive-delete': /\b(?:del|erase|rd|rmdir)\b[^\r\n|]*?\/s\b/i,
  'cmd-mass-copy': /\b(?:robocopy|xcopy)\b/i,
  'shell-recursive-rm': /(?:^|[\s;&|])rm\s+(?:-[a-z]*r[a-z]*|--recursive)\b/i,
  'shell-recursive-attr': /\b(?:chmod|chown|chgrp)\s+(?:-[a-z]*R[a-z]*|--recursive)\b/i,
  'shell-find-exec': /\bfind\s+.*?(?:-delete\b|-exec\s+rm\b)/i,
  'git-rollback': /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)/i,
  'git-bulk-restore': /\bgit\s+restore\s+.*?--(?:staged|worktree)\s+\./i,
  'indirect-execution': /(?:Invoke-Expression|\bcmd(?:\.exe)?\s*\/c\b|\bStart-Process\b|\bwsl(?:\.exe)?\b|\bpwsh(?:\.exe)?\s+(?:-c|-Command|\/c))/i,
  'archive-overwrite': /\b(?:Expand-Archive|Expand-7Zip|tar|unzip|7z)\b/i,
  'bulk-attribute-write': /\b(?:attrib|takeown|icacls)\b[^\r\n|]*?(?:\/s\b|\/r\b|\/t\b|-Recurse\b)/i,
};

const DENY_RULES = {
  // Deny only when the delete target IS the drive root: the path ends right at its root
  // (optionally a wildcard on top of it). A bare `[A-Za-z]:\` followed by an ordinary path
  // segment is NOT this rule — that is what misfired on `C:\Users\me\a.txt`, whose `a:` looks
  // like a drive letter. Both shapes are covered here: `C:\` at end/quote/pipe, and `C:\*`.
  'unbounded-root-delete': /(?:^|[\s;&|])(?:Remove-Item|rm|ri|del|erase|rmdir|rd)\b[^\r\n|]*?[A-Za-z]:\\(?:\s*(?:$|\||;|"|'|\)|[A-Za-z]:\\")|[^\w\\])/i,
  'posix-root-delete': /(?:^|[\s;&|])rm\s+-[a-z]*r[a-z]*f[a-z]*\s+(?:--no-preserve-root\s+)?\/(\s|$|\*)/i,
  // Command-position anchored. Without the boundary this fired on the WORD anywhere in a command,
  // including a quoted -replace pattern or a doc edit that merely mentions the cmdlet (observed
  // 2026-11-19 while editing docs: a `-replace '…format-volume…'` was denied as a disk format).
  'format-volume': /(?:^|[\s;&|])(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i,
};

/** What counts as a modification when judging scope. */
export const DESTRUCTIVE_VERB = /\b(?:Remove-Item|Remove-ItemProperty|Clear-Content|Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|Rename-Item|Set-ItemProperty|New-Item|mkdir|rmdir|rm|mv|cp|chmod|chown|takeown|icacls|attrib|robocopy|xcopy|git\s+clean|unlinkSync|unlink|rmSync|removeSync|rmtree|os\.remove|os\.unlink|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|copyFileSync|copyFile|mkdirSync|makedirs|truncateSync)\b/i;

/**
 * The scope gate's mutation predicate: cmdlets that take a wildcard or an ARRAY of targets and
 * write (not only the ones that delete). `Remove-Item -Recurse -Force C:\Users\me\Desktop` is a
 * mass scope with no wildcard at all, so a delete-only predicate would under-cover it.
 *
 * Short aliases (`md`, `ri`, `rd`, `del`) are DELIBERATELY absent. They are two- and three-letter
 * words, so `\bmd\b` matched inside ordinary text: a wildcard read of `README.md` was escalated
 * as "BULK CREATES" because the predicate saw a mutating verb that was really a file extension.
 * Aliases still CLASSIFY actions through {@link ALIAS_VERB}, which anchors them to a command
 * boundary; they just cannot widen scope.
 */
export const MUTATING_VERB = /\b(?:Remove-Item|Remove-ItemProperty|Move-Item|Copy-Item|Rename-Item|Set-Content|Clear-Content|Add-Content|Out-File|Set-ItemProperty|New-Item|mkdir|rmdir|rm|mv|cp|chmod|chown|takeown|icacls|attrib|robocopy|xcopy|unlinkSync|unlink|rmSync|removeSync|rmtree|os\.remove|os\.unlink|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|copyFileSync|copyFile|mkdirSync|makedirs|truncateSync)\b/i;

/**
 * Command aliases, anchored to a command boundary (start of input, whitespace, or a `;`/`&`/`|`
 * separator) so a file extension or a word fragment cannot pass as a command. Used only to
 * CLASSIFY an action, never to widen scope.
 */
export const ALIAS_VERB = /(?<=^|[\s;&|])(?:md|ri|rd|del|erase|mv|cp)(?=\s|$)/i;

/** A directly named single target, with no bulk signal, is out of scope by contract. */
export const SCOPED_TARGET = /\b(?:Remove-Item|Move-Item|Copy-Item|Set-Content|Clear-Content|New-Item|Rename-Item)\b[^\r\n|]*?("|'|[A-Za-z]:\\|\.\\|\.\.\\)/i;

/** Absolute Windows path tokens: quoted (may contain spaces) or unquoted/naked. */
// Absolute path tokens: quoted (may contain spaces), a Windows path with either slash
// (`C:\x` AND `C:/x` -- the forward-slash form is legal PowerShell and used to slip past the
// external-target check entirely), a UNC path, or a posix path.
//
// The posix alternative requires a boundary BEFORE the slash (not a word character, not another
// slash) and a word character right after it. Without the before-anchor it matched fragments of
// ordinary script text -- `'approval/asked'` contributed a phantom `/asked` "outside target",
// while a bare `/` was read out of `2>/dev/null`. That both dirtied the outside-target list and
// manufactured escalations out of read-only probes.
export const PATH_TOKEN = /("[A-Za-z]:[\\/][^"]*"|'[A-Za-z]:[\\/][^']*'|[A-Za-z]:[\\/][^\s'"|;,)]*|\\\\\\\\[^\s'"|;,)]+|(?<![\w/])\/(?=[\w.])[^\s'"|;,)]*)/gi;

// ---------------------------------------------------------------------------
// What is the call actually DOING? (action class x scope x single-vs-mass)
// ---------------------------------------------------------------------------

// A human approving a dialog needs four facts, not a rule dump:
//   what the action does (batch delete / batch update / batch create / batch copy / ...),
//   where it lands (inside this project's workspace, or outside it),
//   whether it is one named target or a mass scope,
//   and which pattern fired (kept as evidence, no longer the headline).
// `MASS` is deliberately broader than BULK_RULES: every modifying verb participates, so a
// batch update (the case the narrower table missed) is recognised like a batch delete.
// Aliases in this table are anchored with ALIAS_VERB's boundary rule (`(?<=^|[\s;&|])name(?=\s|$)`)
// rather than `\bNAME\b`: a bare `\bmd\b` classified a README.md path as a create, and `\bri\b`
// appears inside ordinary identifiers.
const ALIAS = '(?<=^|[\\s;&|])(%s)(?=\\s|$)';
const aliasRe = (names) => new RegExp(ALIAS.replace('%s', names), 'i');
const VERB_ACTIONS = [
  { re: /\b(?:Remove-Item|Remove-ItemProperty|Clear-Content|rmdir|rm)\b|\bgit\s+clean\b/i, action: 'delete', verb: 'delete' },
  { re: aliasRe('del|erase|rd|ri'), action: 'delete', verb: 'delete' },
  { re: /\b(?:Move-Item|Rename-Item)\b/i, action: 'overwrite', verb: 'move' },
  { re: aliasRe('mv'), action: 'overwrite', verb: 'move' },
  { re: /\b(?:Set-Content|Add-Content|Out-File|Set-ItemProperty|New-ItemProperty|Clear-Item|Clear-ItemProperty)\b/i, action: 'overwrite', verb: 'write' },
  { re: /\bCopy-Item\b/i, action: 'context', verb: 'copy' },
  { re: aliasRe('cp'), action: 'context', verb: 'copy' },
  { re: /\b(?:New-Item|mkdir)\b/i, action: 'create', verb: 'create' },
  { re: aliasRe('md'), action: 'create', verb: 'create' },
  { re: /\b(?:robocopy|xcopy)\b/i, action: 'copy', verb: 'copy' },
  { re: /\b(?:Expand-Archive|Expand-7Zip|tar|unzip|7z)\b/i, action: 'extract', verb: 'extract' },
  { re: /\bchmod\b/i, action: 'chmod', verb: 'chmod' },
  { re: /\b(?:chown|chgrp|takeown|icacls|attrib)\b/i, action: 'attribute', verb: 'attribute' },
  { re: /\bgit\s+(?:reset\s+--hard|checkout\s+--\s+\.|restore\s+\.)/i, action: 'rollback', verb: 'rollback' },
  // File mutation APIs inside an inline script are still file mutation. `node -e "fs.writeFileSync(...)"`
  // and `python -c "shutil.rmtree(...)"` carry no PowerShell verb, so without these the scope
  // check never ran at all on a command that plainly writes outside the workspace.
  { re: /\b(?:unlinkSync|unlink|rmSync|rmdirSync|removeSync|rmtree|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree)\b/i, action: 'delete', verb: 'script-delete' },
  { re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|renameSync|copyFileSync|copyFile|mkdirSync|mkdir|makedirs|truncateSync|utimesSync|chmodSync|openSync)\b/i, action: 'overwrite', verb: 'script-write' },
  { re: /(?:Invoke-Expression|\bcmd(?:\.exe)?\s*\/c\b|\bStart-Process\b|\bwsl(?:\.exe)?\b)/i, action: 'indirect', verb: 'indirect' },
  { re: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i, action: 'disk', verb: 'disk' },
];

/** Mass scope: recursion, wildcards, or a batch pipeline feeding a modifying cmdlet. */
const MASS = /(?:^|[\s;&|])(?:-Recurse\b|-r\b|\/s\b|\/t\b)|\*|\?|\|\s*(?:Remove-Item|Move-Item|Copy-Item|Set-Content|Out-File|Clear-Content|Set-ItemProperty|ForEach-Object)/i;

const ACTION_EN = {
  delete: 'delete',
  overwrite: 'update (overwrite existing content)',
  create: 'create (new files/directories)',
  copy: 'copy onto existing paths',
  extract: 'extract an archive (overwrites the destination)',
  chmod: 'change permissions',
  attribute: 'change ownership/attributes',
  rollback: 'roll back working-tree changes',
  indirect: 'run an opaque shell command',
  disk: 'format/clear a disk',
  unknown: 'modify',
};

const ACTION_STATE_EN = {
  delete: 'DELETES',
  overwrite: 'OVERWRITES',
  create: 'CREATES',
  copy: 'COPIES ONTO',
  extract: 'EXTRACTS OVER',
  chmod: 'CHMODS',
  attribute: 'CHANGES OWNERSHIP OF',
  rollback: 'ROLLS BACK',
  indirect: 'RUNS AN OPAQUE COMMAND IN',
  disk: 'FORMATS',
  unknown: 'MODIFIES',
};
// Chinese names the OPERATION, not a subject: "批量删除（本工作区内）" reads as the operation a
// human is being asked to approve, whereas "批量会删除..." makes 批量 look like the actor.
const ACTION_ZH = {
  delete: '删除',
  overwrite: '改写',
  create: '新建',
  copy: '复制（覆盖目标）',
  extract: '解包覆盖',
  chmod: '改权限',
  attribute: '改属主/属性',
  rollback: '回退工作区改动',
  indirect: '执行不透明命令',
  disk: '格式化/清盘',
  unknown: '修改',
};

/**
 * The action class of one `write` call. A file path is not a command line: scanning it with the
 * verb table is how `D:\stuff\note.md` was once classified as "create" (the `md` in the file
 * name). A write is judged by what is on disk -- first-time creation, or an overwrite of
 * existing content -- which is also the distinction a human cares about when approving it.
 * @returns {{ action: string, verb: string, mass: boolean, reasons: string[] }}
 */
export function writeActionOf(filePath, pathExists) {
  const mass = /[*?]/.test(String(filePath || ''));
  // The probe returns a stat-shaped record (`{ exists, isDirectory }`), not a boolean, so
  // "does it exist" must accept both shapes -- reading only `=== true` silently downgraded
  // every overwrite of an existing file to "create", which is a materially different risk.
  const probe = typeof pathExists === 'function' ? pathExists(filePath) : undefined;
  const exists = probe === true || (!!probe && typeof probe === 'object' && probe.exists === true);
  if (exists) return { action: 'overwrite', verb: 'write', mass, reasons: [] };
  return { action: 'create', verb: 'write', mass, reasons: [] };
}

/**
 * The action class of one command, plus whether it is mass scope.
 * @returns {{ action: string, verb: string, mass: boolean, reasons: string[] }}
 */
export function actionOf(text) {
  const verbs = [];
  for (const entry of VERB_ACTIONS) {
    if (entry.re.test(text)) verbs.push(entry);
  }
  const mass = MASS.test(text);
  if (verbs.length === 0) return { action: 'unknown', verb: 'unknown', mass, reasons: [] };
  const first = verbs[0];
  const reasons = verbs.slice(1).map((v) => v.verb + ' also present');
  // `rm -rf` and the DENY_RULES disk verbs are deletes/formats first, not rollbacks.
  if (first.action === 'rollback' && verbs.some((v) => v.action === 'delete')) return { action: 'delete', verb: 'delete', mass, reasons };
  return { action: first.action, verb: first.verb, mass, reasons };
}

/**
 * The four facts, in one line, in both languages. English first because most of this file is
 * English; the Chinese line is what the panel's zh displayReason carries.
 * @returns {{ en: string, zh: string }}
 */
export function describeActionOf(analysis, scope) {
  // The scope sentence must agree with the SCOPE FACTS, not merely with "do we have a root?":
  // a call with any target outside the trusted roots IS an outside action, even though the
  // session root itself is known. Getting this backwards labelled an out-of-workspace write as
  // "inside this project workspace" while listing the outside target in parentheses.
  const external = (scope && scope.externalPaths) || [];
  const insideNames = (scope && scope.insidePaths) || [];
  const hasRoot = !!(scope && scope.workspace);
  const isOutside = external.length > 0 || !hasRoot;
  const whereEn = isOutside
    ? (hasRoot ? 'OUTSIDE this project workspace' : 'against NO known workspace root')
    : 'inside this project workspace';
  const whereZh = isOutside
    ? (hasRoot ? '本工作区外' : '未知工作区（无可用根）')
    : '本工作区内';
  // Name the outside targets only when the action REACHES OUT from inside: "outside the
  // workspace (outside target: X)" says the same thing twice, and when the action is entirely
  // outside the target list is the only content -- which is noise in a one-line dialog.
  const mixed = external.length > 0 && insideNames.length > 0;
  const extEn = mixed ? ' (outside target: ' + external.slice(0, 2).join(', ') + ')' : '';
  const extZh = mixed ? '（工作区外的目标：' + external.slice(0, 2).join('、') + '）' : '';
  const className = analysis.action + (analysis.mass ? '-mass' : '-single');
  let en;
  let zh;
  if (analysis.action === 'unknown') {
    en = 'this call ' + ACTION_STATE_EN.unknown + ' paths ' + whereEn + extEn;
    zh = '修改操作（' + whereZh + '）' + extZh;
  } else if (analysis.mass) {
    en = 'BULK ' + ACTION_STATE_EN[analysis.action] + ' paths ' + whereEn + extEn;
    zh = '批量' + ACTION_ZH[analysis.action] + '（' + whereZh + '）' + extZh;
  } else {
    en = 'this call ' + ACTION_STATE_EN[analysis.action] + ' ' + (isOutside ? 'one path ' + whereEn : 'one named path ' + whereEn) + extEn;
    zh = ACTION_ZH[analysis.action] + '单个目标（' + whereZh + '）' + extZh;
  }
  return { en, zh, className };
}

/**
 * The scope facts for one call: which root was used, its provenance, and which absolute
 * targets fall outside it. Shared by the dialog and the audit row.
 *
 * A global root (`C:\`, `/`, a UNC share root) is NEVER "inside the project": the project just
 * happens to sit under it, and a destructive verb aimed at the root itself is the most
 * unbounded case there is, not a workspace-local edit.
 */
export function scopeFactsOf(text, resolved, insideRoots, readPath, rootDeleteMatched) {
  // A path NAME does not continue into `|`, `)` or `>`, but a regex character class and a closing
  // HTML tag do: `(/json|zstd/)` yields `/json|zstd/`, `</body></html>` yields `/body>`.
  // A bare `/` between spaces (`-join " / "`) is already rejected by the PATH_TOKEN anchor, which
  // requires a word character right after the slash.
  //
  // A URL is NOT a filesystem target. `http://127.0.0.1:19387/dsh-guard/status?format=json` used to
  // yield `p://127.0.0.1:19387/dsh-guard/status?format=json` -- the slash anchor let the match
  // start at the scheme's last letter -- so simply CALLING the guard's own status page was reported
  // as "BULK OVERWRITES paths OUTSIDE this project workspace", with the `?` in the query string
  // firing the wildcard rule as well. A candidate bound to a scheme is dropped.
  const boundToScheme = (t) => {
    const before = String(text || '').slice(Math.max(0, t.index - 8), t.index);
    return /[A-Za-z][A-Za-z0-9+.-]*:$/.test(before) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(t.full);
  };
  const tokens = pathTokens(text, readPath).filter((t) => {
    if (boundToScheme(t)) return false;
    if (/[|)>]$/.test(t.full)) return false;
    if (!t.full.startsWith('/')) return true;
    const after = text[t.index + t.full.length];
    return after !== '|' && after !== ')' && after !== '>';
  });
  const globalRoot = (p) => /^[A-Za-z]:[\\/]*$/.test(p) || p === '/' || p === '\\' || /^\\\\[^\\]+\\?$/.test(p);
  const externalPaths = tokens.filter((t) => !underAnyRoot(t.full, insideRoots) || globalRoot(t.full)).map((t) => t.full);
  const insidePaths = tokens.filter((t) => underAnyRoot(t.full, insideRoots) && !globalRoot(t.full)).map((t) => t.full);
  // A filesystem root that a DENY rule caught (`rm -rf /`) has no path TOKEN -- a lone `/` is not
  // a path -- yet "which root was aimed at" is exactly the fact that made it a deny. The caller
  // therefore tells us a root-delete rule matched; without that match a bare `/` is ordinary
  // script punctuation (`-join " / "`) and must never enter this list. An earlier version added
  // it unconditionally, which escalated the agent's own acceptance command as
  // "BULK OVERWRITES paths OUTSIDE this project workspace (outside target: /)".
  if (rootDeleteMatched) {
    const roots = String(text || '').match(/(?:^|[\s;&|'"=])(\/)(?=$|[\s;&|'"*])/g);
    if (roots && roots.length > 0 && !externalPaths.includes('/')) externalPaths.push('/');
  }
  return {
    workspace: resolved.workspace,
    workspaceSource: resolved.source,
    externalPaths: [...new Set(externalPaths)],
    insidePaths: [...new Set(insidePaths)],
  };
}

/** The unconditional fact line, shared by every verdict that reaches a human. */
export function actionSummaryOf(text, resolved, insideRoots, readPath, rules, forcedAnalysis) {
  const analysis = forcedAnalysis || actionOf(text);
  // The bare `/` fact is admitted only when a root-delete DENY rule is among the matched ids.
  const rootDeleteMatched = [...new Set(rules || [])].some((id) => id === 'unbounded-root-delete' || id === 'posix-root-delete');
  const scope = scopeFactsOf(text, resolved, insideRoots, readPath, rootDeleteMatched);
  const described = describeActionOf(analysis, scope);
  return {
    analysis,
    scope,
    className: described.className,
    en: described.en,
    zh: described.zh,
    rules: [...new Set(rules || [])],
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function normalize(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\');
  // Fold the duplicate backslashes that appear when a path is written inside a script/JSON string
  // literal: `'C:\\Users\\x'` in command text denotes the ONE path C:\Users\x. Without this, the same
  // file was read as "outside every root" and produced 26 spurious escalations in the live ledger.
  // Two prefixes keep their leading pair on purpose: a UNC share (`\\server\share`) and the long-path
  // marker (`\\?\C:\…`).
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  else if (/^\\\\[^\\]/.test(s)) s = '\\\\' + s.slice(2).replace(/\\{2,}/g, '\\');
  else s = s.replace(/\\{2,}/g, '\\');
  if (s.length > 3) s = s.replace(/\\+$/, '');
  return s.toLowerCase();
}

/** True when `path` sits at or under any of `roots`. */
export function underAnyRoot(path, roots) {
  const p = normalize(path);
  if (!p) return false;
  for (const root of roots || []) {
    const r = normalize(root);
    if (!r) continue;
    if (p === r || p.startsWith(r.endsWith('\\') ? r : r + '\\')) return true;
  }
  return false;
}

/**
 * A POSIX-looking token is only a filesystem target when it names a real top-level root. On Windows,
 * `pwsh` has no POSIX absolute paths, while code inside a command produces them by accident:
 * `root/"releases"/f"{stem}.zip"` yielded `/stem` and `/f`, and those phantoms became "outside
 * targets" that escalated three packaging runs (live ledger, 2026-11-10). The allowlist keeps genuine
 * Unix paths (`/etc/hosts`, `/tmp/x`, WSL/bash commands) and drops the accidents.
 */
export const POSIX_TARGET = /^\/(?:etc|tmp|var|home|usr|dev|opt|root|srv|mnt|media|proc|sys|bin|sbin|lib|lib64|boot|run|Volumes|Users)(?:[\\/]|$)/i;

/**
 * Every absolute path token in the text, with an existence/directory probe.
 * `readPath` is injectable so the matrix runs without touching a real filesystem.
 */
export function pathTokens(text, readPath) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  const seen = new Set();
  const re = new RegExp(PATH_TOKEN.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/^["']|["']$/g, '');
    if (raw.startsWith('/') && !POSIX_TARGET.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let isDirectory = false;
    let exists = false;
    if (typeof readPath === 'function') {
      const probe = readPath(raw);
      if (probe) { exists = true; isDirectory = probe.isDirectory === true; }
    }
    out.push({ raw, full: raw, exists, isDirectory, index: m.index, length: m[0].length });
  }
  return out;
}

/**
 * Split a command into statement and pipeline segments. Quoted strings are kept intact so a `|` or
 * `;` inside a literal does not split anything. Used to answer "which operand is the WRITE target":
 * only the segments that contain a mutating verb own wildcard / multi-target scope.
 */
export function commandSegments(text) {
  if (typeof text !== 'string' || text === '') return [];
  const out = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++;   // `||` / `&&` is one separator
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/** The text of the segments that actually mutate something (empty when nothing mutates). */
export function writeSegmentsOf(text) {
  const writes = commandSegments(text).filter((s) => MUTATING_VERB.test(s));
  return writes.length ? writes.join('\n') : '';
}

/**
 * Does the command hand work to a REMOTE host? ssh/scp/sshpass/sftp/plink, PowerShell remoting, wsl.
 * A path inside such a payload names the other machine, so it is not local write scope.
 */
export function isRemoteInvocation(text) {
  return /(?:^|[\s;&|])(?:ssh|sshpass|scp|sftp|plink|Invoke-Command|Enter-PSSession|wsl)\b/i.test(String(text || ''));
}

/** The quoted / here-string part that runs on the other host (empty for a plain local command). */
export function remotePayloadOf(text) {
  const out = [];
  const re = /@'([\s\S]*?)'@|@"([\s\S]*?)"@|'([^']*)'|"((?:[^"`]|\\.)*)"/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.push(m[1] || m[2] || m[3] || m[4] || '');
  return out.join('\n');
}

/** A remote payload that deletes or rewrites is still worth one question. */
export function remoteDestructive(payload) {
  const p = String(payload || '');
  if (!p.trim()) return false;
  return MUTATING_VERB.test(p)
    || /(?:^|[\s;&|])(?:dd|mkfs\.?\w*|systemctl|service|chmod|chown|truncate|tee)\b/i.test(p);
}

/** Paths that are read, never written: a credential file or an executable. */
export function isReadOnlyExternalPath(p) {
  const s = String(p || '');
  return /\.ssh[\\/]/i.test(s) || /[\\/]id_(?:ed25519|rsa|ecdsa)\b/i.test(s) || /\.exe$/i.test(s);
}

/** Sinks, not targets: /dev/null, NUL, $null. */
export function isBenignSink(p) {
  const s = String(p || '').trim();
  return /^(?:\/dev\/null|nul|\$null)(?::|$)/i.test(s) || /(?:^|[\\/])NUL$/i.test(s);
}

/** `-DestinationPath` of an extraction, used by the "a new/empty target is not an overwrite" check. */
export function archiveDestination(text) {
  const m = /-(?:DestinationPath|Destination)\s+['"]?([^'"\s]+)/i.exec(String(text || ''));
  return m ? m[1] : '';
}
export function resolveRelative(base, rel) {
  const r = String(rel || '').trim().replace(/^["']|["']$/g, '').replace(/\//g, '\\');
  if (!r) return '';
  if (isAbsolutePath(r)) return r.replace(/\\+$/, '');
  const parts = String(base || '').replace(/\//g, '\\').split('\\').filter((p) => p !== '');
  for (const seg of r.split('\\')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length > 1) parts.pop(); continue; }
    parts.push(seg);
  }
  const joined = parts.join('\\');
  return /^[A-Za-z]:$/.test(joined) ? joined + '\\' : joined;
}

/**
 * Dot-relative path tokens (`.`, `.\x`, `../y`) inside the write segments.
 *
 * They matter because `Session.header.cwd` is the session's ORIGIN and permission root, while
 * `working_directory` changes the CURRENT directory (a separate service and event). After a `cd`,
 * `Remove-Item -Recurse .\*` has no absolute token at all, so a guard that only reads absolute paths
 * cannot tell where it lands -- which is how `cd C:\Users\<you>` followed by `.\*` would slip past.
 */
export function relativeTargetsOf(text) {
  const out = [];
  const re = /(?:^|[\s'"=(,])(\.{1,2}(?:[\\/][^\s'"`;|)]*)?)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const token = m[1].replace(/[\\/]+$/, '') || '.';
    if (token === '.' || token === '..') out.push(token);
    else if (/^\.{1,2}[\\/]/.test(token)) out.push(token);
  }
  return [...new Set(out)];
}

function matched(text, table) {
  const hits = [];
  for (const key of Object.keys(table)) {
    try { if (table[key].test(text)) hits.push(key); } catch { hits.push('pattern-error:' + key); }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Why a call was escalated: the dialog has to name the rule, in words
// ---------------------------------------------------------------------------

// A gate that only says "a bulk destructive operation needs your approval" forces the human to
// reverse-engineer which pattern fired. Every rule id therefore carries a plain-language
// explanation, and every escalation prints the matched ids, their explanations, the exact
// target, and the workspace root the judgement used.
const RULE_EXPLAIN = {
  'write-wildcard-target': 'the write target is a wildcard pattern (* or ?), so it names many files',
  'write-outside-workspace': 'the write target is outside every trusted root of this session',
  'write-in-protected-root': 'the write target sits under a protected system/user root outside the session workspace',
  'write-without-path': 'the write call carried no file_path, so its scope cannot be judged',
  'edit-outside-workspace': 'the edit target is outside every trusted root of this session',
  'edit-in-protected-root': 'the edit target sits under a protected root outside the session workspace',
  'edit-wildcard-target': 'the edit target contains a wildcard (an edit should name one file)',
  'edit-without-path': 'the edit call carried no file_path',
  'tool-outside-workspace': 'a configured extra-gated tool targets a path outside every trusted root',
  'tool-in-protected-root': 'a configured extra-gated tool targets a protected root outside the session workspace',
  'tool-wildcard-target': 'a configured extra-gated tool targets a wildcard',
  'tool-without-path': 'a configured extra-gated tool carried no path argument',
  'plugin-install': 'this call installs, removes or reconfigures a plugin bundle, which changes the code dsh loads at its next launch',
  'dry-run': 'a PowerShell -WhatIf dry run modifies nothing',
  'remembered-approval': 'this exact command was approved and executed within the configured memory window',
  'untracked-tool': 'a tool whose name suggests mutation is NOT gated by any rule set (recorded once per process so upgrade drift is visible)',
  'remote-command': 'the command hands a destructive payload to a REMOTE host (ssh/scp/wsl), so the paths in it are not local targets',
  'relative-target-in-protected-root': 'a relative write target resolves (against the session\'s CURRENT directory) into a protected root outside the workspace',
  'cwd-outside-workspace': 'the session\'s CURRENT directory is outside every trusted root, so a relative write target cannot be scoped',
  'ps-recursive-delete': 'PowerShell recursive delete (-Recurse / -r)',
  'ps-wildcard-write': 'a PowerShell modifying cmdlet aimed at a wildcard target',
  'ps-mass-pipeline': 'a pipeline feeding a cmdlet that consumes the piped items as its targets (batch delete/move/copy)',
  'cmd-recursive-delete': 'cmd del/rd with /s (recursive delete)',
  'cmd-mass-copy': 'robocopy / xcopy (bulk copy or mirror)',
  'shell-recursive-rm': 'rm -r / --recursive',
  'shell-recursive-attr': 'recursive chmod / chown / chgrp',
  'shell-find-exec': 'find -delete or find -exec rm',
  'git-rollback': 'git reset --hard / clean / checkout -- . (whole-tree rollback)',
  'git-bulk-restore': 'git restore of a whole tree',
  'indirect-execution': 'the real command is hidden behind a shell (Invoke-Expression, cmd /c, Start-Process, wsl, nested pwsh)',
  'archive-overwrite': 'archive extraction can overwrite a whole tree',
  'bulk-attribute-write': 'recursive attrib / takeown / icacls',
  'external-path-target': 'a destructive verb aimed at a path outside every trusted root of this session',
  'wildcard-target': 'the command contains a wildcard target',
  'multiple-path-targets': 'the command names two or more existing targets',
  'directory-target-outside-workspace': 'a destructive verb aimed at a directory outside the session workspace',
  'unbounded-root-delete': 'the delete target IS a drive root (unrecoverable)',
  'posix-root-delete': 'rm -rf / (unrecoverable)',
  'format-volume': 'disk format / clear / initialize',
  'hard-stop': 'the HARD-STOP emergency switch is active',
  'panic-override': 'PANIC mode downgraded a hard deny to this question',
  'judge-failed': 'dsh-guard could not evaluate this call at all (fails closed)',
  'emergency-disable': 'the DISABLE emergency switch is active',
  'sandbox-escalation': 'the call carries sandbox_permissions, so the file sandbox is not a backstop for it',
};

/** One rule id, with its explanation when the table has one. */
export function explainRule(id) {
  const text = RULE_EXPLAIN[id] || RULE_EXPLAIN[String(id).split(':')[0]];
  return text ? id + ' -- ' + text : id + ' -- matched dsh-guard\u2019s pattern table';
}

/** The `  - rule: ...` lines for every matched id (deduplicated), newline-terminated. */
function explainRules(ids) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return '';
  return '\n  - rule: ' + unique.map((id) => explainRule(id)).join('\n  - rule: ');
}

/** The root the judgement actually used, so a stale configuration is visible in the dialog. */
function scopeLine(scope) {
  const root = scope && scope.workspace ? scope.workspace : '(none: no session workspace and no configured fallback)';
  const how = scope && scope.workspaceSource === 'session'
    ? 'this session\u2019s own workspace root'
    : (scope && scope.workspaceSource === 'config-fallback'
      ? 'the configured fallback (this session exposed no workspace root)'
      : (scope && scope.workspaceSource === 'session-invalid' ? 'an invalid session workspace value' : 'unknown'));
  return '\n  - workspace: ' + root + ' (' + how + ')';
}

// ---------------------------------------------------------------------------
// The decision (pure: inputs in, decision out)
// ---------------------------------------------------------------------------

/**
 * Judge one pending tool call.
 * @returns {{ decision: 'allow'|'ask'|'deny', rules: string[], reason: string, workspace?: string, workspaceSource?: string }}
 */
export function judge(input) {
  const opts = input || {};
  const {
    toolName = '',
    command = '',
    filePath = '',
    // Deliberately NOT destructured: `sessionWorkspace` is read straight off `opts` by
    // resolveWorkspace(). A same-named local binding would shadow the property and silently
    // discard the live session's workspace -- the exact bug this change exists to fix.
    dshHome = '',
    stateDir = '',
    protectedRoots = [],
    panic = false,
    disable = false,
    hardStop = false,
    readPath,
  } = opts;

  // The scope of this call: the session's own workspace root first, the configured value only
  // as a fallback. `scopedWorkspace` is what a human sees in the dialog, so it must be the
  // root actually compared against -- not the constant from the config file.
  const resolved = resolveWorkspace({ sessionWorkspace: opts.sessionWorkspace, configuredWorkspace: opts.workspace, agent: opts.agent });
  const workspace = resolved.workspace;
  // The CURRENT directory of the session, which `working_directory`/`create_worktree` change through
  // the workingDirectory service. It is NOT the permission root: `Session.header.cwd` stays the
  // origin, and the sandbox's writable roots stay fixed to it. Relative targets are resolved against
  // this value, because that is where the tool actually runs.
  const sessionCwd = typeof opts.sessionCwd === 'string' ? opts.sessionCwd.trim() : '';
  const scope = { workspace, workspaceSource: resolved.source, cwd: sessionCwd };
  // additionalRoots is the explicit way to say "I also work in THIS project during this session".
  // Without it, one session touching a second checkout escalates every reference to the other tree
  // (89 `external-path-target` hits over 35 days, while the user worked in three projects).
  const extraRoots = Array.isArray(opts.additionalRoots) ? opts.additionalRoots.filter((r) => typeof r === 'string' && r !== '') : [];
  const inside = [workspace, dshHome, stateDir, ...extraRoots].filter(Boolean);
  const escalationMode = typeof opts.sandboxPermissions === 'string' ? opts.sandboxPermissions : '';
  const sandbox = escalationMode
    ? ' [sandbox: this call carries sandbox_permissions=' + escalationMode + ', so the file sandbox is NOT a backstop for it]'
    : '';

  if (disable) return { decision: 'allow', rules: ['emergency-disable'], reason: '', ...scope };

  const isWrite = toolName === 'write';
  // `edit` is a single-file, search/replace mutation. It is the MOST frequent write in real use
  // (1202 calls vs 88 `write` calls over 35 days), and it can still touch a file outside the
  // session workspace, so it is gated by SCOPE ONLY: an in-workspace single file stays silent, a
  // path under a protected root or outside every trusted root asks.
  const isEdit = toolName === 'edit';
  const pluginAction = typeof opts.pluginAction === 'string' ? opts.pluginAction : '';

  // A bundle install/removal is not a file edit: it is CODE that runs at the next launch, which
  // outlives any single deletion. Gated regardless of switches except DISABLE.
  const PLUGIN_MUTATIONS = new Set(['install_bundle', 'remove_bundle', 'set_bundle', 'set_plugin', 'set_version_exemption']);
  if (toolName === 'plugin_manager') {
    if (!PLUGIN_MUTATIONS.has(pluginAction)) {
      return { decision: 'allow', rules: ['out-of-scope-tool'], reason: '', ...scope };
    }
    const target = typeof opts.pluginTarget === 'string' ? opts.pluginTarget : '(unspecified)';
    const summary = actionSummaryOf(target, resolved, inside, readPath, ['plugin-install']);
    const sentence = {
      en: 'this call changes which plugins dsh loads at its next launch (' + pluginAction + ': ' + target + ')',
      zh: '这次调用会改变 dsh 下次启动时加载的插件（' + pluginAction + '：' + target + '）',
    };
    const rules = hardStop ? ['hard-stop:plugin-install'] : ['plugin-install'];
    return {
      decision: hardStop ? 'deny' : 'ask',
      rules,
      action: { ...summary, en: sentence.en, zh: sentence.zh },
      reason: 'dsh-guard ' + (hardStop ? 'DENY' : 'ASK') + ' [plugin-install]: ' + sentence.en + '\n'
        + '  - 摘要: ' + sentence.zh + '\n'
        + '  - decision: ' + (hardStop
          ? 'NOT executed. Do not retry, do not work around it: report to the user instead.'
          : 'the call has NOT run; approve only if you intend this plugin change.')
        + scopeLine(summary.scope)
        + explainRules(['plugin-install']),
      ...summary.scope,
    };
  }

  // Tools beyond pwsh/write/edit that must at least get the scope check (run_code, str_replace_editor,
  // or whatever a future dsh release adds). Configured explicitly: the guard cannot infer a new
  // tool's semantics, and silently ignoring one is how a hole opens on upgrade.
  const extraTool = Array.isArray(opts.extraGatedTools) && opts.extraGatedTools.includes(toolName);
  if (!isWrite && !isEdit && !extraTool && toolName !== 'pwsh') {
    return { decision: 'allow', rules: ['out-of-scope-tool'], reason: '', ...scope };
  }

  const text = isWrite || isEdit
    ? filePath
    : (extraTool ? (typeof opts.extraToolPath === 'string' ? opts.extraToolPath : '') : command);

  // A PowerShell dry run modifies nothing. Only cmdlets that genuinely honour -WhatIf are accepted:
  // `cmd /c`, `del`, robocopy and the native tools are NOT, because a flag they ignore would let a
  // real command hide behind it.
  const POWERSHELL_DRY_RUN = /\b(?:Remove-Item|Remove-ItemProperty|Set-Content|Add-Content|Clear-Content|Copy-Item|Move-Item|Rename-Item|New-Item|Set-ItemProperty|Out-File|Format-Volume|Clear-Disk|Initialize-Disk|New-ItemProperty)\b[^\r\n|;&]*?-WhatIf\b/i;
  if (!isWrite && !isEdit && !extraTool && POWERSHELL_DRY_RUN.test(String(command || ''))) {
    return { decision: 'allow', rules: ['dry-run'], reason: '', ...scope };
  }

  // --- the sandbox-bypass floor: only a CROSSING is escalated -------------------------------
  //
  // A call carrying `sandbox_permissions` asks the file sandbox to STAND DOWN for that one call:
  // the `workspace-write` fence is gone and it runs with the harness process's own authority.
  // The field alone is NOT the risk, though -- the risk is what it lets happen across the
  // boundary. So this floor fires only for a CROSSING:
  //
  //   * a deletion (mass, or any delete aimed outside the workspace) -- destroying data, and
  //   * a MASS rewrite -- overwrite / create / extract / attribute change at mass scope,
  //     which is the batch-rewrite shape whether it lands inside or outside.
  //
  // A single in-workspace write, a single in-workspace read, or any inside-the-workspace
  // single-target call passes through even with the field set: the sandbox standing down cannot
  // reach past the project, so there is nothing extra to approve. `disable` (the emergency
  // switch) still wins outright -- it is the human's own off-button.
  const sandboxFloor = (verdict) => {
    if (verdict.decision !== 'allow' || escalationMode === '') return verdict;
    const baseRules = (verdict.rules || []).filter((id) => id !== 'sandbox-escalation');
    // Rules that already escalate on their own; this floor re-labels the allow-ish shapes that
    // would otherwise pass silently, so the ledger keeps exactly one truthful rule id.
    const scopeRule = baseRules.find((id) => id === 'write-outside-workspace' || id === 'write-in-protected-root'
      || id === 'write-wildcard-target' || id === 'edit-outside-workspace' || id === 'edit-in-protected-root'
      || id === 'external-path-target'
      || id === 'multiple-path-targets' || id === 'directory-target-outside-workspace');
    const summary = actionSummaryOf(text, resolved, inside, readPath, [scopeRule || 'sandbox-escalation']);
    const analysis = summary.analysis;
    const outside = summary.scope.externalPaths.length > 0;
    const destroying = analysis.action === 'delete';
    // `copy` belongs here: a copy WRITES every destination it lands on, so a recursive/bulk copy
    // is a mass rewrite of the target side. Leaving it out made the floor miss the one shape it
    // exists for -- `Copy-Item -Recurse` is not in any bulk rule table, so with the sandbox
    // standing down it would rewrite a whole tree unattended.
    //
    // NOTE the action names come from the VERB_ACTIONS table, where `Copy-Item` / `cp` / `mv`
    // are classified as **`context`** (destination-dependent). Comparing against `'copy'` -- the
    // robocopy/xcopy class -- silently matched nothing, which is how this stayed broken through
    // a test run that looked green: the assertion used the same wrong name.
    const rewriting = analysis.action === 'overwrite' || analysis.action === 'create'
      || analysis.action === 'extract' || analysis.action === 'attribute' || analysis.action === 'disk'
      || analysis.action === 'copy' || analysis.action === 'context' || analysis.action === 'indirect';
    const crossing = destroying || (analysis.mass && rewriting);
    // Name the rule that made this a crossing, so the dialog still answers "which rule fired?".
    const rule = scopeRule || 'sandbox-escalation';
    if (!crossing) return { ...verdict, rules: baseRules.length ? baseRules : verdict.rules };
    const sentence = {
      en: (destroying
        ? (analysis.mass ? 'this call requests full authority to delete a mass scope' : 'this call requests full authority to delete outside this project workspace')
        : 'this call requests full authority for a mass rewrite' + (outside ? ' outside this project workspace' : ''))
        + ' (sandbox_permissions=' + escalationMode + ')',
      zh: (destroying
        ? (analysis.mass ? '这条命令请求越过沙箱，执行大批量删除' : '这条命令请求越过沙箱，删除本工作区外的数据')
        : '这条命令请求越过沙箱，执行大批量改写' + (outside ? '（目标在本工作区外）' : ''))
        + '（sandbox_permissions=' + escalationMode + '）',
    };
    const reason = 'dsh-guard ' + (hardStop ? 'DENY' : 'ASK') + ' [sandbox-escalation]: ' + sentence.en + '\n'
      + '  - 摘要: ' + sentence.zh + '\n'
      + '  - rule: sandbox-escalation -- the call carries sandbox_permissions, so the file sandbox is NOT a backstop for it\n'
      + '  - rule: ' + explainRule(rule)
      + '  - decision: ' + (hardStop
        ? 'NOT executed. Do not retry, do not work around it, do not rewrite it to evade the pattern: report to the user instead.'
        : 'the call has NOT run; approve only if you intend exactly this scope.')
      + scopeLine(summary.scope)
      + '\n  - target: ' + String(text).replace(/\s+/g, ' ').slice(0, 200)
      + sandbox;
    const action = { ...summary, en: sentence.en, zh: sentence.zh };
    const rules = ['sandbox-escalation', ...(scopeRule ? [scopeRule] : [])];
    if (hardStop) return { decision: 'deny', rules, reason, action, ...summary.scope };
    return { decision: 'ask', rules, reason, action, ...summary.scope };
  };

  if (typeof text !== 'string' || text.trim().length === 0) {
    if (isWrite || isEdit || extraTool) {
      const noPathRule = isEdit ? 'edit-without-path' : (extraTool ? 'tool-without-path' : 'write-without-path');
      const noun = isEdit ? 'edit' : (extraTool ? 'call' : 'write');
      const summary = actionSummaryOf(text, resolved, inside, readPath, [noPathRule]);
      return sandboxFloor({
        decision: 'ask',
        rules: [noPathRule],
        action: { ...summary, en: 'this ' + noun + ' names NO path, so its scope cannot be judged', zh: '这次调用没有给出路径，范围无法判断' },
        reason: 'dsh-guard ASK [' + noPathRule + ']: this ' + noun + ' names NO path, so its scope cannot be judged\n'
          + '  - 摘要: 这次调用没有给出路径，范围无法判断\n'
          + '  - decision: the call has NOT run; approve only if you already know exactly which file is touched.'
          + explainRules([noPathRule]) + sandbox,
        ...scope,
      });
    }
    return sandboxFloor({ decision: 'allow', rules: ['empty-command'], reason: '', ...scope });
  }

  const rules = [];
  let denyRules = [];

  // Relative write targets resolved against the LIVE session directory. Two crossings are possible:
  // a relative target that lands inside a protected root while the workspace is elsewhere, and a
  // mutation attempted after the session moved outside every trusted root (the relative target is
  // then unjudgeable). Both are asks, with their own rule ids so the dialog can say which it is.
  const relativeScopeRules = (segmentText) => {
    if (!sessionCwd) return;
    const rels = relativeTargetsOf(segmentText);
    if (!rels.length) return;
    const resolved = rels.map((r) => resolveRelative(sessionCwd, r)).filter(Boolean);
    const inProtected = resolved.some((p) => underAnyRoot(p, protectedRoots) && !underAnyRoot(p, [workspace, dshHome, stateDir]));
    if (inProtected) rules.push('relative-target-in-protected-root');
    if (!underAnyRoot(sessionCwd, inside)) rules.push('cwd-outside-workspace');
  };

  if (isWrite || isEdit || extraTool) {
    const prefix = isEdit ? 'edit' : (extraTool ? 'tool' : 'write');
    if (/[*?]/.test(text)) rules.push(prefix + '-wildcard-target');
    if (!underAnyRoot(text, inside)) rules.push(prefix + '-outside-workspace');
    if (underAnyRoot(text, protectedRoots) && !underAnyRoot(text, [workspace])) rules.push(prefix + '-in-protected-root');
    relativeScopeRules(text);
  } else {
    for (const r of matched(text, BULK_RULES)) rules.push(r);
    denyRules = matched(text, DENY_RULES);

    // One pass resolves every text-level signal, and EVERY scope rule is gated on the same
    // "does this command mutate anything" predicate.
    //
    // That predicate used to gate only the path checks, while `wildcard-target` and
    // `multiple-path-targets` fired on any wildcard or multi-path command. A plain read --
    // `Get-ChildItem -Recurse -Filter *.json | Select-Object -First 3`, `Get-Item a, b` -- was
    // therefore escalated as a bulk destructive operation. Read-only work asks nothing now
    // (the read is not the risk); a mutating verb with a wildcard or several targets still
    // escalates, and `ps-wildcard-write` / `ps-recursive-delete` keep covering their shapes.
    const mutating = MUTATING_VERB.test(text);
    if (mutating) {
      // Scope is decided by the WRITE-side operands. A wildcard or a second path on the READ side of
      // a pipeline is not a mass write: `Get-ChildItem releases\adnet-v*.zip | … | Set-Content
      // releases\SHA256SUMS.txt` writes ONE file, yet the read-side wildcard made the whole call
      // "BULK OVERWRITES" and the user rejected exactly that (live ledger 2026-11-10T10:21:13Z).
      // `Remove-Item one.py; Get-ChildItem -Filter '_tmp*'` was the same shape.
      const writeText = writeSegmentsOf(text);
      const writeTokens = pathTokens(writeText, readPath);
      const tokens = pathTokens(text, readPath);
      const remote = isRemoteInvocation(text);

      // Three classes of path token are NOT local write scope, measured over 104 live asks:
      //   * a POSIX path inside an ssh/scp payload is on the REMOTE host (28 asks, 27%);
      //   * a credential/executable in a read position never gets written (.ssh keys 11, chrome 5);
      //   * /dev/null, NUL and $null are sinks, not targets.
      // Filtering here keeps every destructive rule and every local target exactly as before.
      const localScope = (t) => !isBenignSink(t.full)
        && !isReadOnlyExternalPath(t.full)
        && !(remote && t.full.startsWith('/'));
      const scopeTokens = (writeTokens.length > 0 ? writeTokens : tokens).filter(localScope);

      // Destructive work aimed outside the session's own roots is bulk by definition.
      if (scopeTokens.some((t) => !underAnyRoot(t.full, inside))) rules.push('external-path-target');

      // A remote command that carries a destructive payload is still worth ONE question, but the
      // reason must say "remote", not "outside this workspace". Read-only remote payloads stay silent.
      if (remote && remoteDestructive(remotePayloadOf(text))) rules.push('remote-command');

      // Protected roots: the WRITE side carrying a wildcard or several real targets is mass scope.
      if (/[*?]/.test(writeText)) rules.push('wildcard-target');
      const real = writeTokens.filter((t) => localScope(t) && t.exists);
      if (real.length >= 2) rules.push('multiple-path-targets');
      if (writeTokens.some((t) => localScope(t) && t.isDirectory && !underAnyRoot(t.full, [workspace]))) {
        rules.push('directory-target-outside-workspace');
      }
      relativeScopeRules(writeText);
    }
  }

  // "Archive overwrite" is only an overwrite when the destination already holds something. Extracting
  // into a fresh directory is the normal deploy step (10 live asks), so probe the destination: missing
  // or empty means there is nothing to overwrite.
  if (rules.indexOf('archive-overwrite') !== -1) {
    const dest = archiveDestination(text);
    if (dest) {
      const probe = typeof readPath === 'function' ? readPath(dest) : undefined;
      // Missing destination: extraction creates it, so there is nothing to overwrite. An existing
      // directory is only safe when the probe proves it is empty; unknown emptiness counts as a
      // possible overwrite (the probe contract allows `isEmpty` but older probes do not report it).
      const overwrites = probe ? (probe.isDirectory ? probe.isEmpty !== true : true) : false;
      if (!overwrites) rules.splice(rules.indexOf('archive-overwrite'), 1);
    }
  }

  const unique = [...new Set(rules)];
  const realDeny = [...new Set(denyRules)].filter((r) => !r.startsWith('pattern-error:'));
  const patternErrors = [...new Set([...denyRules, ...rules])].filter((r) => r.startsWith('pattern-error:'));

  // Every escalation is expressed as: ONE classified sentence -> the decision -> the root that
  // judged it -> the matched patterns as evidence -> a truncated raw target. The old shape led
  // with a rule dump, which is what made an ordinary write look like an unexplained bulk job.
  const escalation = (kind, ids, tail) => {
    // A drive/filesystem root delete (`rm -rf /`, `Remove-Item C:\`) HAS no `-Recurse` and no
    // wildcard to match, yet it is the most mass-scoped delete there is. The class must say so.
    const rootDelete = ids.some((id) => id === 'posix-root-delete' || id === 'unbounded-root-delete');
    const forced = (isWrite || isEdit || extraTool)
      ? writeActionOf(text, readPath)
      : (rootDelete ? { ...actionOf(text), mass: true } : undefined);
    const summary = actionSummaryOf(text, resolved, inside, readPath, ids, forced);
    // The kind is passed explicitly. Deriving it from the label once produced a DENY that told
    // the reader "the call has NOT run ... approve only if you intend this scope" -- a deny
    // must never read like a question.
    const headline = kind === 'deny'
      ? 'dsh-guard DENY [' + ids.join(', ') + ']'
      : 'dsh-guard ASK [' + (ids.length ? ids.join(', ') : 'gate-unavailable') + ']';
    const decision = kind === 'deny'
      ? 'NOT executed. Do not retry, do not work around it, do not rewrite it to evade the pattern: report to the user instead.'
      : 'the call has NOT run; approve only if you intend exactly this scope.';
    const reason = headline + ': ' + summary.en + '\n'
      + '  - 摘要: ' + summary.zh + '\n'
      + '  - decision: ' + decision
      + scopeLine(summary.scope)
      + explainRules(ids)
      + '\n  - target: ' + String(text).replace(/\s+/g, ' ').slice(0, 200)
      + (tail || '') + sandbox;
    return { reason, summary };
  };

  if (patternErrors.length > 0 && realDeny.length === 0 && unique.every((r) => r.startsWith('pattern-error:'))) {
    const { reason, summary } = escalation('ask', patternErrors, '\n  - the gate could not evaluate its own rule table, so it fails closed.');
    return { decision: 'ask', rules: patternErrors, reason, action: summary, ...summary.scope };
  }

  if (realDeny.length > 0) {
    const ids = realDeny.join(', ');
    const { reason, summary } = escalation('deny', realDeny, '\n  - this target is unbounded or unrecoverable.');
    if (hardStop || !panic) return { decision: 'deny', rules: realDeny, reason, action: summary, ...summary.scope };
    return { decision: 'ask', rules: ['panic-override:' + ids], reason: '[PANIC MODE - human override] ' + reason, action: summary, ...summary.scope };
  }

  if (unique.length === 0) {
    const scoped = SCOPED_TARGET.test(text);
    return sandboxFloor({ decision: 'allow', rules: [scoped ? 'scoped-single-target' : 'no-bulk-signal'], reason: '', ...scope });
  }

  const ids = unique.join(', ');
  const { reason: askReason, summary } = escalation('ask', unique, '');
  if (hardStop) return { decision: 'deny', rules: ['hard-stop:' + ids], reason: 'dsh-guard HARD-STOP is active. ' + askReason, action: summary, ...summary.scope };
  if (panic) return { decision: 'ask', rules: unique, reason: '[PANIC MODE] ' + askReason, action: summary, ...summary.scope };
  return { decision: 'ask', rules: unique, reason: askReason, action: summary, ...summary.scope };
}

// ---------------------------------------------------------------------------
// Host-side defaults and plugin entry
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // FALLBACK ONLY. Every tool call is judged against the live session's own workspace root
  // (SessionHeader.cwd); this value applies only to a session that exposes no cwd at all. It
  // FALLBACK ONLY, and empty by design: every call is judged against its session's own cwd. A
  // non-empty constant here silently mislabels other projects' work (the original 2026-10-15 defect).
  workspace: '',
  dshHome: '',
  stateDir: '',
  // Resolved in configOf() from the running user's home plus its drive root: a public install must
  // protect ITS user, not the developer's home. An explicit non-empty list still wins.
  protectedRoots: [],
  // Extra trusted roots, for people who work across several projects in one session. Explicit on
  // purpose: this widens "inside" without weakening any rule.
  additionalRoots: [],
  auditLog: '',
  // 'full' | 'brief' | false. 'brief' keeps posture + workspace + switches and drops the audit
  // counters, which are the part that changes and costs tokens in every session.
  statusLine: true,
  // Ledger rotation. 34 KB/day with no bound is ~12 MB/year.
  auditMaxBytes: 8000000,
  auditKeep: 3,
  // Load receipt blocks to keep (it grew one block per apply()).
  loadMarkerKeep: 20,
  // Opt-in: remember an escalation that was approved AND executed, keyed by exact command + scope,
  // for a short TTL. Default off: it trades safety for fewer prompts, so the user must ask for it.
  rememberApproved: { enabled: false, ttlSeconds: 900 },
  // Tools beyond pwsh/write/edit that should at least get the scope check (e.g. run_code).
  extraGatedTools: [],
  publicBaseUrl: '',
  // How many approval outcomes to keep in the rolling file behind the 24h panel.
  outcomesKeep: 1000,
  // What an escalation does. 'ask' returns a question (the harness asks a human). 'deny' returns a
  // refusal with the same reason: use it when approvals are disabled, where an ask is auto-rejected
  // in milliseconds and reads as an approval error instead of a clear block.
  askMode: 'ask',
  // `gating: false` keeps the plugin observable while installing nothing dangerous: it still
  // registers, still writes a load marker, and still injects the status line, but every call
  // is allowed. `enabled: false` would also skip the marker -- the exact blindness that made
  // "did the loader accept the entry?" unanswerable.
  gating: true,
  enabled: true,
  // A receipt written next to the plugin on every apply(). It exists because the audit log
  // lives outside the workspace and an unwritable sink once made "did this load?" unanswerable.
  // The profile directory is demonstrably writable, so this is the load signal of record.
  loadMarker: '',
};

export function configOf(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!cfg.dshHome) cfg.dshHome = home ? home + '\\.dsh' : '';
  if (!cfg.stateDir) cfg.stateDir = cfg.dshHome ? cfg.dshHome + '\\emergency' : '';
  if (!cfg.auditLog) cfg.auditLog = cfg.stateDir ? cfg.stateDir + '\\guard-audit.jsonl' : '';
  // Bundle mode has no generated patch, so the receipt is derived from the module's own profile (the
  // env var is only a fallback: the host process may not export it). Without this a package install
  // would silently lose "did the loader accept the entry?".
  if (!cfg.loadMarker) {
    const dir = APPLY_PROFILE_DIR || MODULE_PROFILE_DIR || (typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR : '');
    if (dir) cfg.loadMarker = dir.replace(/[\\/]+$/, '') + '\\dsh-guard-native-loaded.txt';
  }
  if (!Array.isArray(cfg.protectedRoots) || cfg.protectedRoots.length === 0) {
    // The developer's home was once a literal default; derive it from the running user instead so a
    // public install protects the right profile. `C:\` (or the home's own drive root) stays protected.
    const driveRoot = /^[A-Za-z]:[\\/]/.test(home) ? home.slice(0, 3) : '';
    cfg.protectedRoots = home ? [home, driveRoot].filter(Boolean) : ['C:\\'];
  }
  if (!Array.isArray(cfg.additionalRoots)) cfg.additionalRoots = [];
  cfg.additionalRoots = cfg.additionalRoots.filter((r) => typeof r === 'string' && r.trim() !== '');
  if (!Array.isArray(cfg.extraGatedTools)) cfg.extraGatedTools = [];
  cfg.extraGatedTools = cfg.extraGatedTools.filter((t) => typeof t === 'string' && t !== '');
  if (typeof cfg.workspace !== 'string') cfg.workspace = '';
  if (typeof cfg.enabled !== 'boolean') cfg.enabled = DEFAULTS.enabled;
  if (typeof cfg.gating !== 'boolean') cfg.gating = DEFAULTS.gating;
  // statusLine accepts true / false / 'full' / 'brief' so an existing `true` keeps working.
  if (cfg.statusLine !== false && cfg.statusLine !== 'brief') cfg.statusLine = true;
  cfg.auditMaxBytes = Number.isFinite(cfg.auditMaxBytes) && cfg.auditMaxBytes > 0 ? Math.floor(cfg.auditMaxBytes) : DEFAULTS.auditMaxBytes;
  cfg.auditKeep = Number.isInteger(cfg.auditKeep) && cfg.auditKeep >= 0 ? cfg.auditKeep : DEFAULTS.auditKeep;
  cfg.loadMarkerKeep = Number.isInteger(cfg.loadMarkerKeep) && cfg.loadMarkerKeep >= 1 ? cfg.loadMarkerKeep : DEFAULTS.loadMarkerKeep;
  const ra = cfg.rememberApproved && typeof cfg.rememberApproved === 'object' ? cfg.rememberApproved : {};
  cfg.rememberApproved = {
    enabled: ra.enabled === true,
    ttlSeconds: Number.isFinite(ra.ttlSeconds) && ra.ttlSeconds > 0 ? Math.floor(ra.ttlSeconds) : DEFAULTS.rememberApproved.ttlSeconds,
  };
  if (typeof cfg.publicBaseUrl !== 'string') cfg.publicBaseUrl = '';
  cfg.outcomesKeep = Number.isInteger(cfg.outcomesKeep) && cfg.outcomesKeep >= 10 ? cfg.outcomesKeep : DEFAULTS.outcomesKeep;
  cfg.askMode = cfg.askMode === 'deny' ? 'deny' : 'ask';
  // Derived path, not a separate knob: one state directory owns everything the guard writes.
  cfg.outcomesFile = cfg.stateDir ? cfg.stateDir + '\\guard-outcomes.json' : '';
  return cfg;
}

// ---------------------------------------------------------------------------
// Configuration schema (no dependencies)
// ---------------------------------------------------------------------------

// dsh's settings UI reads a plugin's exported config schema to render its knobs, so the fields
// below are what a user sees in Settings -> Plugins for this plugin. The shape is deliberately
// tiny: `~standard` validation works on any library's schema, and this file must import nothing
// (the profile has no module tree to resolve a schema library from).
export const ConfigSchema = {
  '~standard': {
    version: 1,
    vendor: 'dsh-guard',
    validate: (input) => {
      const issues = [];
      const value = typeof input === 'object' && input !== null ? input : {};
      const str = (name, fallback) => {
        const v = value[name];
        if (v === undefined) return fallback;
        if (typeof v !== 'string') { issues.push({ message: name + ' must be a string', path: [name] }); return fallback; }
        return v;
      };
      const bool = (name, fallback) => {
        const v = value[name];
        if (v === undefined) return fallback;
        if (typeof v !== 'boolean') { issues.push({ message: name + ' must be a boolean', path: [name] }); return fallback; }
        return v;
      };
      let protectedRoots = value.protectedRoots;
      if (protectedRoots === undefined) protectedRoots = DEFAULTS.protectedRoots;
      else if (!Array.isArray(protectedRoots) || protectedRoots.some((r) => typeof r !== 'string')) {
        issues.push({ message: 'protectedRoots must be an array of absolute paths', path: ['protectedRoots'] });
        protectedRoots = DEFAULTS.protectedRoots;
      }
      const out = {
        enabled: bool('enabled', DEFAULTS.enabled),
        gating: bool('gating', DEFAULTS.gating),
        statusLine: value.statusLine === 'brief' ? 'brief' : bool('statusLine', DEFAULTS.statusLine),
        askMode: value.askMode === 'deny' ? 'deny' : 'ask',
        workspace: str('workspace', ''),
        dshHome: str('dshHome', ''),
        stateDir: str('stateDir', ''),
        auditLog: str('auditLog', ''),
        loadMarker: str('loadMarker', ''),
        publicBaseUrl: str('publicBaseUrl', ''),
        protectedRoots,
        additionalRoots: Array.isArray(value.additionalRoots) ? value.additionalRoots : [],
        extraGatedTools: Array.isArray(value.extraGatedTools) ? value.extraGatedTools : [],
        auditMaxBytes: Number.isFinite(value.auditMaxBytes) ? value.auditMaxBytes : DEFAULTS.auditMaxBytes,
        auditKeep: Number.isInteger(value.auditKeep) ? value.auditKeep : DEFAULTS.auditKeep,
        loadMarkerKeep: Number.isInteger(value.loadMarkerKeep) ? value.loadMarkerKeep : DEFAULTS.loadMarkerKeep,
        rememberApproved: value.rememberApproved && typeof value.rememberApproved === 'object'
          ? value.rememberApproved
          : DEFAULTS.rememberApproved,
      };
      if (out.statusLine !== 'brief' && typeof out.statusLine !== 'boolean') {
        issues.push({ message: 'statusLine must be true, false, "full" or "brief"', path: ['statusLine'] });
      }
      for (const name of ['additionalRoots', 'extraGatedTools']) {
        if (value[name] !== undefined && !Array.isArray(value[name])) {
          issues.push({ message: name + ' must be an array', path: [name] });
        }
      }
      if (out.workspace !== '' && !isAbsolutePath(out.workspace)) {
        issues.push({ message: 'workspace must be an absolute path (it is only a fallback)', path: ['workspace'] });
      }
      if (issues.length) return { issues };
      return { value: out };
    },
  },
};

function exists(p) {
  if (!p) return false;
  try { return fs.existsSync(p); } catch { return false; }
}

/** The emergency switches currently present in the state directory. Module scope: both the
 *  gating path and the disabled path report it. */
function activeSwitchesOf(cfg) {
  return ['DISABLE', 'PANIC', 'HARD-STOP'].filter((n) => exists(cfg.stateDir + '\\' + n));
}

/**
 * Rotate the ledger when it reaches `auditMaxBytes`. Keeps `auditKeep` historical files
 * (`<ledger>.1` newest … `<ledger>.<keep>` oldest). 34 KB/day with no bound is ~12 MB/year, and an
 * unbounded audit file is the kind of thing that only gets noticed when it is inconvenient.
 */
function rotateLedgerIfNeeded(cfg) {
  try {
    if (!exists(cfg.auditLog)) return false;
    if (fs.statSync(cfg.auditLog).size < cfg.auditMaxBytes) return false;
    const path = cfg.auditLog;
    const keep = cfg.auditKeep;
    if (keep <= 0) { fs.rmSync(path, { force: true }); return true; }
    for (let i = keep; i >= 1; i--) {
      const from = i === 1 ? path : path + '.' + (i - 1);
      const to = path + '.' + i;
      if (!exists(from)) continue;
      try { fs.rmSync(to, { force: true }); } catch { /* ignore */ }
      try { fs.renameSync(from, to); } catch { /* ignore */ }
    }
    try { fs.rmSync(path + '.' + (keep + 1), { force: true }); } catch { /* ignore */ }
    return true;
  } catch { return false; }
}

/** Append one audit row. Never throws: the gate must not depend on the audit sink. */
function appendAudit(cfg, entry) {
  try {
    if (!exists(cfg.stateDir)) fs.mkdirSync(cfg.stateDir, { recursive: true });
    if (rotateLedgerIfNeeded(cfg)) {
      fs.appendFileSync(cfg.auditLog, JSON.stringify({
        ts: new Date().toISOString(),
        session: '', callId: '', tool: 'guard-native', decision: 'rotate',
        rule: 'audit-rotation', sandbox: '', reason: '', preview: 'rotated at ' + cfg.auditMaxBytes + ' bytes, keep ' + cfg.auditKeep,
      }) + '\n', 'utf8');
    }
    fs.appendFileSync(cfg.auditLog, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/** Build the one-line status the session should see (pure; audit rows are injected). */
export function statusLine(cfg, mode, switches, audit, sessionWorkspace, sessionCwd) {
  const sw = switches.length > 0 ? 'ON(' + switches.join('/') + ')' : 'none';
  const state = mode || 'active';
  const root = sessionWorkspace || cfg.workspace || 'none';
  // The current directory differs from the origin whenever `working_directory`/`create_worktree` ran.
  // Showing it only when it differs keeps the line short while making a moved session visible.
  const moved = sessionCwd && sessionCwd !== root ? ' | cwd: ' + sessionCwd : '';
  // 'brief' drops the audit counters and the parenthetical: they are the parts that change (so they
  // cannot be cached) and they are already one command away in status.ps1 / the status page.
  if (cfg.statusLine === 'brief') {
    let short = 'dsh-guard ' + state + ' | workspace: ' + root + moved + ' | switches: ' + sw;
    if (switches.includes('DISABLE')) short = 'WARNING: dsh-guard is DISABLED (DISABLE switch present). ' + short;
    if (state.includes('SHADOW')) short = 'dsh-guard SHADOW (gates nothing) | workspace: ' + root + moved + ' | switches: ' + sw;
    return short + '.';
  }
  const detail = audit && audit.total > 0
    ? `audits: ${audit.total} total, last-200 allow=${audit.allow} ask=${audit.ask} deny=${audit.deny}. last: ${audit.last || 'none'}`
    : 'audits: none yet';
  const scope = sessionWorkspace
    ? `workspace: ${sessionWorkspace} (this session's own cwd)` + (moved ? `, now working in ${sessionCwd}` : '')
    : `workspace: ${cfg.workspace || 'none'} (configured fallback -- this session exposed no cwd)`;
  let line = `dsh-guard ${state} (bulk/traversal pwsh + writes outside the session workspace ask first; unbounded deletes denied). ${scope}. emergency switches: ${sw}. ${detail}.`;
  if (state.includes('SHADOW')) {
    line = 'NOTE: dsh-guard is installed in SHADOW mode -- it records and reports but gates nothing. ' + line;
  }
  if (state.includes('DISABLED')) {
    line = 'WARNING: dsh-guard is DISABLED by config -- bulk deletions run unattended. ' + line;
  }
  if (switches.includes('DISABLE')) {
    line = 'WARNING: dsh-guard is DISABLED (DISABLE switch present) -- bulk deletions run unattended. ' + line;
  }
  return line;
}

/** Roll up the audit log: totals, per-decision counts, the newest interesting row, a short tail, and
 *  a time-windowed set of counts. The window matters because the 24h panel must show the gate's own
 *  asks even when no human ever answered them (this build fails closed without an answerer). */
export function summarizeAudit(text, windowMs = 24 * 3600 * 1000) {
  const out = { total: 0, allow: 0, ask: 0, deny: 0, last: '', recent: [], window: { hours: 24, allow: 0, ask: 0, deny: 0 } };
  if (typeof text !== 'string' || text.length === 0) return out;
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  out.total = lines.length;
  const cutoff = Date.now() - (Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 24 * 3600 * 1000);
  out.window.hours = Math.round((Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 24 * 3600 * 1000) / 3600000);
  const window = lines.slice(-200);
  let last = '';
  for (const line of window) {
    try {
      const e = JSON.parse(line);
      if (e.decision === 'allow') out.allow++;
      else if (e.decision === 'ask') { out.ask++; last = `${e.decision} [${e.rule}] ${String(e.preview || '').slice(0, 60)}`; }
      else if (e.decision === 'deny') { out.deny++; last = `${e.decision} [${e.rule}] ${String(e.preview || '').slice(0, 60)}`; }
      const t = Date.parse(e.ts);
      if (Number.isFinite(t) && t >= cutoff) {
        if (e.decision === 'allow') out.window.allow++;
        else if (e.decision === 'ask') out.window.ask++;
        else if (e.decision === 'deny') out.window.deny++;
      }
    } catch { /* a damaged row must not break the rollup */ }
  }
  out.last = last;
  // The newest 12 rows for the settings section: enough to see what the gate just did, small enough
  // to ship inside one status response.
  out.recent = [];
  for (const line of lines.slice(-12)) {
    try {
      const e = JSON.parse(line);
      out.recent.push({
        ts: String(e.ts || ''),
        decision: String(e.decision || ''),
        rules: Array.isArray(e.rules) ? e.rules : (e.rule ? String(e.rule).split(',').map((s) => s.trim()) : []),
        tool: String(e.tool || ''),
        preview: String(e.preview || '').slice(0, 160),
      });
    } catch { /* skip a damaged row */ }
  }
  out.recent.reverse();
  return out;
}

/**
 * The rule ids out of a guard approval reason (`dsh-guard ASK [a, b]: …`).
 * The approval events carry the reason text, so the panel can attribute outcomes to rules without
 * joining back to the ledger.
 */
export function rulesFromReason(reason) {
  const text = String(reason || '');
  // PANIC mode prefixes the reason ("[PANIC MODE] dsh-guard ASK [rule]: …"), so the guard tag must be
  // located first; taking the first bracket would report the mode as the rule name.
  const tagged = /dsh-guard\s+(?:ASK|DENY)\s*\[([^\]]+)\]/.exec(text);
  if (tagged) return tagged[1].split(',').map((s) => s.trim()).filter(Boolean);
  const m = /\[([^\]]+)\]/.exec(text);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Count the approval outcomes of the last `hours`. `allowed-once` and `always` are approvals;
 * `rejected` is a rejection; anything else (no decision yet, cancelled) stays pending.
 */
export function summarizeApprovals(rows, nowMs, hours = 24) {
  const list = Array.isArray(rows) ? rows : [];
  const span = Number.isFinite(hours) && hours > 0 ? hours : 24;
  const cutoff = nowMs - span * 3600 * 1000;
  const inWindow = list.filter((r) => Number.isFinite(r.ts) && r.ts >= cutoff);
  const approved = inWindow.filter((r) => r.outcome === 'allowed-once' || r.outcome === 'always' || r.outcome === 'allowed').length;
  const rejected = inWindow.filter((r) => r.outcome === 'rejected').length;
  const pending = inWindow.length - approved - rejected;
  const decided = approved + rejected;
  const tally = (subset) => {
    const m = new Map();
    for (const r of subset) for (const rule of r.rules || []) m.set(rule, (m.get(rule) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rule, count]) => ({ rule, count }));
  };
  // Lifetime counts over the whole ring: the 24h window is empty right after an install or a quiet
  // day, and a panel that reads 0/0/0 looks broken rather than quiet.
  const allApproved = list.filter((r) => r.outcome === 'allowed-once' || r.outcome === 'always' || r.outcome === 'allowed').length;
  const allRejected = list.filter((r) => r.outcome === 'rejected').length;
  const isAuto = (r) => r.outcome === 'rejected' && Number.isFinite(r.latencyMs) && r.latencyMs < 50;
  return {
    hours: span,
    asked: inWindow.length,
    approved,
    rejected,
    pending,
    // A rejection within 50 ms means no human answered: this build fails closed when no answerer is
    // attached. Separating it keeps "the user rejected it" from "the dialog never reached anyone".
    autoRejected: inWindow.filter(isAuto).length,
    approvalRate: decided > 0 ? Number((approved / decided).toFixed(3)) : null,
    allTime: {
      asked: list.length,
      approved: allApproved,
      rejected: allRejected,
      since: list.length ? new Date(Math.min(...list.map((r) => r.ts))).toISOString() : '',
    },
    byRuleAsked: tally(inWindow),
    byRuleRejected: tally(inWindow.filter((r) => r.outcome === 'rejected')),
    newest: inWindow.length ? new Date(Math.max(...inWindow.map((r) => r.ts))).toISOString() : '',
  };
}

/**
 * The full, on-demand status report. One owner for every machine-readable fact the guard can
 * state about itself, so the session line, the `/dsh-guard/status` page, the PowerShell report
 * script, and the ledger all read the SAME numbers instead of drifting apart.
 *
 * @param {object} facts - cfg, mode, switches, audit rollup, watched sessions, plugin identity
 */
export function statusReport(facts) {
  const f = facts || {};
  const cfg = f.cfg || {};
  const switches = f.switches || [];
  const audit = f.audit || { total: 0, allow: 0, ask: 0, deny: 0, last: '' };
  const mode = f.mode || 'active';
  const sessions = f.sessions || [];
  const gating = mode.indexOf('SHADOW') === -1 && mode.indexOf('DISABLED') === -1;
  const disabled = mode.indexOf('DISABLED') !== -1 || switches.includes('DISABLE');
  const held = disabled ? 'DISABLED (emergency switch)' : (switches.includes('HARD-STOP') ? 'HARD-STOP (asks become denies)' : 'normal');
  return {
    generatedAt: new Date().toISOString(),
    plugin: {
      id: name,
      loadedAt: f.loadedAt || '',
      pid: f.pid || process.pid,
      node: process.version,
      file: f.file || '',
      hash: f.hash || '',
      gating,
      mode,
    },
    posture: {
      headline: disabled
        ? 'DISABLED -- bulk deletions run unattended'
        : (gating ? 'ACTIVE -- bulk/traversal and out-of-workspace work ask first' : 'SHADOW -- records but gates nothing'),
      emergency: held,
      switches: switches.length ? switches : ['none'],
    },
    workspace: {
      configuredFallback: cfg.workspace || '',
      additionalRoots: Array.isArray(cfg.additionalRoots) ? cfg.additionalRoots : [],
      resolution: "each call uses its session's own cwd (SessionHeader.cwd) plus additionalRoots; the configured fallback applies only when a session exposes none",
    },
    sessions,
    audit: {
      file: cfg.auditLog || '',
      total: audit.total,
      last200: { allow: audit.allow, ask: audit.ask, deny: audit.deny },
      last: audit.last || 'none',
      recent: Array.isArray(audit.recent) ? audit.recent : [],
      // Time-windowed gate decisions. The panel needs these because an ask that no human ever saw
      // still happened; the approval ring only knows what reached an answerer.
      window: audit.window || { hours: 24, allow: 0, ask: 0, deny: 0 },
      rotation: 'at ' + (cfg.auditMaxBytes || 0) + ' bytes, keep ' + (cfg.auditKeep || 0),
    },
    // Where the knobs came from, and the ones the settings section may change. `file` is the JSON the
    // POST /dsh-guard/action endpoint writes; empty means the values are patch-only.
    config: {
      file: f.configPath || '',
      source: f.configPath ? 'file+dEFAULTS' : 'patch/defaults',
      effective: {
        enabled: cfg.enabled !== false,
        gating: cfg.gating !== false,
        statusLine: cfg.statusLine,
        askMode: cfg.askMode || 'ask',
        rememberApproved: cfg.rememberApproved || { enabled: false, ttlSeconds: 900 },
        additionalRoots: Array.isArray(cfg.additionalRoots) ? cfg.additionalRoots : [],
        extraGatedTools: Array.isArray(cfg.extraGatedTools) ? cfg.extraGatedTools : [],
        auditMaxBytes: cfg.auditMaxBytes || 0,
        auditKeep: cfg.auditKeep || 0,
        protectedRoots: Array.isArray(cfg.protectedRoots) ? cfg.protectedRoots : [],
      },
    },
    memory: {
      rememberApproved: cfg.rememberApproved && cfg.rememberApproved.enabled
        ? 'enabled, ' + cfg.rememberApproved.ttlSeconds + 's TTL, only after the call actually executed'
        : 'disabled',
    },
    // The 24h panel: what the guard asked, and how the human answered. This is the precision signal
    // -- a rule that keeps getting rejected is a rule that needs work.
    approvals: f.approvals || summarizeApprovals([], Date.now(), 24),
    rules: {
      bulk: Object.keys(BULK_RULES),
      deny: Object.keys(DENY_RULES),
      scope: ['external-path-target', 'wildcard-target', 'multiple-path-targets', 'directory-target-outside-workspace'],
      special: ['sandbox-escalation', 'write-outside-workspace', 'write-in-protected-root', 'write-wildcard-target', 'edit-outside-workspace', 'plugin-install', 'dry-run', 'remembered-approval', 'judge-failed'],
    },
    surfaces: {
      sessionLine: 'agent/created injects one line per session (source kind guard-native)',
      approvalDialog: 'tools/pre-execute returns ask, so the panel shows the classified sentence; the full reason is recorded in session events approval/asked',
      // The page URL must be the host:port that actually answered the request. dsh picks a new port on
      // every launch (19387 -> 64794 -> 60939 within hours), so a hardcoded URL is dead on arrival.
      // `requestHost` is taken from the incoming Host header by the route handler.
      thisPage: f.requestHost ? 'http://' + f.requestHost + '/dsh-guard/status' : '/dsh-guard/status (open it on the running host; dsh changes the port every launch)',
      ledger: cfg.auditLog || '',
      sessionEvents: 'approval/asked carries the full reason text; the panel stores it, hook/* events are not rendered',
      settingsSection: 'NOT available: settings.section is a CLIENT slot, and a client contribution must ship a built lib/client.js served by the host as /plugins/<package>/client.js -- a loose profile .mjs cannot register it',
    },
  };
}

/** Render the report as a self-contained HTML page (no assets, no network, no scripts). */
export function statusReportHtml(report) {
  const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const row = (k, v) => '<tr><th>' + esc(k) + '</th><td>' + esc(v) + '</td></tr>';
  const sessions = (report.sessions || []).map((s) => '<li><code>' + esc(s.id || '') + '</code> workspace <code>' + esc(s.workspace || '(none)') + '</code></li>').join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>dsh-guard status</title><style>'
    + 'body{font:14px/1.5 ui-monospace,Consolas,monospace;margin:24px;max-width:60em;color:#111}'
    + 'h1{font-size:18px}table{border-collapse:collapse;width:100%;margin:8px 0 20px}'
    + 'th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}th{width:14em;background:#f6f6f6}'
    + 'code{background:#f2f2f2;padding:0 3px}.warn{color:#a00;font-weight:600}</style></head><body>'
    + '<h1>dsh-guard ' + esc(report.plugin.mode) + '</h1>'
    + '<p' + (report.posture.headline.startsWith('DISABLED') ? ' class="warn"' : '') + '>' + esc(report.posture.headline) + '</p>'
    + '<table>'
    + row('generated', report.generatedAt)
    + row('plugin', report.plugin.id + ' (' + report.plugin.file + ')')
    + row('loaded', report.plugin.loadedAt + '  pid=' + report.plugin.pid + '  node=' + report.plugin.node)
    + row('gating', String(report.plugin.gating))
    + row('emergency', report.posture.emergency + '   switches: ' + report.posture.switches.join(', '))
    + row('workspace model', report.workspace.resolution)
    + row('configured fallback', report.workspace.configuredFallback)
    + row('additional roots', (report.workspace.additionalRoots || []).join(', ') || '(none)')
    + row('audit ledger', report.audit.file)
    + row('audit totals', report.audit.total + ' total, last-200 allow=' + report.audit.last200.allow + ' ask=' + report.audit.last200.ask + ' deny=' + report.audit.last200.deny)
    + row('audit rotation', report.audit.rotation)
    + row('approval memory', report.memory ? report.memory.rememberApproved : '')
    + row('approvals (last ' + report.approvals.hours + 'h)',
      report.approvals.asked + ' asked · ' + report.approvals.approved + ' approved · '
      + report.approvals.rejected + ' rejected · ' + report.approvals.pending + ' pending'
      + (report.approvals.autoRejected ? ' · ' + report.approvals.autoRejected + ' auto-rejected without an answerer' : '')
      + (report.approvals.approvalRate === null ? '' : ' · approval rate ' + Math.round(report.approvals.approvalRate * 100) + '%')
      + (report.approvals.newest ? ' · newest ' + report.approvals.newest : ''))
    + row('gate asks (last ' + (report.audit.window ? report.audit.window.hours : 24) + 'h)',
      report.audit.window
        ? report.audit.window.ask + ' asked · ' + report.audit.window.allow + ' allowed · ' + report.audit.window.deny + ' denied (the ledger, including asks no answerer saw)'
        : '')
    + row('rejected by rule (last ' + report.approvals.hours + 'h)',
      (report.approvals.byRuleRejected || []).map((r) => r.rule + ' ×' + r.count).join(', ') || '(none — no escalation was rejected in this window)')
    + row('asked by rule (last ' + report.approvals.hours + 'h)',
      (report.approvals.byRuleAsked || []).map((r) => r.rule + ' ×' + r.count).join(', ') || '(none)')
    + row('approvals (lifetime)',
      report.approvals.allTime
        ? report.approvals.allTime.asked + ' asked · ' + report.approvals.allTime.approved + ' approved · '
          + report.approvals.allTime.rejected + ' rejected' + (report.approvals.allTime.since ? ' · since ' + report.approvals.allTime.since : '')
        : '')
    + row('settings file', report.config.file || '(patch only — no JSON file in use)')
    + row('last decision', report.audit.last)
    + row('bulk rules', report.rules.bulk.join(', '))
    + row('deny rules', report.rules.deny.join(', '))
    + row('scope rules', report.rules.scope.join(', '))
    + row('session line', report.surfaces.sessionLine)
    + row('approval dialog', report.surfaces.approvalDialog)
    + row('ledger', report.surfaces.ledger)
    + row('session events', report.surfaces.sessionEvents)
    + row('settings section', report.surfaces.settingsSection)
    + '</table>'
    + '<h2>Sessions this process has judged</h2><ul>' + (sessions || '<li>(none yet)</li>') + '</ul>'
    + '</body></html>';
}

export const name = 'dsh-guard-native';

/**
 * @param {object} ctx cordis context
 * @param {object} rawConfig loader-provided config
 */
/**
 * Optional file-based configuration: when the patch entry carries only `configFile`, the knobs
 * live in that JSON file. Inline config always wins over the file, so a user can keep the bulk of
 * the settings in JSON and still override one field in `cordis.patch.yml`. A missing, unreadable or
 * malformed file is reported through `notify` and otherwise ignored -- configuration convenience
 * must never be able to stop the gate from loading.
 */
export function readConfigFile(rawConfig, notify) {
  const explicit = rawConfig && typeof rawConfig.configFile === 'string' ? rawConfig.configFile : '';
  // A bundle patch lives INSIDE the package and must not carry machine-specific absolute paths, so
  // the row is inserted with an empty config and the file is discovered. apply() sets
  // APPLY_PROFILE_DIR (a `link:` install leaves the module in its checkout, so the module path alone
  // would point at the repository); the env var stays as the last fallback.
  const profileDir = APPLY_PROFILE_DIR || MODULE_PROFILE_DIR
    || (typeof process.env.DSH_PROFILE_DIR === 'string' ? process.env.DSH_PROFILE_DIR : '');
  const path = explicit || (profileDir ? profileDir.replace(/[\\/]+$/, '') + '\\dsh-guard.json' : '');
  if (path === '') return { fromFile: {}, problem: '', path: '' };
  if (!explicit && !exists(path)) return { fromFile: {}, problem: '', path };
  try {
    const text = fs.readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the JSON root is not an object');
    }
    return { fromFile: parsed, problem: '', path };
  } catch (error) {
    const problem = 'configFile ' + path + ' could not be used (' + String(error && error.message ? error.message : error) + '); falling back to the values in the patch entry';
    try { if (typeof notify === 'function') notify(problem); } catch { /* ignore */ }
    return { fromFile: {}, problem, path };
  }
}

export function apply(ctx, rawConfig) {
  // Resolve the profile ONCE per apply: config and the load receipt live there. A `link:` install
  // leaves this module in its source checkout, so `locateProfileDir` falls back to scanning the
  // profiles that declare this bundle (the host exports no profile path to plugins).
  APPLY_PROFILE_DIR = locateProfileDir(MODULE_PROFILE_DIR, MODULE_INSTALLED_IN_PROFILE,
    (process.env.USERPROFILE || process.env.HOME || '') + '\\.dsh');
  // The file (when used) is the base; the patch entry's own fields win field by field.
  const fileConfig = readConfigFile(rawConfig, (message) => {
    try { console.error('guard-native: ' + message); } catch { /* ignore */ }
  });
  const cfg = configOf({ ...fileConfig.fromFile, ...(rawConfig || {}) });
  const loadedAt = new Date().toISOString();
  // Which session workspaces has THIS process judged? Session id -> workspace, so an on-demand
  // report can show the live scope without holding a strong reference to any agent.
  const watchedSessions = new Map();
  // Live current directory per session (workingDirectory service). The header cwd is the origin;
  // this is where relative paths actually resolve.
  const watchedCwd = new Map();
  let workingDirectory = null;
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['workingDirectory'], (injected) => { workingDirectory = injected.workingDirectory; });
    }
  } catch { /* the service is optional: without it the header cwd remains the only root */ }
  const liveCwdOf = (agent) => {
    try {
      if (workingDirectory && agent && agent.session && typeof workingDirectory.get === 'function') {
        const cwd = workingDirectory.get(agent.session);
        if (typeof cwd === 'string' && cwd !== '') return cwd;
      }
    } catch { /* fall back to the origin */ }
    return '';
  };

  /**
   * The approval-outcome ring, loaded BEFORE the status surface is registered.
   *
   * Ordering is load-bearing: `ctx.inject` runs its callback synchronously when the web server is
   * already mounted, so `reportNow()` can be called during registration -- before a later `let` would
   * have initialized. That exact TDZ ("Cannot access 'outcomeRows' before initialization") showed up
   * as a silent `status injection failed` in the matrix.
   */
  let outcomeRows = [];
  try {
    if (cfg.outcomesFile && exists(cfg.outcomesFile)) {
      const parsed = JSON.parse(fs.readFileSync(cfg.outcomesFile, 'utf8'));
      if (parsed && Array.isArray(parsed.rows)) outcomeRows = parsed.rows.filter((r) => r && Number.isFinite(r.ts));
    }
  } catch { outcomeRows = []; }

  /** Assemble the report from live state. Never throws: a status surface must not fail loudly. */
  const reportNow = (requestHost) => {
    let auditText = '';
    try { if (exists(cfg.auditLog)) auditText = fs.readFileSync(cfg.auditLog, 'utf8'); } catch { auditText = ''; }
    const mode = cfg.enabled === false ? 'DISABLED-BY-CONFIG' : (cfg.gating === false ? 'SHADOW (not gating)' : 'active');
    return statusReport({
      cfg,
      mode,
      switches: activeSwitchesOf(cfg),
      audit: summarizeAudit(auditText),
      loadedAt,
      pid: process.pid,
      file: cfg.loadMarker ? (rawConfig && rawConfig.__file) || '' : '',
      sessions: [...watchedSessions.entries()].map(([id, workspace]) => ({ id, workspace, cwd: watchedCwd.get(id) || workspace })),
      approvals: summarizeApprovals(outcomeRows, Date.now(), 24),
      configPath: fileConfig.path || '',
      requestHost: requestHost || cfg.publicBaseUrl || '',
    });
  };

  // --- the on-demand status surface -----------------------------------------
  // Host-side only. A `settings.section` page would be a CLIENT slot, and a client contribution
  // must ship a built client bundle the host serves as /plugins/<package>/client.js; a loose
  // profile module cannot register one. The host web carrier therefore publishes the same
  // report at a local URL, which the desktop shell can reach and a human can bookmark.
  //
  // `ctx.inject([...], cb)` -- NOT a one-shot `ctx.get(...)` -- is the documented shape for an
  // OPTIONAL service: the callback runs when the carrier appears, so the plugin neither races
  // service readiness nor throws where no web server exists. The first attempt used a one-shot
  // get() inside try/catch, silently registered nothing, and the route answered 404 with no
  // trace anywhere. A registration failure is now recorded next to the load marker.
  const noteRouteProblem = (where, error) => {
    try {
      const target = cfg.loadMarker
        ? cfg.loadMarker.replace(/\.txt$/i, '') + '-status-route.txt'
        : (cfg.stateDir + '\\status-route.txt');
      fs.appendFileSync(target, new Date().toISOString() + ' ' + where + ': ' + String(error && error.message ? error.message : error) + '\n', 'utf8');
    } catch { /* diagnostics must never break the plugin */ }
  };
  const registerStatusRoute = (webCtx) => {
    // Host admission for both routes. `/dsh-guard/action` can create/remove emergency switches and
    // rewrite dsh-guard.json, and the status page reads the ledger and session summaries, so neither
    // may be reachable by an arbitrary local page. `connection.requestRejection` applies the Host /
    // Origin fence plus the signed browser session or API credential; a missing service fails closed.
    const rejectUnauthorized = (request, response) => {
      let rejection;
      try {
        let connection;
        if (webCtx && typeof webCtx.get === 'function') connection = webCtx.get('connection');
        if (!connection && ctx && typeof ctx.get === 'function') connection = ctx.get('connection');
        rejection = connection && typeof connection.requestRejection === 'function'
          ? connection.requestRejection(request)
          : 503;
      } catch {
        rejection = 503;
      }
      if (!rejection) return false;
      try {
        response.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end('dsh-guard: this route requires the running DSH host connection');
      } catch { /* a dropped response must not throw into the plugin */ }
      return true;
    };
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-guard/status',
        handler: (request, response) => {
          if (rejectUnauthorized(request, response)) return;
          const requestHost = String((request && request.headers && request.headers.host) || '');
          let report;
          try { report = reportNow(requestHost); } catch { report = statusReport({ cfg, mode: 'active', switches: activeSwitchesOf(cfg), audit: { total: 0, allow: 0, ask: 0, deny: 0, last: '' }, sessions: [], requestHost }); }
          const wantsJson = String(request && request.url ? request.url : '').includes('format=json');
          const body = wantsJson ? JSON.stringify(report, null, 2) : statusReportHtml(report);
          try {
            response.writeHead(200, { 'content-type': wantsJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            response.end(body);
          } catch { /* a dropped response must not throw into the plugin */ }
        },
      });
    } catch (error) {
      noteRouteProblem('register /dsh-guard/status', error);
    }
    // Two actions the settings section needs. Both are deliberately narrow:
    //   switch: create/remove an emergency switch file (immediate effect, no restart),
    //   config: merge an allow-listed subset into dsh-guard.json (most keys need a restart).
    try {
      webCtx.webServer.register({
        kind: 'exact',
        path: '/dsh-guard/action',
        handler: (request, response) => {
          if (rejectUnauthorized(request, response)) return;
          const send = (status, payload) => {
            try {
              response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              response.end(JSON.stringify(payload));
            } catch { /* a dropped response must not throw */ }
          };
          if (!request || String(request.method || 'GET').toUpperCase() !== 'POST') {
            send(405, { ok: false, error: 'POST only' });
            return;
          }
          let body = '';
          let tooBig = false;
          request.on('data', (chunk) => {
            body += chunk;
            if (body.length > 64 * 1024) { tooBig = true; try { request.destroy(); } catch { /* ignore */ } }
          });
          request.on('end', () => {
            if (tooBig) { send(413, { ok: false, error: 'body too large' }); return; }
            let payload;
            try { payload = JSON.parse(body || '{}'); } catch { send(400, { ok: false, error: 'body must be JSON' }); return; }
            const kind = String(payload.kind || '');
            try {
              if (kind === 'switch') {
                const name = String(payload.name || '');
                if (!['DISABLE', 'PANIC', 'HARD-STOP'].includes(name)) { send(400, { ok: false, error: 'unknown switch ' + name }); return; }
                const file = cfg.stateDir + '\\' + name;
                if (payload.on === true) {
                  if (!exists(cfg.stateDir)) fs.mkdirSync(cfg.stateDir, { recursive: true });
                  fs.writeFileSync(file, new Date().toISOString() + '\n', 'utf8');
                } else if (exists(file)) {
                  fs.rmSync(file, { force: true });
                }
                send(200, { ok: true, switches: activeSwitchesOf(cfg), note: 'switch changes take effect on the next tool call' });
                return;
              }
              if (kind === 'config') {
                const configPath = fileConfig.path || '';
                if (!configPath) { send(400, { ok: false, error: 'no config file in use: install with -UseConfigFile or a bundle row that discovers dsh-guard.json' }); return; }
                const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {};
                const allowed = ['enabled', 'gating', 'statusLine', 'askMode', 'rememberApproved', 'additionalRoots', 'extraGatedTools', 'protectedRoots', 'auditMaxBytes', 'auditKeep', 'outcomesKeep'];
                let current = {};
                try { current = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { current = {}; }
                const next = { ...current };
                for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
                fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
                // Keep the live copy honest for the keys that do not need a restart.
                if (Object.prototype.hasOwnProperty.call(patch, 'auditMaxBytes') && Number.isFinite(next.auditMaxBytes)) cfg.auditMaxBytes = next.auditMaxBytes;
                if (Object.prototype.hasOwnProperty.call(patch, 'auditKeep') && Number.isInteger(next.auditKeep)) cfg.auditKeep = next.auditKeep;
                send(200, { ok: true, path: configPath, restart: true, note: 'written; most keys take effect after a dsh restart' });
                return;
              }
              send(400, { ok: false, error: 'unknown kind ' + kind });
            } catch (error) {
              send(500, { ok: false, error: String(error && error.message ? error.message : error) });
            }
          });
        },
      });
    } catch (error) {
      noteRouteProblem('register /dsh-guard/action', error);
    }
  };
  try {
    if (ctx && typeof ctx.inject === 'function') ctx.inject(['webServer'], registerStatusRoute);
    else if (ctx && typeof ctx.get === 'function' && ctx.get('webServer')) registerStatusRoute({ webServer: ctx.get('webServer') });
  } catch (error) {
    noteRouteProblem('inject webServer', error);
  }

  // --- load receipt ---------------------------------------------------------
  // Written first, before anything that could throw, into a location the profile guarantees
  // is writable. Its mere existence answers "did the loader accept this entry?".
  const writeMarker = (extra) => {
    if (!cfg.loadMarker) return;
    try {
      const rows = [
        `loaded_at=${new Date().toISOString()}`,
        `pid=${process.pid}`,
        `node=${process.version}`,
        `gating=${cfg.gating === false ? 'off' : 'on'}`,
        `enabled=${cfg.enabled === false ? 'false' : 'true'}`,
        `stateDir=${cfg.stateDir}`,
        extra || '',
      ];
      // Keep the receipt bounded: it gained one block per apply() and had reached 12 blocks. The
      // newest `loadMarkerKeep - 1` existing blocks are preserved so "when did it last load?" still
      // spans the last few restarts.
      let prior = '';
      try { if (exists(cfg.loadMarker)) prior = fs.readFileSync(cfg.loadMarker, 'utf8'); } catch { prior = ''; }
      const blocks = prior.split(/\r?\n---\r?\n/).map((b) => b.trim()).filter((b) => b !== '');
      const kept = blocks.slice(Math.max(0, blocks.length - (cfg.loadMarkerKeep - 1)));
      const text = (kept.length ? kept.join('\n---\n') + '\n---\n' : '') + rows.filter(Boolean).join('\n') + '\n---\n';
      fs.writeFileSync(cfg.loadMarker, text, 'utf8');
    } catch { /* the marker must never break the plugin */ }
  };
  writeMarker('');

  // The status listener is registered in EVERY mode, including `enabled: false`: it is
  // read-only, it is how an install is confirmed from the panel, and a disable switch that
  // also hides its own state is worse than no switch.
  ctx.on('agent/created', ({ agent }) => {
    try {
      // Record the session workspace even in shadow/disabled mode: the report should show which
      // sessions this process has judged regardless of whether they were gated.
      const workspace = sessionWorkspaceOf(agent);
      if (agent && agent.id) {
        watchedSessions.set(String(agent.id), workspace || '(none exposed)');
        const cwd = liveCwdOf(agent);
        if (cwd) watchedCwd.set(String(agent.id), cwd);
      }
      if (cfg.statusLine === false || !agent || typeof agent.inject !== 'function') return;
      const mode = cfg.enabled === false ? 'DISABLED-BY-CONFIG' : (cfg.gating === false ? 'SHADOW (not gating)' : 'active');
      // Report the root this agent's calls are judged against, so a stale configured fallback
      // is visible at session start instead of surfacing as a surprise approval dialog.
      const report = reportNow();
      const audit = { total: report.audit.total, allow: report.audit.last200.allow, ask: report.audit.last200.ask, deny: report.audit.last200.deny, last: report.audit.last === 'none' ? '' : report.audit.last };
      const line = statusLine(cfg, mode, activeSwitchesOf(cfg), audit, workspace, liveCwdOf(agent));
      agent.inject({
        // `id` is load-bearing: without it the persisted user/message fails session
        // validation on the next resume and the whole session is declared corrupt.
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: line }],
        source: { kind: 'guard-native' },
      });
    } catch (error) {
      try { console.error('guard-native: status injection failed:', error && error.message ? error.message : error); } catch { /* ignore */ }
    }
  });

  if (cfg.enabled === false) {
    appendAudit(cfg, {
      ts: new Date().toISOString(),
      session: '', tool: 'guard-native', decision: 'load', rule: 'config-disabled', sandbox: '',
      reason: 'plugin apply() ran with enabled=false', preview: 'pid=' + process.pid,
    });
    return;
  }

  const probe = (p) => {
    try {
      const st = fs.statSync(p);
      const isDirectory = st.isDirectory();
      // The archive rule needs to know whether an existing destination already holds something; a
      // directory's emptiness is part of the probe so judgment stays pure and testable.
      return { exists: true, isDirectory, isEmpty: isDirectory ? fs.readdirSync(p).length === 0 : undefined };
    } catch { return undefined; }
  };

  const audit = (entry) => appendAudit(cfg, entry);

  // --- the approval-outcome ring (the 24h panel) ----------------------------
  // `approval/asked` and `approval/decided` are SESSION events, so a listener pairs them by approval
  // id — exact, unlike joining the ledger to session logs by timestamp (which is what the 0.2.0
  // precision analysis had to do by hand). The rows are loaded before the status surface and
  // persisted to a small file, so the panel still answers after a restart.
  const outcomeById = new Map(outcomeRows.filter((r) => r.id).map((r) => [r.id, r]));
  let outcomeTimer = null;
  const persistOutcomes = () => {
    if (!cfg.outcomesFile) return;
    try {
      if (!exists(cfg.stateDir)) fs.mkdirSync(cfg.stateDir, { recursive: true });
      fs.writeFileSync(cfg.outcomesFile, JSON.stringify({ version: 1, rows: outcomeRows.slice(-cfg.outcomesKeep) }), 'utf8');
    } catch { /* the panel must never break the plugin */ }
  };
  const rememberOutcome = (row) => {
    const existing = row.id ? outcomeById.get(row.id) : undefined;
    if (existing) {
      // A second `approval/asked` for the same id (hot reload, retry) must not overwrite a decision
      // that already arrived: it carries no outcome, so writing it would silently reset to pending.
      if (row.outcome === 'pending' && existing.outcome && existing.outcome !== 'pending') return;
      Object.assign(existing, row);
    }
    else {
      outcomeRows.push(row);
      if (row.id) outcomeById.set(row.id, row);
    }
    if (outcomeRows.length > cfg.outcomesKeep * 2) {
      outcomeRows = outcomeRows.slice(-cfg.outcomesKeep);
      outcomeById.clear();
      for (const r of outcomeRows) if (r.id) outcomeById.set(r.id, r);
    }
    if (outcomeTimer) return;
    outcomeTimer = setTimeout(() => { outcomeTimer = null; persistOutcomes(); }, 500);
    if (outcomeTimer && typeof outcomeTimer.unref === 'function') outcomeTimer.unref();
  };
  try {
    ctx.on('session/event', (_session, event) => {
      try {
        const type = event && event.type;
        const data = event && event.data;
        if (!data) return;
        if (type === 'approval/asked') {
          const reason = String(data.reason || '');
          // `includes`, not `startsWith`: PANIC mode prefixes the reason with "[PANIC MODE] ", and the
          // strict prefix check silently dropped exactly those escalations (81 of 243 measured).
          if (!reason.includes('dsh-guard')) return;   // only the guard's own escalations
          rememberOutcome({
            id: String(data.id || ''),
            ts: Number.isFinite(event.time) ? event.time : Date.now(),
            tool: String(data.toolName || ''),
            rules: rulesFromReason(reason),
            panic: /^\s*\[PANIC MODE\]/.test(reason),
            outcome: 'pending',
          });
        } else if (type === 'approval/decided') {
          const row = outcomeById.get(String(data.id || ''));
          if (!row) return;
          const at = Number.isFinite(event.time) ? event.time : Date.now();
          row.outcome = String(data.outcome || 'unknown');
          row.decidedTs = at;
          // A decision within 50 ms is not a human: this build fails closed when no answerer is
          // attached, so such an ask silently blocks. Keeping the latency lets the panel say so.
          if (Number.isFinite(row.ts)) row.latencyMs = at - row.ts;
          rememberOutcome(row);
        }
      } catch { /* observation must never break a turn */ }
    });
  } catch { /* a host without the event feed simply has no panel data */ }

  // Unconditional load marker: the one entry that answers "did the loader accept this entry?".
  // It is written whatever the gating mode, so an install can always be confirmed from disk.
  audit({
    ts: new Date().toISOString(),
    session: '',
    tool: 'guard-native',
    decision: 'load',
    rule: cfg.gating === false ? 'gating-off' : 'gating-on',
    sandbox: '',
    reason: 'plugin apply() ran',
    preview: 'pid=' + process.pid + ' node=' + process.version,
  });

  // Which tools the gate looks at. `plugin_manager` and every configured `extraGatedTools` entry are
  // included so a new mutating tool (run_code, str_replace_editor, …) can be covered without a
  // release; a tool that merely LOOKS mutating is recorded once per process as `untracked-tool`.
  const extraGated = cfg.extraGatedTools;
  const isGated = (tool) => tool === 'pwsh' || tool === 'write' || tool === 'edit' || tool === 'plugin_manager' || extraGated.includes(tool);
  const notedTools = new Set();
  const MUTATING_LOOKING = /(?:write|edit|patch|code|exec|shell|apply|replace|delete|remove)/i;

  // Opt-in approval memory. A key is only remembered AFTER the tool actually executed, observed
  // through `tools/post-execute` -- never on the strength of an `ask` alone, because the model may
  // retry a command the user rejected.
  const memory = new Map();       // key -> expiry epoch ms
  const pending = new Map();      // callId -> { key, expiresAt }
  const memoryKey = (tool, source, workspace) => tool + '\u0000' + source + '\u0000' + workspace;
  const memoryFresh = (key) => {
    const expiry = memory.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) { memory.delete(key); return false; }
    return true;
  };
  const ttlMs = () => cfg.rememberApproved.ttlSeconds * 1000;

  // --- the gate -------------------------------------------------------------
  // Waterfall: return a decision to stop the chain, or delegate with next().
  ctx.on('tools/pre-execute', async (exec, next) => {
    let toolName = '';
    let args = {};
    try {
      toolName = String(exec && exec.name ? exec.name : '');
      args = exec && exec.arguments && typeof exec.arguments === 'object' ? exec.arguments : {};
    } catch { /* fall through to next() */ }

    if (!isGated(toolName)) {
      try {
        if (toolName && MUTATING_LOOKING.test(toolName) && !notedTools.has(toolName)) {
          notedTools.add(toolName);
          appendAudit(cfg, {
            ts: new Date().toISOString(), session: '', callId: '', tool: toolName,
            decision: 'allow', rule: 'untracked-tool', sandbox: '',
            reason: 'no rule set gates this tool name; recorded once per process so upgrade drift is visible',
            preview: 'tool name suggests mutation but the guard has no rules for it',
          });
        }
      } catch { /* ignore */ }
      return next();
    }
    if (cfg.gating === false) return next();

    // The scope root comes from the live session, never from the constant alone: `exec.agent`
    // carries this session's immutable workspace root, which is what the human expects the
    // gate to compare against.
    const sessionWorkspace = sessionWorkspaceOf(exec && exec.agent);

    const rawSource = String(toolName === 'write' || toolName === 'edit'
      ? (args.file_path || '')
      : (args.command || args.file_path || args.path || args.target || ''));
    const callId = exec && exec.callId ? String(exec.callId) : '';
    const memKey = memoryKey(toolName, rawSource, sessionWorkspace);

    // A command approved AND executed within the TTL passes without a second dialog. Off by default.
    if (cfg.rememberApproved.enabled && sessionWorkspace !== '' && memoryFresh(memKey)) {
      appendAudit(cfg, {
        ts: new Date().toISOString(),
        session: exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '',
        callId, tool: toolName, decision: 'allow', rule: 'remembered-approval', sandbox: '',
        workspace: sessionWorkspace, workspaceSource: 'session',
        reason: 'the same command was approved and executed within ' + cfg.rememberApproved.ttlSeconds + 's',
        preview: rawSource.replace(/\s+/g, ' ').slice(0, 300),
      });
      return next();
    }

    let verdict;
    try {
      verdict = judge({
        toolName,
        command: typeof args.command === 'string' ? args.command : '',
        filePath: typeof args.file_path === 'string' ? args.file_path : '',
        extraGatedTools: extraGated,
        extraToolPath: String(args.file_path || args.path || args.target || args.destination || ''),
        pluginAction: String(args.action || ''),
        pluginTarget: String(args.package || args.bundle || args.target || args.name || ''),
        additionalRoots: cfg.additionalRoots,
        sandboxPermissions: args.sandbox_permissions,
        sessionWorkspace,
        // The CURRENT directory (workingDirectory service) when it is known: relative targets resolve
        // there, while the permission root stays the header cwd.
        sessionCwd: liveCwdOf(exec && exec.agent) || sessionWorkspace,
        workspace: cfg.workspace,
        dshHome: cfg.dshHome,
        stateDir: cfg.stateDir,
        protectedRoots: cfg.protectedRoots,
        panic: exists(cfg.stateDir + '\\PANIC'),
        disable: exists(cfg.stateDir + '\\DISABLE'),
        hardStop: exists(cfg.stateDir + '\\HARD-STOP'),
        readPath: probe,
      });
    } catch (error) {
      // Fail closed: a gate that cannot judge must not silently pass.
      const fallbackScope = { workspace: sessionWorkspace || cfg.workspace || '', workspaceSource: sessionWorkspace ? 'session' : 'config-fallback' };
      const fallbackSummary = actionSummaryOf(typeof args.command === 'string' ? args.command : '', { workspace: fallbackScope.workspace, source: fallbackScope.workspaceSource }, [fallbackScope.workspace, cfg.dshHome, cfg.stateDir].filter(Boolean), probe, ['judge-failed']);
      verdict = {
        decision: 'ask',
        rules: ['judge-failed'],
        action: fallbackSummary,
        workspace: fallbackScope.workspace,
        workspaceSource: fallbackScope.workspaceSource,
        reason: 'dsh-guard ASK [judge-failed]: dsh-guard could not evaluate this call (' + String(error && error.message ? error.message : error) + ')\n'
          + '  - 摘要: 守卫本身没能判定这次调用（' + String(error && error.message ? error.message : error) + '）\n'
          + '  - decision: the gate could not judge, so it fails closed; approve only if you understand the pending action.'
          + scopeLine(fallbackScope),
      };
    }

    // With `askMode: "deny"` an escalation is refused with the SAME reason instead of asking. This is
    // for installations where approvals are disabled: there an ask is auto-rejected in milliseconds
    // and the model reads an approval error rather than a clear "this was blocked".
    if (verdict.decision === 'ask' && cfg.askMode === 'deny') {
      const reason = String(verdict.reason || '').replace(/^dsh-guard ASK/, 'dsh-guard DENY')
        + '\n  - askMode=deny: this installation has no approval answerer, so the escalation is a hard block.';
      verdict = { ...verdict, decision: 'deny', reason };
    }

    const source = rawSource || String(args.command || '');
    const action = verdict.action || null;
    audit({
      ts: new Date().toISOString(),
      session: exec && exec.agent && exec.agent.id ? String(exec.agent.id) : '',
      // `callId` is what lets a tool-side join (`approval/asked` / `approval/decided`) answer "was this
      // escalation approved or rejected?" without guessing by timestamp. Precision measurement needs it.
      callId: exec && exec.callId ? String(exec.callId) : '',
      tool: toolName,
      decision: verdict.decision,
      // Classification first, patterns second: a reader of the ledger can group by
      // `action`/`scope`/`mass` without re-parsing the human-facing reason.
      action: action ? action.analysis.action : '',
      mass: action ? action.analysis.mass : false,
      scope: action ? (action.scope.externalPaths.length > 0 ? 'outside' : 'inside') : '',
      summary: action ? action.zh : '',
      // `rule` stays the single rollup string, kept for older readers of this ledger.
      rule: verdict.rules.join(', '),
      rules: verdict.rules,
      workspace: verdict.workspace || '',
      workspaceSource: verdict.workspaceSource || '',
      // The live current directory at judgment time (empty when the service is unavailable).
      cwd: verdict.cwd || '',
      externalTargets: action ? action.scope.externalPaths : [],
      sandbox: typeof args.sandbox_permissions === 'string' ? args.sandbox_permissions : '',
      // The model's own one-sentence reason for wanting the sandbox gone is part of the record:
      // the dialog shows the guard's facts, and the ledger keeps the requester's claim beside it.
      justification: typeof args.justification === 'string' ? args.justification.slice(0, 300) : '',
      reason: verdict.reason,
      preview: source.replace(/\s+/g, ' ').slice(0, 300),
    });

    if (verdict.decision === 'deny') return { kind: 'deny', reason: verdict.reason };
    if (verdict.decision === 'ask') {
      // Remember the command ONLY as "pending": `tools/post-execute` promotes it once the tool has
      // actually run, i.e. once the human approved. A rejected retry therefore still asks.
      if (cfg.rememberApproved.enabled && sessionWorkspace !== '' && callId !== ''
        && action && action.analysis.mass === true && action.scope.externalPaths.length === 0) {
        pending.set(callId, { key: memKey, expiresAt: Date.now() + ttlMs() });
      }
      // The dialog headline is ONE sentence: what the action does + where it lands. The rule
      // ids stay in the full reason so the evidence is still there when it is wanted.
      const ids = verdict.rules.join(', ');
      return {
        kind: 'ask',
        reason: verdict.reason,
        displayReason: {
          en: 'dsh-guard: ' + (action ? action.en : 'this call needs approval') + ' -- [' + ids + ']',
          zh: 'dsh-guard：' + (action ? action.zh : '这次调用需要确认') + ' —— [' + ids + ']',
        },
      };
    }
    return next();
  });

  // Observe the SETTLEMENT, not the question: a tool that runs after an approval promotes its
  // command into the approval memory. `next()` is always called first so this listener cannot alter
  // any downstream decision.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    try {
      const id = exec && exec.callId ? String(exec.callId) : '';
      if (id && pending.has(id)) {
        const entry = pending.get(id);
        pending.delete(id);
        if (Date.now() <= entry.expiresAt) memory.set(entry.key, Date.now() + ttlMs());
      }
    } catch { /* observation must never break the chain */ }
    return next();
  });
}

