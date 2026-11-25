// dsh-guard configuration: the shape of `<profile>/dsh-guard.json`, with defaults and a validator.
//
// `scripts/install.ps1` writes the JSON that the plugin loads through its patch entry, the plugin
// re-exports the same schema for dsh's settings UI, and `node scripts/validate-config.mjs` checks a
// file against it. Keeping one shape in one place is the point: a config field that only the
// installer knows about is a field nobody can validate.

/** Where the audit ledger and the emergency switches live, relative to dshHome. */
export const DEFAULT_STATE_DIRNAME = 'emergency';

/** Every field, its type, and what happens when it is absent. */
export const CONFIG_FIELDS = [
  {
    name: 'enabled',
    type: 'boolean',
    default: true,
    summary: 'Master switch. false keeps the load receipt and the status line but gates nothing.',
  },
  {
    name: 'gating',
    type: 'boolean',
    default: true,
    summary: 'Shadow mode when false: rules are evaluated and audited, but every call is allowed.',
  },
  {
    name: 'statusLine',
    type: 'true | false | "brief"',
    default: true,
    summary: 'Inject one line of guard state into each session when it is created.',
  },
  {
    name: 'askMode',
    type: '"ask" | "deny"',
    default: 'ask',
    summary:
      'What an escalation does: ask a human, or refuse with the same reason. Use "deny" where approvals are disabled — there an ask is auto-rejected in milliseconds and reads as an approval error.',
  },
  {
    name: 'workspace',
    type: 'string (absolute path)',
    default: '',
    summary:
      "FALLBACK ONLY. Each call is judged against its own session's cwd (SessionHeader.cwd); this value applies only when a session exposes none.",
  },
  {
    name: 'dshHome',
    type: 'string (absolute path)',
    default: '$USERPROFILE\\.dsh',
    summary: 'The dsh home directory. Drives stateDir, auditLog and loadMarker defaults.',
  },
  {
    name: 'stateDir',
    type: 'string (absolute path)',
    default: '<dshHome>\\emergency',
    summary: 'Where the DISABLE / PANIC / HARD-STOP switches are looked for.',
  },
  {
    name: 'auditLog',
    type: 'string (absolute path)',
    default: '<stateDir>\\guard-audit.jsonl',
    summary: 'Append-only JSONL ledger of every judgement.',
  },
  {
    name: 'loadMarker',
    type: 'string (absolute path)',
    default: '',
    summary:
      'Load receipt appended on every apply(). Its existence answers "did the loader accept this entry?". The status-route trace is written beside it.',
  },
  {
    name: 'protectedRoots',
    type: 'array of absolute paths',
    default: ['C:\\Users\\<you>', 'C:\\'],
    summary: 'Roots where anything beyond a directly named single file is mass scope.',
  },
  {
    name: 'additionalRoots',
    type: 'array of absolute paths',
    default: [],
    summary:
      'Extra trusted roots for work spread across several projects in one session. Widens "inside"; weakens no rule.',
  },
  {
    name: 'statusLine',
    type: 'true | false | "brief"',
    default: true,
    summary:
      'Session line. "brief" keeps posture/workspace/switches and drops the counters (saves ~70 tokens per session).',
  },
  {
    name: 'auditMaxBytes',
    type: 'integer',
    default: 8000000,
    summary: 'Rotate the ledger at this size (a rotation row is written). 34 KB/day unbounded is ~12 MB/year.',
  },
  {
    name: 'auditKeep',
    type: 'integer',
    default: 3,
    summary: 'Rotated ledger copies to keep (guard-audit.jsonl.1 … .N).',
  },
  {
    name: 'loadMarkerKeep',
    type: 'integer',
    default: 20,
    summary: 'Load-receipt blocks to keep (one block per apply()).',
  },
  {
    name: 'rememberApproved',
    type: '{ enabled, ttlSeconds }',
    default: { enabled: false, ttlSeconds: 900 },
    summary:
      'Opt-in: remember an escalation that was approved AND executed, keyed by exact command + scope, for a short TTL. Off by default.',
  },
  {
    name: 'extraGatedTools',
    type: 'array of tool names',
    default: [],
    summary:
      'Tools beyond pwsh/write/edit that get the scope check (e.g. run_code). A mutating-looking tool that is not listed is recorded once as untracked-tool.',
  },
  {
    name: 'outcomesKeep',
    type: 'integer',
    default: 1000,
    summary: 'Approval outcomes kept in guard-outcomes.json (the 24h panel ring).',
  },
  {
    name: 'publicBaseUrl',
    type: 'string',
    default: '',
    summary: 'Optional override for the URL the status page prints; by default it uses the Host header of the request.',
  },
  {
    name: 'emergencySwitches',
    type: 'array of switch names',
    default: [],
    summary:
      'Switch files the installer should pre-create in stateDir: DISABLE (gate off), PANIC (hard denies become questions), HARD-STOP (questions become denies).',
  },
];

/** One-line description of each field, for `--help`, `-Status`, and the README tables. */
export function describeConfigFields() {
  return CONFIG_FIELDS.map((f) => ({
    name: f.name,
    type: f.type,
    default: Array.isArray(f.default) ? f.default.join(', ') : String(f.default),
    summary: f.summary,
  }));
}

/**
 * Fill a raw config object with defaults. Mirrors the plugin's own `configOf`, so a value that
 * validates here behaves the same way once the plugin loads it.
 * @param {object} raw
 * @param {{home?: string}} [env]
 */
export function withDefaults(raw, env) {
  const home = (env && env.home) || process.env.USERPROFILE || process.env.HOME || '';
  const out = { ...(raw || {}) };
  if (typeof out.dshHome !== 'string' || out.dshHome === '') out.dshHome = home ? home + '\\.dsh' : '';
  if (typeof out.stateDir !== 'string' || out.stateDir === '') {
    out.stateDir = out.dshHome ? out.dshHome + '\\' + DEFAULT_STATE_DIRNAME : '';
  }
  if (typeof out.auditLog !== 'string' || out.auditLog === '') {
    out.auditLog = out.stateDir ? out.stateDir + '\\guard-audit.jsonl' : '';
  }
  if (typeof out.workspace !== 'string') out.workspace = '';
  if (typeof out.enabled !== 'boolean') out.enabled = true;
  if (typeof out.gating !== 'boolean') out.gating = true;
  if (out.statusLine !== false && out.statusLine !== 'brief') out.statusLine = true;
  out.askMode = out.askMode === 'deny' ? 'deny' : 'ask';
  if (!Array.isArray(out.protectedRoots)) out.protectedRoots = [];
  if (!Array.isArray(out.additionalRoots)) out.additionalRoots = [];
  if (!Array.isArray(out.extraGatedTools)) out.extraGatedTools = [];
  if (!Number.isFinite(out.auditMaxBytes) || out.auditMaxBytes <= 0) out.auditMaxBytes = 8000000;
  if (!Number.isInteger(out.auditKeep) || out.auditKeep < 0) out.auditKeep = 3;
  if (!Number.isInteger(out.loadMarkerKeep) || out.loadMarkerKeep < 1) out.loadMarkerKeep = 20;
  if (!Number.isInteger(out.outcomesKeep) || out.outcomesKeep < 10) out.outcomesKeep = 1000;
  const ra = out.rememberApproved && typeof out.rememberApproved === 'object' ? out.rememberApproved : {};
  out.rememberApproved = {
    enabled: ra.enabled === true,
    ttlSeconds: Number.isFinite(ra.ttlSeconds) && ra.ttlSeconds > 0 ? Math.floor(ra.ttlSeconds) : 900,
  };
  if (typeof out.publicBaseUrl !== 'string') out.publicBaseUrl = '';
  return out;
}

/** @returns {{ ok: boolean, problems: string[], config: object }} */
export function validateConfig(raw, env) {
  const problems = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['config must be a JSON object'], config: withDefaults({}, env) };
  }
  const known = new Set(CONFIG_FIELDS.map((f) => f.name));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) problems.push('unknown field "' + key + '" (it would be ignored)');
  }
  for (const name of ['enabled', 'gating']) {
    if (raw[name] !== undefined && typeof raw[name] !== 'boolean') problems.push(name + ' must be a boolean');
  }
  if (raw.askMode !== undefined && raw.askMode !== 'ask' && raw.askMode !== 'deny') {
    problems.push('askMode must be "ask" or "deny"');
  }
  if (raw.statusLine !== undefined && typeof raw.statusLine !== 'boolean' && raw.statusLine !== 'brief' && raw.statusLine !== 'full') {
    problems.push('statusLine must be true, false, "full" or "brief"');
  }
  if (raw.protectedRoots !== undefined) {
    if (!Array.isArray(raw.protectedRoots) || raw.protectedRoots.some((r) => typeof r !== 'string')) {
      problems.push('protectedRoots must be an array of strings');
    }
  }
  for (const name of ['additionalRoots', 'extraGatedTools']) {
    if (raw[name] !== undefined && (!Array.isArray(raw[name]) || raw[name].some((r) => typeof r !== 'string'))) {
      problems.push(name + ' must be an array of strings');
    }
  }
  for (const name of ['auditMaxBytes', 'auditKeep', 'loadMarkerKeep', 'outcomesKeep']) {
    if (raw[name] !== undefined && !Number.isFinite(raw[name])) problems.push(name + ' must be a number');
  }
  if (raw.rememberApproved !== undefined && (typeof raw.rememberApproved !== 'object' || raw.rememberApproved === null || Array.isArray(raw.rememberApproved))) {
    problems.push('rememberApproved must be an object { enabled, ttlSeconds }');
  }
  for (const name of ['workspace', 'dshHome', 'stateDir', 'auditLog', 'loadMarker']) {
    const value = raw[name];
    if (value === undefined) continue;
    if (typeof value !== 'string') { problems.push(name + ' must be a string'); continue; }
    if (value !== '' && name !== 'loadMarker' && !isAbsolute(value)) {
      problems.push(name + ' must be an absolute path, got "' + value + '"');
    }
  }
  return { ok: problems.length === 0, problems, config: withDefaults(raw, env) };
}

/** Windows (`C:\x`, `\\server\share`) or posix (`/x`). */
export function isAbsolute(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const s = value.trim();
  return /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s) || /^\//.test(s);
}
