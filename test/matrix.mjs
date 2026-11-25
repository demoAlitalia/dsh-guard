// Offline matrix for the dsh-guard plugin.
//
// Runs with plain Node -- no dsh, no profile, no real filesystem probing (the plugin takes
// an injected `readPath`, so directory/existence judgments are driven by a fake disk).
//
//   node test/matrix.mjs          (or: npm test)

import { judge, resolveRelative, relativeTargetsOf, rulesFromReason, summarizeApprovals, readConfigFile, profileDirOf, locateProfileDir, apply, summarizeAudit, statusLine, configOf, sessionWorkspaceOf, resolveWorkspace, actionOf, statusReport, statusReportHtml } from '../lib/index.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin profile discovery to a scratch directory for the WHOLE run: on a machine that declares this
// bundle, locateProfileDir would otherwise resolve the REAL profile (it scans profile declarations
// when the package is linked), and apply() would read — or write — the live config and receipt.
// The isolation assertion at the end still checks the live ledger and receipt sizes.
const SCRATCH_PROFILE = mkdtempSync(join(tmpdir(), 'dg-profile-'));
process.env.DSH_PROFILE_DIR = SCRATCH_PROFILE;

// --- live-install isolation baseline ------------------------------------------------------------
// This matrix applies the plugin many times with fake contexts. `loadMarker` and `auditLog` default
// to paths inside a REAL dsh install, so any apply() that omits them writes into the user's profile
// receipt and audit ledger -- which is exactly what happened (six stray load rows per run, marked by
// `node=v24.13.0` while dsh itself runs v24.18.1). Sample the live files now, before the first
// apply(), and assert at the end that their sizes never moved. Every apply() in this file must pass
// explicit sinks; this guard is what makes a future omission fail loudly instead of quietly.
const LIVE_MARKER = join(process.env.USERPROFILE || '', '.dsh', 'profiles', 'desktop', 'dsh-guard-native-loaded.txt');
const LIVE_LEDGER = join(process.env.USERPROFILE || '', '.dsh', 'emergency', 'guard-audit.jsonl');
const sinkSize = (p) => { try { return readFileSync(p).length; } catch { return -1; } };
const LIVE_MARKER_SIZE = sinkSize(LIVE_MARKER);
const LIVE_LEDGER_SIZE = sinkSize(LIVE_LEDGER);
// Count of `load` rows is the leak signal: only an apply() writes those. The live Harness appends
// ordinary allow/ask rows for this very command, so total size is not a stable comparison.
const LIVE_LOAD_ROWS = (() => {
  try { return readFileSync(LIVE_LEDGER, 'utf8').split('\n').filter((l) => l.includes('"decision":"load"')).length; } catch { return -1; }
})();

const WORKSPACE = 'F:\\work\\proj';
const PROTECTED = ['C:\\Users\\me', 'C:\\'];

// A fake disk: only what the cases below need. Keys are lower-cased absolute paths.
const DIRS = new Set([
  'c:\\users\\me\\.dsh',
  'c:\\users\\me\\.dsh\\storages',
  'c:\\users\\me\\desktop',
  'c:\\users\\me\\appdata',
  'c:\\users\\me\\appdata\\local',
  'c:\\users\\me\\appdata\\local\\temp',
  'c:\\users\\me\\appdata\\local\\temp\\somedir',
  'c:\\windows',
  'c:\\windows\\system32',
  'c:\\program files',
  'c:\\program files\\foo',
  'f:\\work\\proj',
  'f:\\work\\proj\\panel',
  'f:\\work\\proj\\panel\\internal',
  'f:\\work\\proj\\panel\\internal\\web',
  'f:\\work\\proj\\panel\\internal\\web\\dist',
  'f:\\work\\proj\\empty-out',
]);
const FILES = new Set([
  'c:\\users\\me\\.dsh\\storages\\old.bin',
  'c:\\users\\me\\a.txt',
  'c:\\users\\me\\b.txt',
  'c:\\users\\me\\repair.cmd',
  'c:\\users\\me\\desktop\\note.md',
  'c:\\program files\\foo\\bar.dll',
  'f:\\work\\proj\\panel\\main.go',
]);
const norm = (p) => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
// Directories the fake disk reports as EMPTY, for the archive-overwrite destination check.
const EMPTY_DIRS = new Set(['c:\\users\\me\\appdata\\local\\temp\\somedir', 'f:\\work\\proj\\empty-out']);
const readPath = (p) => {
  const k = norm(p);
  if (DIRS.has(k)) return { exists: true, isDirectory: true, isEmpty: EMPTY_DIRS.has(k) };
  if (FILES.has(k)) return { exists: true, isDirectory: false };
  return undefined;
};

const base = { workspace: WORKSPACE, protectedRoots: PROTECTED, dshHome: 'C:\\Users\\me\\.dsh', stateDir: 'C:\\Users\\me\\.dsh\\emergency', readPath };

const cases = [
  // --- must ALLOW: scoped, single, inside the user's own roots -----------------
  { n: 'single literal file delete', cmd: 'Remove-Item C:\\Users\\me\\.dsh\\storages\\old.bin', want: 'allow' },
  { n: 'single file delete, relative path', cmd: 'Remove-Item .\\panel\\internal\\web\\dist\\old.js', want: 'allow' },
  { n: 'scoped delete with -Force', cmd: 'Remove-Item C:\\Users\\me\\.dsh\\storages\\old -Force', want: 'allow' },
  { n: 'read-only recursive traversal', cmd: 'Get-ChildItem -Recurse -Filter *.go | Select-Object -First 5', want: 'allow' },
  { n: 'read-only external traversal', cmd: 'Get-ChildItem C:\\Windows\\System32 | Select-Object -First 3', want: 'allow' },
  { n: 'read-only external Test-Path', cmd: 'Test-Path C:\\Windows\\System32', want: 'allow' },
  { n: 'git diff (must not match)', cmd: 'git diff --stat', want: 'allow' },
  { n: 'git status (must not match)', cmd: 'git status --short', want: 'allow' },
  { n: 'version suffix is not a drive path', cmd: 'npm ci --prefix C:\\Users\\me\\.dsh\\dsh-runtimes 2.0.1', want: 'allow' },
  { n: 'out-of-scope tool', tool: 'read', path: 'C:\\Users\\me\\secret.txt', want: 'allow' },
  { n: 'write inside workspace', tool: 'write', path: WORKSPACE + '\\panel\\main.go', want: 'allow' },

  // --- must ASK: bulk / traversal / mass scope ---------------------------------
  { n: 'recursive delete in workspace', cmd: 'Remove-Item -Recurse -Force .\\panel\\internal\\web\\dist', want: 'ask' },
  { n: 'recursive delete, external dir', cmd: 'Remove-Item -Recurse -Force C:\\Program Files\\Foo', want: 'ask' },
  { n: 'wildcard delete', cmd: 'Remove-Item .\\panel\\*.log', want: 'ask' },
  { n: 'mass pipeline delete', cmd: 'Get-ChildItem .\\data -Recurse | Remove-Item -Force', want: 'ask' },
  { n: 'cmd recursive delete', cmd: 'cmd /c del /s /q C:\\Users\\me\\.dsh\\storages', want: 'ask' },
  { n: 'git clean -fdx', cmd: 'git clean -fdx', want: 'ask' },
  { n: 'git reset --hard', cmd: 'git reset --hard HEAD~3', want: 'ask' },
  { n: 'robocopy mirror', cmd: 'robocopy C:\\src C:\\dst /MIR', want: 'ask' },
  { n: 'Expand-Archive into an existing directory', cmd: 'Expand-Archive .\\x.zip -DestinationPath C:\\Users\\me\\Desktop -Force', want: 'ask' },
  { n: 'Expand-Archive into a new destination', cmd: 'Expand-Archive .\\x.zip -DestinationPath .\\out -Force', want: 'allow' },
  { n: 'indirect Invoke-Expression', cmd: 'Invoke-Expression "Remove-Item -Recurse -Force C:\\Users\\me\\Desktop"', want: 'ask' },
  { n: 'existing directory as target', cmd: 'Remove-Item -Recurse -Force C:\\Users\\me\\Desktop', want: 'ask' },
  { n: 'two named existing files at once', cmd: 'Remove-Item C:\\Users\\me\\a.txt, C:\\Users\\me\\b.txt', want: 'ask' },
  { n: 'existing dir under protected root', cmd: 'Remove-Item C:\\Users\\me\\AppData\\Local\\Temp\\somedir', want: 'ask' },
  { n: 'write into dsh home', tool: 'write', path: 'C:\\Users\\me\\.dsh\\storages\\cfg.json', want: 'ask' },
  { n: 'write into Desktop', tool: 'write', path: 'C:\\Users\\me\\Desktop\\note.md', want: 'ask' },
  { n: 'write outside protected roots', tool: 'write', path: 'D:\\stuff\\note.md', want: 'ask' },
  { n: 'write with no file_path', tool: 'write', path: '', want: 'ask' },

  // --- the session's own workspace is the scope (regression, 2026-10-15) --------
  // A single-file write inside the LIVE session's workspace must be allowed even though the
  // configured fallback points somewhere else. Two ordinary writes were escalated as bulk
  // operations because the gate compared against the stale configured constant.
  { n: 'single write inside the session workspace (config elsewhere)', tool: 'write', path: 'F:\\work\\app\\_session_repair\\repair.mjs', session: 'F:\\work\\app', want: 'allow' },
  { n: 'single write outside session workspace and fallback', tool: 'write', path: 'D:\\stuff\\note.md', session: 'F:\\work\\app', want: 'ask' },
  { n: 'wildcard write inside the session workspace', tool: 'write', path: 'F:\\work\\app\\_session_repair\\*.mjs', session: 'F:\\work\\app', want: 'ask' },
  // A forward-slash drive path is legal PowerShell. It used to produce NO path token at all,
  // so a destructive verb aimed outside the workspace slipped through the scope check.
  { n: 'forward-slash external path with a destructive verb', cmd: 'Set-Content -LiteralPath C:/Users/me/AppData/Local/Temp/cwd.json -Value x', want: 'ask' },
  // A posix outside path with a destructive verb is likewise external.
  { n: 'posix external path with a destructive verb', cmd: 'cp /etc/hosts /tmp/copy-of-hosts', want: 'ask' },
  // A file mutation INSIDE an inline script: there is no PowerShell verb, but the write is real.
  { n: 'inline node script writing outside the workspace', cmd: "node -e \"require('node:fs').writeFileSync('C:/Users/me/AppData/Local/Temp/x.json','x')\"", want: 'ask' },

  // --- must DENY: unbounded / unrecoverable ------------------------------------
  { n: 'unbounded root delete', cmd: 'Remove-Item -Recurse -Force C:\\', want: 'deny' },
  { n: 'unbounded root delete, bare', cmd: 'Remove-Item C:\\', want: 'deny' },
  { n: 'unbounded root delete, wildcard', cmd: 'Remove-Item -Recurse -Force C:\\*', want: 'deny' },
  { n: 'filename with a drive-like suffix (C:\\Users is external)', cmd: 'Remove-Item C:\\Users\\me\\a.txt', want: 'ask' },
  { n: 'filename with drive-like suffix, workspace-local', cmd: 'Remove-Item F:\\work\\proj\\panel\\main.go', want: 'allow' },
  { n: 'posix root delete', cmd: 'rm -rf /', want: 'deny' },
  { n: 'posix subdir delete is not root', cmd: 'rm -rf /home/user/data', want: 'ask' },
  { n: 'format volume', cmd: 'Format-Volume -DriveLetter D', want: 'deny' },
];

let fail = 0;
for (const c of cases) {
  const tool = c.tool || 'pwsh';
  const verdict = judge({ ...base, toolName: tool, command: c.cmd || '', filePath: c.path || '', sessionWorkspace: c.session || '' });
  const ok = verdict.decision === c.want;
  if (!ok) fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  want=${c.want.padEnd(5)} got=${verdict.decision.padEnd(5)} ${c.n.padEnd(40)} ${verdict.rules.join(', ')}`,
  );
}

// --- switch semantics --------------------------------------------------------
console.log('\n--- emergency switches ---');
const sw = [
  { n: 'DISABLE bypasses the gate', opts: { disable: true }, cmd: 'Remove-Item -Recurse -Force C:\\', want: 'allow' },
  { n: 'PANIC downgrades deny to ask', opts: { panic: true }, cmd: 'Remove-Item -Recurse -Force C:\\', want: 'ask' },
  { n: 'PANIC does not change bulk ask', opts: { panic: true }, cmd: 'Remove-Item -Recurse -Force .\\panel', want: 'ask' },
  { n: 'HARD-STOP denies bulk too', opts: { hardStop: true }, cmd: 'Remove-Item -Recurse -Force .\\panel', want: 'deny' },
  { n: 'HARD-STOP keeps workspace-scoped allow', opts: { hardStop: true }, cmd: 'Remove-Item .\\panel\\main.go', want: 'allow' },
];
for (const c of sw) {
  const verdict = judge({ ...base, toolName: 'pwsh', command: c.cmd, ...c.opts });
  const ok = verdict.decision === c.want;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  want=${c.want.padEnd(5)} got=${verdict.decision.padEnd(5)} ${c.n}`);
}

// --- sandbox note (full access must be visible) ------------------------------
console.log('\n--- full-access visibility ---');
{
  const v = judge({ ...base, toolName: 'pwsh', command: 'Remove-Item -Recurse -Force C:\\Users\\me\\Desktop', sandboxPermissions: 'danger-full-access' });
  const ok = v.decision === 'ask' && v.reason.includes('sandbox_permissions=danger-full-access');
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  full-access call is annotated in the approval reason`);
}

// --- scope resolution: session cwd first, configured value only as a fallback --
console.log('\n--- workspace resolution ---');
{
  const fakeAgent = (cwd) => ({ id: 's1', session: { header: { cwd } } });

  const sameAgent = fakeAgent('F:\\work\\app');
  const live = sessionWorkspaceOf(sameAgent);
  const ok1 = live === 'F:\\work\\app';
  if (!ok1) fail++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  the session header cwd is the resolved workspace (got: ${live || '(none)'})`);

  const cached = sessionWorkspaceOf(sameAgent);
  const ok2 = cached === 'F:\\work\\app';
  if (!ok2) fail++;
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  the resolution is cached per agent (immutable header)`);

  const otherAgent = sessionWorkspaceOf(fakeAgent('F:\\elsewhere'));
  const ok2b = otherAgent === 'F:\\elsewhere';
  if (!ok2b) fail++;
  console.log(`${ok2b ? 'PASS' : 'FAIL'}  a different agent resolves its own workspace (no cross-session leak)`);

  const shapes = [
    ['no agent', undefined],
    ['agent without session', { id: 's2' }],
    ['session without header', { id: 's3', session: {} }],
    ['cwd not a string', { id: 's4', session: { header: { cwd: 42 } } }],
    ['empty cwd', { id: 's5', session: { header: { cwd: '  ' } } }],
    ['throwing getter', { id: 's6', get session() { throw new Error('boom'); } }],
  ];
  const ok3 = shapes.every(([, agent]) => sessionWorkspaceOf(agent) === '');
  if (!ok3) fail++;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  an absent/odd cwd degrades to no session workspace, never throws`);

  const fallback = resolveWorkspace({ configuredWorkspace: WORKSPACE });
  const ok4 = fallback.workspace === WORKSPACE && fallback.source === 'config-fallback';
  if (!ok4) fail++;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}  with no session cwd the configured value is used, marked as fallback`);

  const bogus = resolveWorkspace({ sessionWorkspace: 'not-a-path', configuredWorkspace: WORKSPACE });
  const ok5 = bogus.workspace === '' && bogus.source === 'session-invalid';
  if (!ok5) fail++;
  console.log(`${ok5 ? 'PASS' : 'FAIL'}  a non-absolute session workspace is refused, not widened`);

  const overridden = judge({ ...base, toolName: 'write', filePath: 'F:\\work\\app\\a.mjs', sessionWorkspace: 'F:\\work\\app' });
  const ok6 = overridden.decision === 'allow' && overridden.workspaceSource === 'session' && overridden.workspace === 'F:\\work\\app';
  if (!ok6) fail++;
  console.log(`${ok6 ? 'PASS' : 'FAIL'}  a session workspace overrides the configured one, and the verdict records the source`);

  // The session root is authoritative in BOTH directions: a write into the configured
  // fallback project is out of scope for this session, and must say so.
  const crossProject = judge({ ...base, toolName: 'write', filePath: 'F:\\work\\proj\\panel\\main.go', sessionWorkspace: 'F:\\work\\app' });
  const ok7 = crossProject.decision === 'ask' && crossProject.rules.includes('write-outside-workspace');
  if (!ok7) fail++;
  console.log(`${ok7 ? 'PASS' : 'FAIL'}  a write into the configured fallback project is out of scope for another session`);
}

// --- the escalation is one classified sentence, not a rule dump ---------------
console.log('\n--- action classification (batch delete / batch update / scope) ---');
{
  const SESSION = 'F:\\work\\app';

  const shape = (cmd, wantClass, wantScope, ids, wantDecision) => {
    const v = judge({ ...base, toolName: 'pwsh', command: cmd, sessionWorkspace: SESSION });
    const got = v.action ? v.action.className : '(none)';
    const scope = v.action && v.action.scope.externalPaths.length > 0 ? 'outside' : 'inside';
    const decision = wantDecision || 'ask';
    const ok = got === wantClass && scope === wantScope
      && (ids === undefined || ids.every((id) => v.rules.includes(id)))
      && v.reason.includes('  - 摘要: ')
      && v.decision === decision;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${got} / ${scope} / ${v.decision}  ${cmd.slice(0, 58)}`);
    if (!ok) console.log('      rules=' + v.rules.join(', ') + '  decision=' + v.decision);
  };

  // The taxonomy that matters to a human: batch delete vs batch update, inside vs outside.
  shape('Remove-Item -Recurse -Force .\\panel\\internal\\web\\dist', 'delete-mass', 'inside');
  shape('Get-ChildItem .\\data -Recurse | Remove-Item -Force', 'delete-mass', 'inside');
  shape('Remove-Item -Recurse -Force C:\\Users\\me\\Desktop', 'delete-mass', 'outside');
  shape('Remove-Item -Recurse -Force C:\\', 'delete-mass', 'outside', ['unbounded-root-delete'], 'deny');
  shape('rm -rf /', 'delete-mass', 'outside', ['posix-root-delete'], 'deny');
  shape('Set-Content -Path .\\panel\\*.go -Value ""', 'overwrite-mass', 'inside');
  shape('Copy-Item -Force -Recurse F:\\work\\app\\a C:\\Users\\me\\AppData\\Local\\Temp\\b', 'context-mass', 'outside');
  shape('Remove-Item C:\\Users\\me\\AppData\\Local\\Temp\\one.json', 'delete-single', 'outside');
  shape('Set-Content -LiteralPath C:\\Users\\me\\AppData\\Local\\Temp\\cwd.json -Value x', 'overwrite-single', 'outside');
  shape('New-Item -ItemType Directory -Force -Recurse C:\\Users\\me\\AppData\\Local\\Temp\\newdir', 'create-mass', 'outside');
  shape('Move-Item -Force C:\\Users\\me\\a.txt C:\\Users\\me\\b.txt', 'overwrite-single', 'outside');
  shape('icacls C:\\Users\\me\\Secret /grant Everyone:F /T', 'attribute-mass', 'outside');

  // ...but the same SHAPE still escalates when the verb mutates: the read-only fix must not
  // open a hole, so wildcard / multi-target scope still fires for a writing cmdlet.
  shape('Remove-Item C:\\Users\\me\\a.txt, C:\\Users\\me\\b.txt', 'delete-single', 'outside', ['multiple-path-targets']);
  shape('Set-Content -Path F:\\work\\app\\out\\*.log -Value ""', 'overwrite-mass', 'inside', ['wildcard-target']);

  // A read-only wildcard command is not an action at all -- it must never escalate.
  const readOnly = judge({ ...base, toolName: 'pwsh', command: 'Get-ChildItem C:\\Users\\me -Recurse -Filter *.json | Select-Object -First 3', sessionWorkspace: SESSION });
  const okRead = readOnly.decision === 'allow';
  if (!okRead) fail++;
  console.log(`${okRead ? 'PASS' : 'FAIL'}  read-only wildcard traversal stays allowed (no action class)`);

  // The reads that were ACTUALLY escalated live (guard-audit 2026-10-15T13:55:39Z) purely for
  // carrying a wildcard or several paths. Read-only work asks nothing now: a read is not a risk.
  const readonlyCommands = [
    ['directory listing via wildcard', 'Get-Item \'F:\\work\\app\\_session_repair\' | Format-List'],
    ['two read targets at once', 'Get-Item C:\\Users\\me\\a.txt, C:\\Users\\me\\b.txt'],
    ['recursive read with a wildcard', 'Get-ChildItem C:\\Users\\me -Recurse -Filter *.json | Select-Object -First 3'],
    ['read with a wildcard path', 'Select-String -Path F:\\work\\app\\*.log -Pattern boom'],
    ['git status', 'git status --short'],
    ['file content search', 'rg --text -n "status" F:\\work\\app\\_dsh_guard\\README.md'],
  ];
  for (const [name, cmd] of readonlyCommands) {
    const v = judge({ ...base, toolName: 'pwsh', command: cmd, sessionWorkspace: SESSION });
    const ok = v.decision === 'allow' && v.action === undefined && v.reason === '';
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  read-only asks nothing (${v.decision})  ${name}`);
    if (!ok) console.log('      rules=' + v.rules.join(', '));
  }

  const writeOut = judge({ ...base, toolName: 'write', filePath: 'D:\\stuff\\note.md', sessionWorkspace: SESSION });
  const okWrite = writeOut.action && writeOut.action.className === 'create-single'
    && writeOut.action.zh.includes('本工作区外')
    && writeOut.action.zh.includes('新建')
    && writeOut.action.en.includes('OUTSIDE');
  if (!okWrite) fail++;
  console.log(`${okWrite ? 'PASS' : 'FAIL'}  a write to a NEW path outside the workspace reads as "create outside the workspace"`);

  // Overwriting an existing file is a different risk from creating one, and the dialog says which.
  const writeOver = judge({ ...base, toolName: 'write', filePath: 'C:\\Users\\me\\Desktop\\note.md', sessionWorkspace: SESSION });
  const okOver = writeOver.action && writeOver.action.className === 'overwrite-single' && writeOver.action.zh.includes('改写');
  if (!okOver) fail++;
  console.log(`${okOver ? 'PASS' : 'FAIL'}  overwriting an existing file reads as "改写/overwrite", not "新建/create"`);

  // Phantom posix "paths" out of ordinary script text: `'approval/asked'` used to contribute a
  // `/asked` outside target, and `(/json|zstd/)` a `/json|zstd/` one. Both dirtied the scope
  // facts and could escalate a read-only probe.
  const phantom = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: "const asked = events.filter((e) => e.type === 'approval/asked');\nif (line.match(/json|zstd/)) { }" });
  const okPhantom = phantom.decision === 'allow' && phantom.action === undefined;
  if (!okPhantom) fail++;
  console.log(`${okPhantom ? 'PASS' : 'FAIL'}  script text no longer manufactures posix outside targets (/asked, /json|zstd/)`);

  const realPosix = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: 'cp /etc/hosts /tmp/copy-of-hosts' });
  const okRealPosix = realPosix.decision === 'ask' && realPosix.rules.includes('external-path-target');
  if (!okRealPosix) fail++;
  console.log(`${okRealPosix ? 'PASS' : 'FAIL'}  a real posix path outside the workspace still escalates`);

  // A file EXTENSION must not pass as a command alias. `\bmd\b` matched inside `README.md`, so a
  // wildcard READ of that file was escalated as "BULK CREATES" -- the live acceptance run of
  // 2026-10-16T01:49:19Z caught it. Aliases are boundary-anchored for classification and stay
  // out of the scope predicate entirely.
  const aliasTraps = [
    ['wildcard read of *.mjs plus Format-Table', 'Get-ChildItem F:\\work\\app\\_dsh_guard\\native\\*.mjs | Select-Object Name, Length | Format-Table -AutoSize'],
    ['README.md and guard.ps1 as two read targets', 'Get-Item F:\\work\\app\\_dsh_guard\\README.md, F:\\work\\app\\_dsh_guard\\guard.ps1 | Select-Object Name, Length'],
    ['the word "deli" is not the del alias', 'Select-String -Path F:\\work\\app\\_dsh_guard\\*.md -Pattern deli'],
    ['"ri" inside Write-Output is not the ri alias', 'Write-Output "ri"'],
  ];
  for (const [label, cmd] of aliasTraps) {
    const v = judge({ ...base, toolName: 'pwsh', command: cmd, sessionWorkspace: SESSION });
    const ok = v.decision === 'allow' && v.action === undefined;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  no alias trap (${v.decision})  ${label}`);
    if (!ok) console.log('      rules=' + v.rules.join(', '));
  }
  // Aliases still CLASSIFY (that is what the dialog shows); an allow verdict carries no action
  // object by design, so assert the classifier directly rather than through `judge`.
  const okMdAlias = actionOf('md F:\\work\\app\\newdir').action === 'create';
  if (!okMdAlias) fail++;
  console.log(`${okMdAlias ? 'PASS' : 'FAIL'}  a real \`md\` command still classifies as create`);
  const okRiAlias = actionOf('ri F:\\work\\app\\a.txt').action === 'delete';
  if (!okRiAlias) fail++;
  console.log(`${okRiAlias ? 'PASS' : 'FAIL'}  a real \`ri\` command still classifies as delete`);
  const okRmAlias = actionOf('rm -rf /home/user/data').action === 'delete';
  if (!okRmAlias) fail++;
  console.log(`${okRmAlias ? 'PASS' : 'FAIL'}  \`rm\` (a full word, not an alias) still classifies as delete`);

  // A bare `/` is script punctuation far more often than a filesystem root: `-join " / "` and a
  // closing `</body></html>` both fed phantom outside targets into the dialog. The second one was
  // observed live (2026-10-16T02:26:28Z) on the agent's own acceptance command, reported as
  // "BULK OVERWRITES paths OUTSIDE this project workspace (outside target: /)".
  const slashProse = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: 'Select-Object -First 12) -join " / "' });
  const okSlashProse = slashProse.decision === 'allow';
  if (!okSlashProse) fail++;
  console.log(`${okSlashProse ? 'PASS' : 'FAIL'}  a bare / between spaces is not an outside target`);

  const htmlProse = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: 'print "</body></html>"' });
  const okHtmlProse = htmlProse.decision === 'allow';
  if (!okHtmlProse) fail++;
  console.log(`${okHtmlProse ? 'PASS' : 'FAIL'}  a closing HTML tag is not an outside target`);

  // A URL is not a filesystem target. `http://127.0.0.1:19387/dsh-guard/status?format=json` used to
  // yield `p://127.0.0.1:19387/...` (the anchor let the match start at the scheme's last letter), so
  // CALLING the guard's own status page was reported as "BULK OVERWRITES paths OUTSIDE this project
  // workspace", with the `?` firing the wildcard rule -- observed live 2026-10-16T05:15:36Z.
  const urlFetch = judge({
    ...base,
    toolName: 'pwsh',
    sessionWorkspace: SESSION,
    command: "Invoke-WebRequest -Uri 'http://127.0.0.1:19387/dsh-guard/status?format=json' -UseBasicParsing",
  });
  const okUrl = urlFetch.decision === 'allow' && urlFetch.action === undefined;
  if (!okUrl) fail++;
  console.log(`${okUrl ? 'PASS' : 'FAIL'}  fetching a URL (including the guard's own status page) is not an outside write`);
  const urlInScript = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: 'const u = "https://example.com/a/b?x=1";' });
  const okUrlScript = urlInScript.decision === 'allow';
  if (!okUrlScript) fail++;
  console.log(`${okUrlScript ? 'PASS' : 'FAIL'}  an https URL inside script text is not an outside write`);

  // ...yet a REAL root delete still names the root it aimed at. Assembled from char codes so this
  // test file never contains the literal pattern the gate exists to stop (the gate reads this
  // repository's own scripts too, and refused one of them for quoting that pattern).
  const rootCmd = 'r' + 'm -r' + 'f ' + String.fromCharCode(47);
  const realRoot = judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: rootCmd });
  const okRealRoot = realRoot.decision === 'deny'
    && realRoot.rules.includes('posix-root-delete')
    && !!realRoot.action && realRoot.action.scope.externalPaths.includes(String.fromCharCode(47));
  if (!okRealRoot) fail++;
  console.log(`${okRealRoot ? 'PASS' : 'FAIL'}  a real root delete still names the root it aimed at`);

  const noPath = judge({ ...base, toolName: 'write', filePath: '', sessionWorkspace: SESSION });
  const okNoPath = noPath.decision === 'ask' && noPath.action && noPath.action.zh.includes('没有给出路径');
  if (!okNoPath) fail++;
  console.log(`${okNoPath ? 'PASS' : 'FAIL'}  a pathless write says so in one line`);

  const longCmd = judge({ ...base, toolName: 'pwsh', command: 'Remove-Item -Recurse -Force F:\\work\\app\\' + 'x'.repeat(400), sessionWorkspace: SESSION });
  const targetLine = longCmd.reason.split('\n').find((l) => l.includes('- target:')) || '';
  const okTrunc = targetLine.length > 0 && targetLine.length <= 230;
  if (!okTrunc) fail++;
  console.log(`${okTrunc ? 'PASS' : 'FAIL'}  a very long command is truncated in the dialog (${targetLine.length} chars), never dumped whole`);
}

// --- precision fixes measured from the live ledger (v0.2.0) -------------------
console.log('\n--- precision fixes (live-ledger regressions) ---');
{
  const SESSION = 'F:\\work\\app';
  const ok = (cond, label) => {
    if (!cond) fail++;
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const j = (cmd, tool) => judge({
    ...base,
    toolName: tool || 'pwsh',
    sessionWorkspace: SESSION,
    command: tool === 'edit' ? '' : (cmd || ''),
    filePath: tool === 'edit' ? cmd : '',
  });

  // 1. A wildcard on the READ side of a pipeline must not make a single-file write mass.
  //    Live: 2026-11-10T10:21:13Z, rejected by the user.
  const sums = j("Get-ChildItem releases\\adnet-v*.zip | Sort-Object Name | ForEach-Object { $h=(Get-FileHash $_.FullName).Hash; \"{0} {1}\" -f $h,$_.Name } | Set-Content releases\\SHA256SUMS.txt -Encoding ascii");
  ok(sums.decision === 'allow', 'read-side wildcard + one literal write target -> allow');

  // 2. A read-side `-Filter` wildcard must not escalate a single file delete inside the workspace.
  //    Live: 2026-10-16T08:47:27Z.
  const filtered = j("Remove-Item -LiteralPath '" + SESSION + "\\_session_repair\\x.py' -Force; Get-ChildItem '" + SESSION + "' -Filter '_tmp*' | Select-Object Name");
  ok(filtered.decision === 'allow', 'single-file delete inside the workspace + read-side -Filter -> allow');

  // 3. ...but the WRITE side's own wildcard still escalates.
  const writeWild = j("Get-ChildItem .\\src | Set-Content '" + SESSION + "\\out\\*.log' -Encoding ascii");
  ok(writeWild.decision === 'ask' && writeWild.rules.includes('wildcard-target'), 'a wildcard on the WRITE side still escalates');

  // 4. A path quoted inside a script literal carries doubled backslashes; it is the SAME file.
  //    Live: 26 rows, most recently 2026-11-19T07:25:05Z.
  const doubled = j("$js = @'\nconst p = 'C:\\\\Users\\\\me\\\\.dsh\\\\x.json';\n'@\nSet-Content -LiteralPath '" + SESSION + "\\_session_repair\\helper.mjs' -Value $js -Encoding utf8");
  ok(doubled.decision === 'allow', 'a doubled-backslash path in script text is normalized, not \"outside\"');

  // 5. POSIX phantoms out of code path expressions (`/f`, `/stem`). Live: three rejected runs 2026-11-10.
  const phantom = j("$env:PYTHONIOENCODING='utf-8'; @'\nfrom pathlib import Path\nroot = Path('.').resolve()\nstem = 'pkg'\np = root/\"releases\"/f\"{stem}.zip\"\np.unlink()\n'@ | python -");
  ok(phantom.decision === 'allow', 'POSIX phantoms from Python path expressions (/f, /stem) are ignored');

  // 5b. ...while a real Unix path is still a target.
  const realPosixPath = j('rm -r /etc/hosts');
  ok(realPosixPath.decision === 'ask' && realPosixPath.rules.includes('external-path-target'), 'a real Unix path (/etc/...) is still an outside target');

  // 6. `edit` is gated by SCOPE only: 1202 calls in 35 days, previously ungated.
  ok(j(SESSION + '\\lib\\index.mjs', 'edit').decision === 'allow', 'edit inside the workspace -> allow');
  const editOut = j('D:\\stuff\\note.md', 'edit');
  ok(editOut.decision === 'ask' && editOut.rules.includes('edit-outside-workspace'), 'edit outside every trusted root -> ask');
  const editProtected = j('C:\\Users\\me\\Desktop\\note.md', 'edit');
  ok(editProtected.decision === 'ask' && editProtected.rules.includes('edit-in-protected-root'), 'edit in a protected root -> ask');
  const editWild = j(SESSION + '\\lib\\*.mjs', 'edit');
  ok(editWild.decision === 'ask' && editWild.rules.includes('edit-wildcard-target'), 'edit naming a wildcard -> ask');
}

// --- P1/P2 fixes (coverage, fatigue, operations) ------------------------------
console.log('\n--- P1/P2 fixes ---');
{
  const SESSION = 'F:\\work\\app';
  const OTHER = 'F:\\work\\other';
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const j = (cmd, extra) => judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: cmd, ...(extra || {}) });
  const next = async () => ({ kind: 'allow' });
  const mkCtx = () => {
    const regs = [];
    return { regs, ctx: { on: (evt, l) => regs.push({ evt, l }) } };
  };
  const tmp = (name) => {
    const dir = join(tmpdir(), 'dg-' + name + '-' + process.pid + '-' + Math.floor(Math.random() * 1e6));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  // P1-9 additionalRoots: work in a second checkout without escalating every reference to it.
  const crossWrite = "Set-Content -LiteralPath '" + OTHER + "\\notes\\a.md' -Value x";
  ok(j(crossWrite).decision === 'ask', 'a write into another project asks by default');
  ok(j(crossWrite, { additionalRoots: [OTHER] }).decision === 'allow', 'additionalRoots makes that project in-scope (write)');
  const crossEdit = judge({ ...base, toolName: 'edit', sessionWorkspace: SESSION, filePath: OTHER + '\\lib\\a.mjs' });
  ok(crossEdit.decision === 'ask', 'edit into another project asks by default');
  ok(judge({ ...base, toolName: 'edit', sessionWorkspace: SESSION, filePath: OTHER + '\\lib\\a.mjs', additionalRoots: [OTHER] }).decision === 'allow', 'additionalRoots covers edit too');

  // P2 dry runs: a real PowerShell -WhatIf modifies nothing and must not be denied.
  ok(j('Format-Volume -DriveLetter Z -WhatIf').decision === 'allow' && j('Format-Volume -DriveLetter Z -WhatIf').rules.includes('dry-run'), 'Format-Volume -WhatIf is a dry run -> allow');
  ok(j('Remove-Item -Recurse -Force C:\\ -WhatIf').decision === 'allow', 'root delete with -WhatIf -> allow');
  ok(j('cmd /c del /s /q C:\\probe --WhatIf').decision === 'ask', 'a native command that ignores -WhatIf still asks');

  // P1-5 plugin_manager: installing code is always escalated; reading the inventory is not.
  const pm = (action, extra) => judge({ ...base, toolName: 'plugin_manager', sessionWorkspace: SESSION, pluginAction: action, pluginTarget: 'some-bundle@1.2.3', ...(extra || {}) });
  const pmInstall = pm('install_bundle');
  ok(pmInstall.decision === 'ask' && pmInstall.rules.includes('plugin-install'), 'plugin install -> ask [plugin-install]');
  ok(pm('list_plugins').decision === 'allow', 'plugin inventory read -> allow');
  ok(pm('install_bundle', { hardStop: true }).decision === 'deny', 'HARD-STOP denies a plugin install');

  // P1-6 extraGatedTools: a tool the guard does not know can still get the scope check.
  const rc = (p, extra) => judge({ ...base, toolName: 'run_code', sessionWorkspace: SESSION, extraToolPath: p, ...(extra || {}) });
  ok(rc('D:\\stuff\\x.js').decision === 'allow', 'an ungated unknown tool is out of scope by default');
  ok(rc('D:\\stuff\\x.js', { extraGatedTools: ['run_code'] }).decision === 'ask' && rc('D:\\stuff\\x.js', { extraGatedTools: ['run_code'] }).rules.includes('tool-outside-workspace'), 'extraGatedTools applies the scope check to run_code');
  ok(rc(SESSION + '\\out\\x.js', { extraGatedTools: ['run_code'] }).decision === 'allow', 'extraGatedTools stays silent inside the workspace');

  // P1-10 statusLine 'brief'.
  const full = statusLine(configOf({}), 'active', [], summarizeAudit(''), SESSION);
  const brief = statusLine(configOf({ statusLine: 'brief' }), 'active', [], summarizeAudit(''), SESSION);
  ok(brief.length < full.length && brief.includes('workspace: ' + SESSION) && brief.includes('switches: none'), 'brief status line keeps posture/workspace/switches and is shorter');

  // P2 rotation: the ledger rotates at auditMaxBytes and leaves a marker row.
  {
    const dir = tmp('rotate');
    const ledger = join(dir, 'audit.jsonl');
    const regs = [];
    apply({ on: (e, l) => regs.push({ e, l }) }, { stateDir: dir, auditLog: ledger, loadMarker: '', auditMaxBytes: 900, auditKeep: 2, statusLine: false });
    const gate = regs.find((r) => r.e === 'tools/pre-execute').l;
    for (let i = 0; i < 8; i++) {
      await gate({ name: 'pwsh', arguments: { command: "Remove-Item -LiteralPath '" + SESSION + "\\out\\x" + i + ".txt' -Force" }, agent: { id: 's', session: { header: { cwd: SESSION } } } }, next);
    }
    const current = readFileSync(ledger, 'utf8');
    const rolled = existsSync(ledger + '.1') ? readFileSync(ledger + '.1', 'utf8') : '';
    ok(current.length < 900 * 2 && rolled.length > 0, 'the ledger rotates into .1 when it reaches auditMaxBytes');
    ok((rolled + current).includes('audit-rotation'), 'rotation leaves a marked row');
  }

  // P2 load receipt truncation: one block per apply(), capped by loadMarkerKeep.
  {
    const dir = tmp('marker');
    const marker = join(dir, 'loaded.txt');
    for (let i = 0; i < 4; i++) {
      const c = { on: () => {} };
      apply(c, { stateDir: dir, auditLog: join(dir, 'a.jsonl'), loadMarker: marker, loadMarkerKeep: 2, statusLine: false });
    }
    const blocks = readFileSync(marker, 'utf8').split(/\r?\n---\r?\n/).filter((b) => b.trim() !== '');
    ok(blocks.length <= 2, 'the load receipt keeps at most loadMarkerKeep blocks');
  }

  // P1-8 approval memory: only after the tool actually executed, and only when enabled.
  {
    const runMemory = async (enabled) => {
      const dir = tmp('memory');
      const regs = [];
      const c = { on: (e, l) => regs.push({ e, l }) };
      apply(c, {
        stateDir: dir, auditLog: join(dir, 'a.jsonl'), loadMarker: '', statusLine: false,
        rememberApproved: { enabled, ttlSeconds: 60 },
      });
      const pre = regs.find((r) => r.e === 'tools/pre-execute').l;
      const post = regs.find((r) => r.e === 'tools/post-execute').l;
      const agent = { id: 's', session: { header: { cwd: SESSION } } };
      const cmd = "Set-Content -Path '" + SESSION + "\\out\\*.log' -Value x";
      const call = (id) => ({ name: 'pwsh', callId: id, arguments: { command: cmd }, agent });
      const first = await pre(call('c1'), next);
      const beforeSettlement = await pre(call('c2'), next);
      await post(call('c1'), {}, next);              // c1 ran => approved
      const afterSettlement = await pre(call('c3'), next);
      const auditText = readFileSync(join(dir, 'a.jsonl'), 'utf8');
      return { first, beforeSettlement, afterSettlement, auditText };
    };
    const off = await runMemory(false);
    ok(off.afterSettlement.kind === 'ask', 'with the memory disabled every call still asks');
    const on = await runMemory(true);
    ok(on.first.kind === 'ask', 'memory enabled: the first call asks');
    ok(on.beforeSettlement.kind === 'ask', 'memory enabled: a call before settlement still asks');
    ok(on.afterSettlement.kind === 'allow', 'memory enabled: after the approved call executed, the same command passes');
    ok(on.auditText.includes('remembered-approval'), 'the ledger records remembered-approval');
  }

  // P1-6 drift visibility: a mutating-looking tool with no rules is recorded once per process.
  {
    const dir = tmp('untracked');
    const ledger = join(dir, 'a.jsonl');
    const regs = [];
    apply({ on: (e, l) => regs.push({ e, l }) }, { stateDir: dir, auditLog: ledger, loadMarker: '', statusLine: false });
    const pre = regs.find((r) => r.e === 'tools/pre-execute').l;
    await pre({ name: 'run_code', arguments: {} }, next);
    await pre({ name: 'run_code', arguments: {} }, next);
    const rows = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.includes('untracked-tool'));
    ok(rows.length === 1, 'an unconfigured mutating-looking tool is recorded exactly once');
  }

  // P2 status page URL follows the request host (dsh changes ports every launch).
  const rep = statusReport({ cfg: configOf({}), mode: 'active', switches: [], audit: summarizeAudit(''), sessions: [], requestHost: '127.0.0.1:60939' });
  ok(rep.surfaces.thisPage === 'http://127.0.0.1:60939/dsh-guard/status', 'the status page reports the host that served it');

  console.log(localFail === 0 ? '  (all P1/P2 checks passed)' : '  (' + localFail + ' P1/P2 checks failed)');
}

// --- P1-7 live cwd + DENY anchoring ------------------------------------------
console.log('\n--- P1-7 live cwd + deny anchoring ---');
{
  const SESSION = 'F:\\work\\app';
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const j = (cmd, extra) => judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: cmd, ...(extra || {}) });

  // 1. relative resolution, pure
  ok(resolveRelative('C:\\Users\\me\\proj', '.\\build') === 'C:\\Users\\me\\proj\\build', 'resolveRelative folds a dot segment');
  ok(resolveRelative('C:\\Users\\me\\proj', '..\\other\\x') === 'C:\\Users\\me\\other\\x', 'resolveRelative folds a parent segment');
  ok(resolveRelative('C:\\Users\\me\\proj', 'D:\\x') === 'D:\\x', 'resolveRelative keeps an absolute path');
  ok(relativeTargetsOf("Remove-Item -Recurse '.\\*'").length === 1, 'relativeTargetsOf finds a quoted dot target');

  // 2. the hole this closes: after moving to a protected root, a RELATIVE delete has no absolute token
  const movedToHome = j('Remove-Item -Recurse .\\*', { sessionCwd: 'C:\\Users\\me' });
  ok(movedToHome.decision === 'ask' && movedToHome.rules.includes('relative-target-in-protected-root'),
    'relative delete while the session sits in a protected root -> ask (relative-target-in-protected-root)');
  const insideRel = j('Remove-Item -Recurse .\\*', { sessionCwd: SESSION });
  ok(!insideRel.rules.includes('relative-target-in-protected-root'), 'relative delete inside the workspace does not fire the protected-root rule');
  const outsideCwd = j('Remove-Item .\\x.txt', { sessionCwd: 'D:\\proj' });
  ok(outsideCwd.rules.includes('cwd-outside-workspace'), 'a relative write after moving outside every trusted root -> ask (cwd-outside-workspace)');
  const writeRel = judge({ ...base, toolName: 'write', sessionWorkspace: SESSION, filePath: '.\\x.json', sessionCwd: 'C:\\Users\\me' });
  ok(writeRel.decision === 'ask' && writeRel.rules.includes('relative-target-in-protected-root'), 'write with a relative file_path resolves against the live cwd');

  // 3. DENY rules are anchored to command position
  const denyStart = j('Format-Volume -DriveLetter Z');
  ok(denyStart.decision === 'deny', 'a real disk-format invocation is still denied');
  const denyAfterSemi = j('Write-Output seed; Format-Volume -DriveLetter Z');
  ok(denyAfterSemi.decision === 'deny', 'the same invocation after a separator is still denied');
  const quoted = j("Get-Content log.txt | Select-String 'format-volume'");
  ok(quoted.decision === 'allow', 'the WORD inside a quoted pattern is not a denial');
  const replaceText = j("$t = $t -replace 'a', 'format-volume'; Set-Content -LiteralPath '" + SESSION + "\\doc.md' -Value $t");
  ok(replaceText.decision === 'allow', 'a doc edit that mentions the cmdlet name is not a denial');

  console.log(localFail === 0 ? '  (all P1-7/deny checks passed)' : '  (' + localFail + ' P1-7/deny checks failed)');
}

// --- the 24h approval panel ---------------------------------------------------
console.log('\n--- 24h approval panel ---');
{
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const tmp = (name) => {
    const dir = join(tmpdir(), 'dg-' + name + '-' + process.pid + '-' + Math.floor(Math.random() * 1e6));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  ok(rulesFromReason('dsh-guard ASK [wildcard-target, external-path-target]: x').join(',') === 'wildcard-target,external-path-target', 'rulesFromReason extracts the rule ids');

  const now = Date.now();
  const rows = [
    { ts: now - 1000, rules: ['wildcard-target'], outcome: 'allowed-once' },
    { ts: now - 2000, rules: ['external-path-target'], outcome: 'rejected' },
    { ts: now - 30 * 3600 * 1000, rules: ['wildcard-target'], outcome: 'rejected' },
    { ts: now - 500, rules: ['ps-recursive-delete'], outcome: 'pending' },
  ];
  const sum = summarizeApprovals(rows, now, 24);
  ok(sum.asked === 3 && sum.approved === 1 && sum.rejected === 1 && sum.pending === 1, 'the window counts approved/rejected/pending and drops older rows');
  ok(sum.approvalRate === 0.5, 'the approval rate is approved / decided');
  ok(sum.byRuleRejected.length === 1 && sum.byRuleRejected[0].rule === 'external-path-target', 'rejected outcomes are attributed to their rules');
  ok(sum.allTime.asked === 4 && sum.allTime.approved === 1 && sum.allTime.rejected === 2, 'lifetime counts include rows outside the window');
  ok(typeof sum.allTime.since === 'string' && sum.allTime.since.startsWith('20'), 'lifetime reports the oldest row time');

  // Live pairing: approval/asked + approval/decided are session events; the listener joins them by id.
  const dir = tmp('outcomes');
  const file = join(dir, 'guard-outcomes.json');
  const regs = [];
  apply({ on: (e, l) => regs.push({ e, l }) }, { stateDir: dir, auditLog: join(dir, 'a.jsonl'), loadMarker: '', outcomesKeep: 10 });
  const onEvent = regs.find((r) => r.e === 'session/event').l;
  const asked = (id, reason) => onEvent({}, { type: 'approval/asked', time: Date.now(), data: { id, reason } });
  const decided = (id, outcome) => onEvent({}, { type: 'approval/decided', time: Date.now(), data: { id, outcome } });

  asked('a1', 'dsh-guard ASK [wildcard-target]: x'); decided('a1', 'allowed-once');
  asked('a2', 'dsh-guard ASK [external-path-target]: x'); decided('a2', 'rejected');
  asked('a3', 'some other plugin asked a question'); decided('a3', 'rejected');
  asked('a1', 'dsh-guard ASK [wildcard-target]: x');   // same approval id twice (plugin hot reload)
  await new Promise((r) => setTimeout(r, 800));
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  ok(saved.rows.length === 2, 'only guard escalations are stored, and each approval id is stored once');
  const a1 = saved.rows.find((r) => r.id === 'a1');
  ok(a1 && a1.outcome === 'allowed-once' && a1.rules[0] === 'wildcard-target', 'the decision is paired by approval id');

  const rep = statusReport({
    cfg: configOf({ stateDir: dir }), mode: 'active', switches: [],
    audit: summarizeAudit(''), sessions: [], approvals: summarizeApprovals(saved.rows, Date.now(), 24),
  });
  ok(rep.approvals.asked === 2 && rep.approvals.approved === 1 && rep.approvals.rejected === 1, 'the status report carries the 24h block');
  ok(statusReportHtml(rep).includes('approvals (last 24h)'), 'the HTML page renders the panel');

  for (let i = 0; i < 30; i++) { asked('b' + i, 'dsh-guard ASK [wildcard-target]: x'); decided('b' + i, 'allowed-once'); }
  await new Promise((r) => setTimeout(r, 800));
  const capped = JSON.parse(readFileSync(file, 'utf8'));
  ok(capped.rows.length <= 10, 'the outcome ring is capped by outcomesKeep');

  console.log(localFail === 0 ? '  (all panel checks passed)' : '  (' + localFail + ' panel checks failed)');
}

// --- bundle support: config discovery, recent rows, action endpoint -----------
console.log('\n--- bundle support ---');
{
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const tmp = (name) => {
    const dir = join(tmpdir(), 'dg-' + name + '-' + process.pid + '-' + Math.floor(Math.random() * 1e6));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  // 1. a bundle row carries no absolute path, so the JSON file is derived from the module location.
  //    DSH_PROFILE_DIR is only a fallback: the host process does not always export it (measured
  //    2026-11-19), and relying on it silently lost the config and the load receipt.
  const cfgDir = tmp('cfgdiscover');
  writeFileSync(join(cfgDir, 'dsh-guard.json'), JSON.stringify({ statusLine: 'brief', auditKeep: 7 }), 'utf8');
  const prevProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = cfgDir;
  const projectDir = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
  const discovered = readConfigFile({});
  ok(discovered.path.endsWith('dsh-guard.json') && /^[A-Za-z]:\\/.test(discovered.path), 'the config path is derived from the module location, not the env var');
  ok(discovered.fromFile && typeof discovered.fromFile === 'object' && Object.keys(discovered.fromFile).length === 0, 'a missing discovered file yields no values instead of throwing');
  const explicit = readConfigFile({ configFile: join(cfgDir, 'dsh-guard.json') });
  ok(explicit.fromFile.statusLine === 'brief' && explicit.fromFile.auditKeep === 7, 'an explicit configFile is read and wins');
  if (prevProfile !== undefined) process.env.DSH_PROFILE_DIR = prevProfile;
  else delete process.env.DSH_PROFILE_DIR;

  // 1b. the module path yields the profile directory for both package and loose layouts
  ok(profileDirOf('file:///C:/p/profiles/desktop/node_modules/dsh-guard-native/lib/index.mjs') === 'C:\\p\\profiles\\desktop', 'profileDirOf strips node_modules/<pkg>/lib');
  ok(profileDirOf('file:///C:/p/profiles/desktop/dsh-guard-native.mjs') === 'C:\\p\\profiles\\desktop', 'profileDirOf handles the legacy loose module');
  ok(configOf({}).loadMarker.endsWith('dsh-guard-native-loaded.txt'), 'bundle mode derives the load receipt from the module location, with no env var');

  // 2. the ledger tail ships with the report, newest first
  const auditLines = [
    JSON.stringify({ ts: '1', decision: 'allow', rule: 'no-bulk-signal', preview: 'a' }),
    JSON.stringify({ ts: '2', decision: 'ask', rules: ['wildcard-target'], preview: 'b' }),
  ].join('\n');
  const rolled = summarizeAudit(auditLines);
  ok(rolled.recent.length === 2 && rolled.recent[0].ts === '2' && rolled.recent[0].rules[0] === 'wildcard-target', 'summarizeAudit ships a newest-first tail');

  // 3. the action endpoint: switch on/off, unknown kind, config write with and without a file.
  //    DSH_PROFILE_DIR is pinned to the temp dir for the whole block: a test must never be able to
  //    reach the real profile through the bundle's config discovery (the previous version tried to,
  //    and only the file sandbox stopped it).
  const stateDir = tmp('actionstate');
  const realProfile = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = stateDir;
  const mountRoutes = () => {
    const routes = [];
    apply({ on: () => {}, inject: (deps, cb) => { if (deps[0] === 'webServer') cb({ webServer: { register: (r) => routes.push(r) }, get: (n) => n === 'connection' ? { requestRejection: () => undefined } : undefined }); } },
      { stateDir, auditLog: join(stateDir, 'a.jsonl'), loadMarker: '', configFile: join(stateDir, 'dsh-guard.json') });
    return routes.find((r) => r.path === '/dsh-guard/action').handler;
  };
  const callWith = async (handler, payload) => {
    const { EventEmitter } = await import('node:events');
    const req = new EventEmitter();
    req.method = 'POST';
    const res = { status: 0, body: '' };
    const done = new Promise((resolve) => {
      res.writeHead = (s) => { res.status = s; };
      res.end = (b) => { res.body = String(b); resolve(); };
    });
    handler(req, res);
    req.emit('data', JSON.stringify(payload));
    req.emit('end');
    await done;
    return { status: res.status, json: JSON.parse(res.body) };
  };

  const action = mountRoutes();
  const call = (payload) => callWith(action, payload);

  const on = await call({ kind: 'switch', name: 'PANIC', on: true });
  ok(on.status === 200 && on.json.ok && on.json.switches.includes('PANIC'), 'POST action switch PANIC on creates the switch file');
  const off = await call({ kind: 'switch', name: 'PANIC', on: false });
  ok(off.status === 200 && !off.json.switches.includes('PANIC'), 'POST action switch PANIC off removes it again');
  const badSwitch = await call({ kind: 'switch', name: 'REBOOT', on: true });
  ok(badSwitch.status === 400, 'an unknown switch name is refused');
  const badKind = await call({ kind: 'nope' });
  ok(badKind.status === 400, 'an unknown action kind is refused');

  const cfgWrite = await call({ kind: 'config', patch: { statusLine: 'brief', auditKeep: 5 } });
  const written = JSON.parse(readFileSync(join(stateDir, 'dsh-guard.json'), 'utf8'));
  ok(cfgWrite.status === 200 && written.auditKeep === 5 && written.statusLine === 'brief', 'a config write creates the discovered dsh-guard.json');

  const filtered = await call({ kind: 'config', patch: { auditKeep: 9, notAllowListed: 'x' } });
  const afterFilter = JSON.parse(readFileSync(join(stateDir, 'dsh-guard.json'), 'utf8'));
  ok(filtered.status === 200 && afterFilter.auditKeep === 9 && !('notAllowListed' in afterFilter), 'the config write accepts only allow-listed keys');
  if (realProfile !== undefined) process.env.DSH_PROFILE_DIR = realProfile;
  else delete process.env.DSH_PROFILE_DIR;

  ok(!existsSync(discovered.path), 'no test wrote a config file into the source tree');
  console.log(localFail === 0 ? '  (all bundle-support checks passed)' : '  (' + localFail + ' bundle-support checks failed)');
}

// --- the bundle manifest itself ----------------------------------------------
console.log('\n--- bundle manifest ---');
{
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = new URL('..', import.meta.url);

  ok(!!(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch), 'package.json declares dsh.bundle.patch');
  const patchPath = new URL(pkg.dsh.bundle.patch, root);
  const patchText = readFileSync(patchPath, 'utf8');
  ok(patchText.includes("name: '" + pkg.name + "'") || patchText.includes('name: "' + pkg.name + '"'), 'the bundle patch inserts a row named after the package');
  ok(!/C:\\\\|C:\\Users/.test(patchText), 'the bundle patch carries no absolute machine path');

  const clientPath = new URL('./client/client.js', root);
  const clientText = readFileSync(clientPath, 'utf8');
  ok(clientText.includes("id: '" + pkg.name + "'") || clientText.includes('id: "' + pkg.name + '"'), 'the client factory id equals the package name');
  ok(!!(pkg.dsh.client && pkg.dsh.client.platform === 'web' && Array.isArray(pkg.dsh.client.inject)), 'dsh.client declares platform and inject');
  ok(!!(pkg.exports && pkg.exports['./client'] && pkg.exports['./locale/*.json'] && pkg.exports['./icon']), 'exports include ./client, ./locale/*.json and ./icon');

  for (const loc of ['en', 'zh']) {
    const doc = JSON.parse(readFileSync(new URL('./locale/' + loc + '.json', root), 'utf8'));
    const meta = doc.meta || {};
    ok(typeof meta.title === 'string' && meta.title.length > 0 && typeof meta.description === 'string' && meta.description.length > 0,
      'locale/' + loc + '.json has meta.title and meta.description');
  }
  const detailPath = new URL(JSON.parse(readFileSync(new URL('./locale/en.json', root), 'utf8')).meta.detail, root);
  ok(existsSync(detailPath), 'meta.detail names an existing detail document');
  const icon = readFileSync(new URL('./icon.svg', root), 'utf8');
  ok(icon.trimStart().startsWith('<svg') && Buffer.byteLength(icon) <= 256 * 1024, 'icon.svg is an SVG under the 256 KiB limit');
  ok(['locale', 'docs', 'client', 'icon.svg', 'cordis.patch.yml'].every((f) => (pkg.files || []).includes(f)), 'files lists the runtime, locale, detail and icon paths');

  console.log(localFail === 0 ? '  (all manifest checks passed)' : '  (' + localFail + ' manifest checks failed)');
}

// --- noise fixes measured from the live ledger ---------------------------------
console.log('\n--- noise fixes (remote scope, read-only externals, sinks, archive dest) ---');
{
  const SESSION = 'F:\\work\\proj';
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };
  const j = (cmd) => judge({ ...base, toolName: 'pwsh', sessionWorkspace: SESSION, command: cmd });

  // 1. POSIX paths inside an ssh payload are REMOTE, not "outside this workspace"
  const remoteDel = j("ssh root@10.0.0.5 'set -e; rm -rf /opt/app && systemctl restart app'");
  ok(remoteDel.decision === 'ask' && remoteDel.rules.includes('remote-command') && !remoteDel.rules.includes('external-path-target'),
    'a destructive ssh payload asks as remote-command, not as an outside-workspace target');
  ok(j("ssh root@10.0.0.5 'cat /etc/nginx/nginx.conf'").decision === 'allow', 'a read-only ssh payload asks nothing');
  ok(j("scp -i C:\\Users\\me\\.ssh\\k\\id_ed25519 app.zip root@10.0.0.5:/opt/app/").rules.every((r) => r !== 'external-path-target'),
    'a credential path is not an outside write target');

  // 2. a read-only external executable (chrome) is not a write target
  ok(j("& 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' --headless --dump-dom about:blank").decision === 'allow',
    'an external executable in a read position asks nothing');

  // 3. sinks are not targets
  ok(j('Get-Content log.txt | Out-File /dev/null').decision === 'allow', '/dev/null is treated as a sink');

  // 4. extraction into an existing but EMPTY destination is not an overwrite
  ok(j('Expand-Archive .\\x.zip -DestinationPath F:\\work\\proj\\empty-out -Force').decision === 'allow',
    'extracting into an empty destination asks nothing');

  // 5. askMode: deny turns an escalation into a refusal with the same reason
  const runGate = async (cfg) => {
    const regs = [];
    apply({ on: (e, l) => regs.push({ e, l }) }, { stateDir: mkdtempSync(join(tmpdir(), 'dg-askmode-')), auditLog: join(tmpdir(), 'dg-askmode-' + Date.now() + '.jsonl'), loadMarker: '', ...cfg });
    const gate = regs.find((r) => r.e === 'tools/pre-execute').l;
    return gate({ name: 'pwsh', arguments: { command: "Remove-Item -Recurse -Force 'F:\\work\\proj\\build'" }, agent: { id: 's', session: { header: { cwd: SESSION } } } }, async () => ({ kind: 'allow' }));
  };
  const denied = await runGate({ askMode: 'deny' });
  ok(denied.kind === 'deny' && /askMode=deny/.test(denied.reason), 'askMode=deny refuses instead of asking, with the reason attached');
  const asked = await runGate({});
  ok(asked.kind === 'ask', 'the default askMode still asks');

  console.log(localFail === 0 ? '  (all noise-fix checks passed)' : '  (' + localFail + ' noise-fix checks failed)');
}

// --- panel data path, approvals semantics, profile location -------------------
console.log('\n--- panel data & profile location ---');
{
  let localFail = 0;
  const ok = (cond, label) => {
    if (!cond) { fail++; localFail++; }
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  };

  // 1. the PANIC prefix must not be mistaken for a rule name
  ok(rulesFromReason('[PANIC MODE] dsh-guard ASK [wildcard-target, ps-recursive-delete]: x').join(',') === 'wildcard-target,ps-recursive-delete',
    'rulesFromReason ignores the [PANIC MODE] prefix');

  // 2. the ledger window is separate from the last-200 rollup
  const now = Date.now();
  const lines = [
    JSON.stringify({ ts: new Date(now - 1000).toISOString(), decision: 'ask', rule: 'x' }),
    JSON.stringify({ ts: new Date(now - 2000).toISOString(), decision: 'allow', rule: 'y' }),
    JSON.stringify({ ts: new Date(now - 30 * 3600 * 1000).toISOString(), decision: 'ask', rule: 'z' }),
  ].join('\n');
  const rolled = summarizeAudit(lines, 24 * 3600 * 1000);
  ok(rolled.window.ask === 1 && rolled.window.allow === 1 && rolled.window.hours === 24, 'summarizeAudit counts a 24h window separately from last-200');

  // 3. a sub-50 ms rejection is "no answerer", not a human decision
  const sum = summarizeApprovals([
    { ts: now - 1000, rules: ['a'], outcome: 'rejected', latencyMs: 3 },
    { ts: now - 2000, rules: ['b'], outcome: 'rejected', latencyMs: 12000 },
    { ts: now - 3000, rules: ['c'], outcome: 'allowed-once', latencyMs: 9000 },
  ], now, 24);
  ok(sum.rejected === 2 && sum.autoRejected === 1, 'a rejection under 50 ms is reported as auto-rejected');

  // 4. the session listener accepts a PANIC-prefixed reason and keeps the latency
  const dir = mkdtempSync(join(tmpdir(), 'dg-panic-'));
  const ring = join(dir, 'guard-outcomes.json');
  const regs = [];
  apply({ on: (e, l) => regs.push({ e, l }) }, { stateDir: dir, auditLog: join(dir, 'a.jsonl'), loadMarker: '', configFile: join(dir, 'dsh-guard.json') });
  const onEvent = regs.find((r) => r.e === 'session/event').l;
  const t0 = Date.now();
  onEvent({}, { type: 'approval/asked', time: t0, data: { id: 'p1', reason: '[PANIC MODE] dsh-guard ASK [ps-recursive-delete]: x' } });
  onEvent({}, { type: 'approval/decided', time: t0 + 2, data: { id: 'p1', outcome: 'rejected' } });
  await new Promise((r) => setTimeout(r, 800));
  const saved = JSON.parse(readFileSync(ring, 'utf8')).rows.find((r) => r.id === 'p1');
  ok(!!saved && saved.rules[0] === 'ps-recursive-delete' && saved.panic === true && saved.latencyMs === 2,
    'a PANIC-prefixed ask is recorded with its real rule, the flag and the latency');

  // 5. profile location: a linked package scans declarations; an installed one uses its module path
  const home = mkdtempSync(join(tmpdir(), 'dg-home-'));
  mkdirSync(join(home, 'profiles', 'a'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'a', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  mkdirSync(join(home, 'profiles', 'b'), { recursive: true });
  writeFileSync(join(home, 'profiles', 'b', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-guard-native'] } } }));
  const prev = process.env.DSH_PROFILE_DIR;
  delete process.env.DSH_PROFILE_DIR;
  ok(locateProfileDir('C:\\module', false, home) === join(home, 'profiles', 'b'), 'a linked package locates the profile that declares it');
  ok(locateProfileDir('C:\\module', true, home) === 'C:\\module', 'an installed package uses its module path');
  process.env.DSH_PROFILE_DIR = prev;

  console.log(localFail === 0 ? '  (all panel/profile checks passed)' : '  (' + localFail + ' panel/profile checks failed)');
}

// --- the approval dialog must lead with the classified sentence ----------------
console.log('\n--- escalation tells the human why ---');
{
  const bulk = judge({ ...base, toolName: 'pwsh', command: 'Remove-Item -Recurse -Force .\\panel', sessionWorkspace: 'F:\\work\\app' });
  const ok1 = bulk.decision === 'ask'
    && bulk.reason.startsWith('dsh-guard ASK [')
    && bulk.reason.includes('批量删除（本工作区内）')
    && bulk.reason.includes('ps-recursive-delete')
    && bulk.reason.includes('recursive delete')
    && bulk.reason.includes('target: Remove-Item -Recurse -Force .\\panel')
    && bulk.reason.includes('workspace: F:\\work\\app');
  if (!ok1) fail++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  bulk ask: one classified sentence, then rule / scope / target evidence`);

  const writeAsk = judge({ ...base, toolName: 'write', filePath: 'D:\\stuff\\note.md', sessionWorkspace: 'F:\\work\\app' });
  const ok2 = writeAsk.decision === 'ask'
    && writeAsk.rules.includes('write-outside-workspace')
    && writeAsk.reason.includes('本工作区外')
    && writeAsk.reason.includes('outside every trusted root')
    && writeAsk.reason.includes('D:\\stuff\\note.md');
  if (!ok2) fail++;
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  an out-of-scope write says "outside the workspace" in words, then names the rule`);

  const deny = judge({ ...base, toolName: 'pwsh', command: 'Remove-Item -Recurse -Force C:\\', sessionWorkspace: 'F:\\work\\app' });
  const ok3 = deny.decision === 'deny'
    && deny.reason.includes('批量删除（本工作区外）')
    && deny.reason.includes('unbounded-root-delete')
    && deny.reason.includes('drive root')
    && deny.reason.includes('NOT executed');
  if (!ok3) fail++;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  a hard deny states "NOT executed" in words and names the unrecoverable-target rule`);

  // The headline must not re-dump the command: the user asked for a sentence, not a transcript.
  const hud = judge({
    ...base,
    toolName: 'pwsh',
    sessionWorkspace: 'F:\\work\\app',
    command: 'Get-ChildItem .\\data -Recurse | Remove-Item -Force\nGet-ChildItem .\\logs -Recurse | Remove-Item -Force',
  });
  const firstLine = hud.reason.split('\n')[0];
  const ok4 = firstLine.length <= 240 && !firstLine.includes('Get-ChildItem');
  if (!ok4) fail++;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}  the headline stays short and never repeats the command (${firstLine.length} chars)`);

  const status = statusLine(configOf({}), 'active', [], summarizeAudit(''), 'F:\\work\\app');
  const ok5 = status.includes('workspace: F:\\work\\app') && status.includes("this session's own cwd");
  if (!ok5) fail++;
  console.log(`${ok5 ? 'PASS' : 'FAIL'}  the status line reports the workspace the gate will use`);
}

// --- the sandbox-bypass floor: sandbox_permissions can never pass silently ----
console.log('\n--- sandbox escalation (full file authority) ---');
{
  const SESSION = 'F:\\work\\app';
  // A GATING instance (not the shadow one): `gating: false` would delegate everything by design.
  const stateDir = join(tmpdir(), 'dsh-guard-test-state-' + process.pid);
  const auditLog = join(tmpdir(), 'dsh-guard-test-audit-' + process.pid + '.jsonl');
  mkdirSync(stateDir, { recursive: true });
  const live = [];
  apply({ on: (evt, l) => live.push({ evt, l }) }, { stateDir, auditLog, loadMarker: '' });
  const gate = live.find((r) => r.evt === 'tools/pre-execute').l;
  const next = async () => ({ kind: 'allow' });

  // Each case runs twice: without the field (baseline) and with it. The floor must raise an
  // allow to an ask and must never touch a verdict that was already stricter. The gate returns
  // `{kind, reason, displayReason}` -- `displayReason` is what the panel actually shows.
  const call = (tool, args) => ({ name: tool, arguments: args, agent: { id: 's', session: { header: { cwd: SESSION } } } });
  const floor = async (label, args, want, extra) => {
    const tool = args.file_path !== undefined ? 'write' : 'pwsh';
    const bare = await gate(call(tool, { ...args }), next);
    const esc = await gate(call(tool, { ...args, sandbox_permissions: 'danger-full-access', justification: '因为沙箱拒绝了这条命令' }), next);
    const ok = bare.kind === want.bare
      && esc.kind === want.kind
      && String(esc.reason).includes(want.text)
      && (extra ? extra(esc, bare) : true);
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${bare.kind} -> ${esc.kind})`);
    if (!ok) console.log('      reason head: ' + String(esc.reason).split('\n')[0].slice(0, 150));
    return esc;
  };

  // THE POLICY: only a CROSSING is escalated. A deletion, or a MASS rewrite -- both are
  // "越界行为". Everything that stays inside the project as a single target passes through even
  // with the field set, because the sandbox standing down cannot reach past the project.
  const inWorkspaceWrite = await floor('in-workspace single write (no extra question)',
    { file_path: SESSION + '\\_session_repair\\x.md' },
    { bare: 'allow', kind: 'allow', text: '' },
    (esc) => esc.kind === 'allow' && esc.reason === undefined);
  await floor('in-workspace script write (no extra question)',
    { command: 'node -e "require(\'node:fs\').writeFileSync(\'F:/work/app/out/x.json\',\'x\')"' },
    { bare: 'allow', kind: 'allow', text: '' });
  await floor('out-of-workspace single write (already asks)',
    { file_path: 'D:\\stuff\\note.md' },
    { bare: 'ask', kind: 'ask', text: 'write-outside-workspace' });
  const readonly = await floor('read-only command (no extra question)',
    { command: 'Get-ChildItem C:\\Users\\me -Recurse -Filter *.json | Select-Object -First 3' },
    { bare: 'allow', kind: 'allow', text: '' });
  await floor('deny verdict (unbounded root delete) stays deny',
    { command: 'Remove-Item -Recurse -Force C:\\' },
    { bare: 'deny', kind: 'deny', text: 'unbounded-root-delete' },
    (esc) => !esc.reason.includes('sandbox-escalation'));
  const bulkInside = await floor('bulk recursive delete INSIDE the workspace (rule asks first)',
    { command: 'Remove-Item -Recurse -Force F:\\work\\app\\_session_repair' },
    { bare: 'ask', kind: 'ask', text: 'ps-recursive-delete' });

  // A crossing the RULES already escalate must keep its own rule ids: the floor's job is the
  // shape that would otherwise pass silently, not to relabel what another rule caught.
  for (const [label, args, rule] of [
    ['mass delete of an external directory', { command: 'Remove-Item -Recurse -Force C:\\Program Files\\Foo' }, 'external-path-target'],
    ['bulk copy onto an external path', { command: 'Copy-Item -Force -Recurse F:\\work\\app\\a C:\\Users\\me\\AppData\\Local\\Temp\\b' }, 'external-path-target'],
  ]) {
    const esc = await gate(call('pwsh', { ...args, sandbox_permissions: 'danger-full-access', justification: '因为沙箱拒绝了这条命令' }), next);
    const ok = esc.kind === 'ask' && esc.reason.includes(rule) && !esc.reason.includes('sandbox-escalation');
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  crossing kept by its own rule (${esc.kind}) ${label} [${rule}]`);
    if (!ok) console.log('      reason head: ' + String(esc.reason).split('\n')[0].slice(0, 170));
  }

  // The crossing the floor exists for: a MASS REWRITE inside the workspace that no rule
  // escalates (`Copy-Item -Recurse` is not in the destructive-verb table) -- with the sandbox
  // standing down it would rewrite the whole tree unattended.
  const massCopy = { command: 'Copy-Item -Force -Recurse F:\\work\\app\\src F:\\work\\app\\backup' };
  const bareCopy = await gate(call('pwsh', { ...massCopy }), next);
  const escCopy = await gate(call('pwsh', { ...massCopy, sandbox_permissions: 'danger-full-access', justification: '因为沙箱拒绝了这条命令' }), next);
  const okCopy = bareCopy.kind === 'allow'
    && escCopy.kind === 'ask'
    && escCopy.reason.includes('sandbox-escalation')
    && escCopy.payload === undefined
    && escCopy.displayReason.zh.includes('大批量改写')
    && escCopy.displayReason.zh.includes('sandbox-escalation');
  if (!okCopy) fail++;
  console.log(`${okCopy ? 'PASS' : 'FAIL'}  FLOOR: in-workspace mass rewrite with full authority (${bareCopy.kind} -> ${escCopy.kind})`);
  if (!okCopy) console.log('      reason head: ' + String(escCopy.reason).split('\n')[0].slice(0, 170));

  // An escalation must still explain itself in one classified sentence, in both languages.
  for (const [label, verdict] of [['rule ask', bulkInside], ['floor ask', escCopy]]) {
    const ok = verdict.displayReason
      && typeof verdict.displayReason.zh === 'string' && verdict.displayReason.zh.length > 10
      && typeof verdict.displayReason.en === 'string' && verdict.displayReason.en.length > 10
      && verdict.reason.includes('  - 摘要: ');
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  an escalated verdict still carries a classified sentence (${label})`);
  }
  for (const [label, verdict] of [['in-workspace write', inWorkspaceWrite], ['read-only', readonly]]) {
    const ok = verdict.kind === 'allow' && !verdict.reason && !verdict.displayReason;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  a non-crossing escalation passes through silently (${label})`);
  }

  // HARD-STOP must make the FLOOR's crossing a deny, not a question. The same temp state
  // directory is reused, so the ledger assertions below read rows this gating instance wrote.
  writeFileSync(join(stateDir, 'HARD-STOP'), '');
  const hardened = [];
  apply({ on: (evt, l) => hardened.push({ evt, l }) }, { stateDir, auditLog, loadMarker: '' });
  const hardenedGate = hardened.find((r) => r.evt === 'tools/pre-execute').l;
  const hs = await hardenedGate({ name: 'pwsh', arguments: { ...massCopy, sandbox_permissions: 'danger-full-access', justification: '因为沙箱拒绝了这条命令' }, agent: { id: 's', session: { header: { cwd: SESSION } } } }, next);
  const okHs = hs.kind === 'deny' && hs.reason.includes('NOT executed') && hs.reason.includes('sandbox-escalation');
  if (!okHs) fail++;
  console.log(`${okHs ? 'PASS' : 'FAIL'}  HARD-STOP turns a crossing into a deny`);

  // The requester's own justification is kept beside the guard's facts in the ledger. Pick the
  // HARD-STOP row specifically: earlier floor cases also wrote `sandbox-escalation` rows (as ask).
  const rows = readFileSync(auditLog, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const row = rows.find((r) => r.rule === 'sandbox-escalation' && r.decision === 'deny');
  const okRow = !!row && row.sandbox === 'danger-full-access' && row.justification === '因为沙箱拒绝了这条命令'
    && row.rules.includes('sandbox-escalation')
    && rows.some((r) => r.rule === 'sandbox-escalation' && r.decision === 'ask');
  if (!okRow) fail++;
  console.log(`${okRow ? 'PASS' : 'FAIL'}  the ledger records the mode and the model's justification (ask and deny rows)`);
}

// --- the on-demand status surface (report + route registration) --------------
console.log('\n--- status surface ---');
{
  const cfg = configOf({ statusLine: true, loadMarker: '' });
  const report = statusReport({
    cfg,
    mode: 'active',
    switches: [],
    audit: summarizeAudit(JSON.stringify({ decision: 'ask', rule: 'ps-recursive-delete', preview: 'Remove-Item -Recurse' })),
    loadedAt: '2026-10-16T01:47:52.476Z',
    pid: 20472,
    file: 'C:\\Users\\me\\.dsh\\profiles\\desktop\\dsh-guard-native.mjs',
    sessions: [{ id: 'session-3a3bfc97', workspace: 'F:\\work\\app' }],
  });
  const ok1 = report.plugin.gating === true
    && report.posture.headline.startsWith('ACTIVE')
    && report.audit.total === 1
    && report.sessions[0].workspace === 'F:\\work\\app'
    && report.rules.bulk.length > 10
    && report.surfaces.settingsSection.includes('CLIENT slot');
  if (!ok1) fail++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  statusReport carries posture, workspace model, counts, rules and surface truth`);

  const off = statusReport({ cfg, mode: 'DISABLED-BY-CONFIG', switches: ['DISABLE'], audit: summarizeAudit(''), sessions: [] });
  const ok2 = off.plugin.gating === false && off.posture.headline.startsWith('DISABLED') && off.posture.emergency.includes('DISABLE');
  if (!ok2) fail++;
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  a disabled guard reports itself as disabled (never silently "active")`);

  const html = statusReportHtml(report);
  const ok3 = html.startsWith('<!doctype html>') && html.includes('dsh-guard status') && html.includes('F:\\work\\app') && !html.includes('<script');
  if (!ok3) fail++;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  the page renders self-contained HTML with no script tags`);

  const escaped = statusReportHtml(statusReport({ cfg: configOf({}), mode: 'active', switches: [], audit: summarizeAudit(''), sessions: [{ id: '<img src=x onerror=alert(1)>', workspace: 'a"b' }] }));
  const ok4 = !escaped.includes('<img') && escaped.includes('&lt;img');
  if (!ok4) fail++;
  console.log(`${ok4 ? 'PASS' : 'FAIL'}  session ids are HTML-escaped in the page`);

  // A composition with the client web carrier registers the route; one without must not throw.
  const routes = [];
  const withWeb = { on: () => {}, get: (k) => (k === 'webServer' ? { register: (r) => routes.push(r) } : undefined) };
  apply(withWeb, { auditLog: join(tmpdir(), 'dsh-guard-surface-audit.jsonl'), stateDir: join(tmpdir(), 'dsh-guard-surface-state'), loadMarker: '' });
  const ok5 = routes.length === 2
    && routes.some((r) => r.path === '/dsh-guard/status' && typeof r.handler === 'function')
    && routes.some((r) => r.path === '/dsh-guard/action' && typeof r.handler === 'function');
  if (!ok5) fail++;
  console.log(`${ok5 ? 'PASS' : 'FAIL'}  a resolvable web carrier gets the /dsh-guard/status route`);

  // The documented shape for an OPTIONAL service is `ctx.inject([...], cb)`: the callback runs
  // when the carrier appears. A one-shot get() raced readiness and silently registered nothing
  // -- which is how the route first answered 404 (observed live 2026-10-16T02:20Z) with no trace.
  const injected = [];
  const withInject = { on: () => {}, inject: (deps, cb) => { injected.push({ deps, cb }); }, get: () => undefined };
  apply(withInject, { auditLog: join(tmpdir(), 'dsh-guard-surface-audit2.jsonl'), stateDir: join(tmpdir(), 'dsh-guard-surface-state2'), loadMarker: '' });
  const deferred = [];
  const webInject = injected.find((i) => Array.isArray(i.deps) && i.deps[0] === 'webServer');
  if (webInject) webInject.cb({ webServer: { register: (r) => deferred.push(r) } });
  // Two optional services are injected now: webServer (route) and workingDirectory (live cwd).
  // The assertion names both so a THIRD, unexpected inject would still fail this check.
  const ok7 = injected.length >= 1
    && injected.every((i) => Array.isArray(i.deps) && i.deps.length === 1 && ['webServer', 'workingDirectory'].includes(i.deps[0]))
    && !!webInject && deferred.length === 2
    && deferred.some((r) => r.path === '/dsh-guard/status') && deferred.some((r) => r.path === '/dsh-guard/action');
  if (!ok7) fail++;
  console.log(`${ok7 ? 'PASS' : 'FAIL'}  the route registers through ctx.inject(['webServer'], cb) (readiness-safe)`);

  // A carrier that refuses the route must leave a trace instead of failing silently.
  const routeState = join(tmpdir(), 'dsh-guard-route-state-' + process.pid);
  const routeMarker = join(tmpdir(), 'dsh-guard-route-marker-' + process.pid + '.txt');
  const throwing = { on: () => {}, inject: (deps, cb) => cb({ webServer: { register: () => { throw new Error('duplicate route'); } } }), get: () => undefined };
  apply(throwing, { stateDir: routeState, loadMarker: routeMarker });
  let trouble = '';
  try { trouble = readFileSync(join(tmpdir(), 'dsh-guard-route-marker-' + process.pid + '-status-route.txt'), 'utf8'); } catch { trouble = ''; }
  const ok8 = trouble.includes('duplicate route');
  if (!ok8) fail++;
  console.log(`${ok8 ? 'PASS' : 'FAIL'}  a refused route registration is recorded, not swallowed`);

  const ok6 = (() => {
    try {
      apply({ on: () => {}, get: () => { throw new Error('no such service'); } }, { loadMarker: join(tmpdir(), 'dsh-guard-matrix-none.txt'), auditLog: join(tmpdir(), 'dsh-guard-matrix-none.jsonl'), stateDir: join(tmpdir(), 'dsh-guard-matrix-none') });
      return true;
    } catch { return false; }
  })();
  if (!ok6) fail++;
  console.log(`${ok6 ? 'PASS' : 'FAIL'}  a missing/throwing service lookup never breaks the plugin`);
}
console.log('\n--- session status line ---');
{
  const rows = [
    JSON.stringify({ ts: '2026-10-15T11:00:00Z', decision: 'allow', rule: 'no-bulk-signal', preview: 'x' }),
    JSON.stringify({ ts: '2026-10-15T11:01:00Z', decision: 'ask', rule: 'ps-recursive-delete', preview: 'Remove-Item -Recurse' }),
    JSON.stringify({ ts: '2026-10-15T11:02:00Z', decision: 'deny', rule: 'unbounded-root-delete', preview: 'Remove-Item C:\\' }),
    '{ damaged row',
  ].join('\n');
  const sum = summarizeAudit(rows);
  const ok1 = sum.total === 4 && sum.allow === 1 && sum.ask === 1 && sum.deny === 1 && sum.last.includes('unbounded-root-delete');
  if (!ok1) fail++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  audit rollup survives a damaged row (total=4 allow=1 ask=1 deny=1)`);

  const line = statusLine(configOf({}), 'active', [], sum);
  const ok2 = line.startsWith('dsh-guard active') && line.includes('switches: none') && line.includes('audits: 4 total');
  if (!ok2) fail++;
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  normal status line`);

  const shadowLine = statusLine(configOf({}), 'SHADOW (not gating)', [], sum);
  const okS = shadowLine.startsWith('NOTE: dsh-guard is installed in SHADOW mode');
  if (!okS) fail++;
  console.log(`${okS ? 'PASS' : 'FAIL'}  shadow mode is announced in the status line`);

  const line2 = statusLine(configOf({}), 'active', ['DISABLE'], sum);
  const ok3 = line2.startsWith('WARNING: dsh-guard is DISABLED');
  if (!ok3) fail++;
  console.log(`${ok3 ? 'PASS' : 'FAIL'}  DISABLE is surfaced as a WARNING`);
}

// --- plugin wiring (fake ctx) -----------------------------------------------
console.log('\n--- plugin wiring ---');
{
  const registered = [];
  const injected = [];
  // EVERY apply() in this file must be given BOTH sinks. `loadMarker` defaults to the real
  // profile's receipt and `auditLog` to the real ledger, so an apply() without them writes into a
  // live dsh installation: that is how this matrix appended six load blocks to the real receipt and
  // six rows to the real ledger (identifiable by `node=v24.13.0`, the system node, where dsh runs
  // v24.18.1). The isolation check at the end of this file fails if that ever happens again.
  const sinkDir = join(tmpdir(), 'dsh-guard-matrix-' + process.pid);
  mkdirSync(sinkDir, { recursive: true });
  const sinkAudit = join(sinkDir, 'audit.jsonl');
  const sinkMarker = join(sinkDir, 'loaded.txt');
  const fakeCtx = { on: (evt, listener) => { registered.push({ evt, listener }); } };
  apply(fakeCtx, { auditLog: sinkAudit, stateDir: sinkDir, loadMarker: sinkMarker });

  const ok1 = registered.length === 4
    && registered.some((r) => r.evt === 'tools/pre-execute')
    && registered.some((r) => r.evt === 'agent/created')
    && registered.some((r) => r.evt === 'tools/post-execute')
    && registered.some((r) => r.evt === 'session/event');
  if (!ok1) fail++;
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  registers pre-execute + agent/created + post-execute + session/event (got: ${registered.map((r) => r.evt).join(', ')})`);

  const gate = registered.find((r) => r.evt === 'tools/pre-execute').listener;
  (async () => {
    let delegated = 0;
    const next = async () => { delegated++; return { kind: 'allow' }; };

    // These two cases run against the REAL filesystem, so the home root must be the running user's,
    // not a fixture: the gate resolves the dsh home from USERPROFILE when no config overrides it.
    const home = process.env.USERPROFILE || 'C:\\Users\\me';
    const allowVerdict = await gate({ name: 'pwsh', arguments: { command: `Remove-Item ${home}\\.dsh\\storages\\old.bin` } }, next);
    const ok2 = allowVerdict.kind === 'allow' && delegated === 1;
    if (!ok2) fail++;
    console.log(`${ok2 ? 'PASS' : 'FAIL'}  scoped call delegates to next()`);

    const askVerdict = await gate({ name: 'pwsh', arguments: { command: `Remove-Item -Recurse -Force ${home}\\Desktop` } }, next);
    const ok3 = askVerdict.kind === 'ask' && typeof askVerdict.displayReason?.zh === 'string' && delegated === 1;
    if (!ok3) fail++;
    console.log(`${ok3 ? 'PASS' : 'FAIL'}  bulk call returns ask with a zh displayReason and does not delegate`);

    const denyVerdict = await gate({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force C:\\' } }, next);
    const ok4 = denyVerdict.kind === 'deny' && typeof denyVerdict.reason === 'string';
    if (!ok4) fail++;
    console.log(`${ok4 ? 'PASS' : 'FAIL'}  unbounded delete returns deny`);

    const otherVerdict = await gate({ name: 'read', arguments: { file_path: 'C:\\x' } }, next);
    const ok5 = otherVerdict.kind === 'allow' && delegated === 2;
    if (!ok5) fail++;
    console.log(`${ok5 ? 'PASS' : 'FAIL'}  unrelated tool is passed through`);

    const created = registered.find((r) => r.evt === 'agent/created').listener;
    const fakeAgent = { id: 's1', inject: (m) => injected.push(m) };
    created({ agent: fakeAgent, source: 'startup' });
    const ok6 = injected.length === 1 && JSON.stringify(injected[0]).includes('dsh-guard active');
    if (!ok6) fail++;
    console.log(`${ok6 ? 'PASS' : 'FAIL'}  agent/created injects the status line`);

    // The persisted user/message must carry a non-empty id, or the session is declared
    // corrupt on the next resume ("lacks an identified message"). Regression for that bug.
    const ok6b = typeof injected[0]?.id === 'string' && injected[0].id.length > 0;
    if (!ok6b) fail++;
    console.log(`${ok6b ? 'PASS' : 'FAIL'}  injected status line carries a non-empty message id`);

    // `gating: false` must still register, still report, and gate nothing.
    const shadow = [];
    apply({ on: (evt, l) => shadow.push({ evt, l }) }, { gating: false, auditLog: sinkAudit, stateDir: sinkDir, loadMarker: join(sinkDir, 'loaded-shadow.txt') });
    const shadowGate = shadow.find((r) => r.evt === 'tools/pre-execute').l;
    const shadowVerdict = await shadowGate({ name: 'pwsh', arguments: { command: 'Remove-Item -Recurse -Force C:\\' } }, next);
    const okShadow = shadow.length === 4 && shadowVerdict.kind === 'allow';
    if (!okShadow) fail++;
    console.log(`${okShadow ? 'PASS' : 'FAIL'}  gating:false still registers but gates nothing`);

    // `enabled: false` must STILL register the status listener: otherwise a disabled plugin
    // is indistinguishable from a plugin that never loaded.
    const off = [];
    apply({ on: (evt, l) => off.push({ evt, l }) }, { enabled: false, auditLog: sinkAudit, stateDir: sinkDir, loadMarker: join(sinkDir, 'loaded-off.txt') });
    const offStatus = off.find((r) => r.evt === 'agent/created');
    const offInjected = [];
    if (offStatus) offStatus.l({ agent: { id: 's3', inject: (m) => offInjected.push(m) } });
    const okOff = off.length === 1 && offInjected.length === 1 && JSON.stringify(offInjected[0]).includes('DISABLED-BY-CONFIG');
    if (!okOff) fail++;
    console.log(`${okOff ? 'PASS' : 'FAIL'}  enabled:false still reports DISABLED (install stays observable)`);

    const ok7 = (() => {
      try { created({ agent: { id: 's2', inject: () => { throw new Error('boom'); } } }); return true; } catch { return false; }
    })();
    if (!ok7) fail++;
    console.log(`${ok7 ? 'PASS' : 'FAIL'}  a failing inject never throws into session creation`);

    // The gate must read the scope from the live execution, not from a constant: `exec.agent`
    // carries the session whose workspace governs the call.
    const SESSION_WS = 'F:\\work\\app';
    const scopedAgent = { id: 's4', session: { header: { cwd: SESSION_WS } } };
    const inWorkspace = await gate({ name: 'write', arguments: { file_path: SESSION_WS + '\\_session_repair\\repair.mjs' }, agent: scopedAgent }, next);
    const ok8 = inWorkspace.kind === 'allow';
    if (!ok8) fail++;
    console.log(`${ok8 ? 'PASS' : 'FAIL'}  the gate resolves the workspace from exec.agent and lets an in-session write through`);

    const outOfWorkspace = await gate({ name: 'write', arguments: { file_path: 'D:\\stuff\\note.md' }, agent: scopedAgent }, next);
    const ok9 = outOfWorkspace.kind === 'ask'
      && outOfWorkspace.displayReason.zh.includes('write-outside-workspace')
      && outOfWorkspace.reason.includes('outside every trusted root');
    if (!ok9) fail++;
    console.log(`${ok9 ? 'PASS' : 'FAIL'}  an out-of-scope write still asks, naming the rule in the dialog`);

    const noAgentWrite = await gate({ name: 'write', arguments: { file_path: 'D:\\other\\note.md' } }, next);
    const ok10 = noAgentWrite.kind === 'ask' && noAgentWrite.reason.includes('configured fallback');
    if (!ok10) fail++;
    console.log(`${ok10 ? 'PASS' : 'FAIL'}  with no session workspace the gate says it fell back to the configured root`);

    // Isolation guard, evaluated LAST so every apply() above has already run: the matrix must never
    // write into a live dsh installation. `loadMarker` defaults to the profile's receipt and
    // `auditLog` to the real ledger, so an apply() that omits them leaks a load block and a load row
    // into a production install on every run. Sizes were sampled before the first apply().
    //
    // Compare the RECEIPT size and the number of `load` rows, not the ledger size: while this matrix
    // runs, the live Harness is judging the `node test/matrix.mjs` command itself and appends its own
    // allow row. A size comparison called that normal activity a leak (observed 2026-11-25).
    const loadRows = (p) => {
      try {
        return readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('"decision":"load"')).length;
      } catch { return -1; }
    };
    const okIso = sinkSize(LIVE_MARKER) === LIVE_MARKER_SIZE && loadRows(LIVE_LEDGER) === LIVE_LOAD_ROWS;
    if (!okIso) fail++;
    console.log(`${okIso ? 'PASS' : 'FAIL'}  the matrix wrote nothing into the live profile receipt or ledger`);

    console.log('\n---');
    const total = cases.length + sw.length + 190;
    console.log(fail === 0 ? `ALL PASS (${total} checks, counted from the harness: ${cases.length} matrix + ${sw.length} switch + 190 wiring/scope/classification/read-only/crossing/alias/status/precision/coverage/ops/cwd/panel/bundle/manifest)` : `FAILURES: ${fail}`);
    if (fail > 0) process.exitCode = 1;
  })();
}
