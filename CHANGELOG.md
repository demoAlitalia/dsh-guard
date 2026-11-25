# Changelog

All notable changes to dsh-guard. Versions follow [Semantic Versioning](https://semver.org/); the
plugin's own version appears in the `install.ps1` banner and in `-Status` output.

## 0.7.0 — 2026-11-25

The noise fixes quantified from 104 live gate asks (2.38% of judged calls): 28 came from POSIX paths
inside ssh/scp payloads, 11 from `.ssh` keys, 5 from a browser executable, 10 from extracting into a
fresh directory.

### Added — classification

- **Remote payloads are remote.** When a command hands work to `ssh` / `sshpass` / `scp` / `sftp` /
  `plink` / `Invoke-Command` / `Enter-PSSession` / `wsl`, POSIX paths in its quoted or here-string
  payload no longer count as local outside targets. A payload that *deletes or rewrites* still asks,
  once, as `remote-command` — the reason now says "remote host" instead of "outside this workspace".
- **Read-only external paths**: a credential (`.ssh\…`, `id_ed25519|rsa|ecdsa`) or an executable
  (`.exe`) is not a write target, so using a deploy key or a headless browser asks nothing.
- **Benign sinks**: `/dev/null`, `NUL`, `$null` are never targets.
- **Archive destinations**: `Expand-Archive` (and `-Destination`) asks only when the destination
  already holds something. A missing or provably empty destination is not an overwrite.
- **`askMode`** (`"ask"` | `"deny"`): where approvals are disabled, an ask is auto-rejected in
  milliseconds and reads as an approval error; `"deny"` refuses with the same reason and a clear
  `askMode=deny` note. Exposed in the settings section (and through the config action), and shown in
  the status report's `config.effective`.

### Fixed

- The settings section now edits `additionalRoots` and `extraGatedTools` as comma-separated lists, so
  a project outside the session workspace can be trusted without hand-editing JSON.

### Tests

9 new checks (229 → **238**): destructive ssh payload (remote-command, no external target), read-only
ssh payload, credential path, external executable, `/dev/null`, empty-destination extraction, an
existing-directory extraction that still asks, and both `askMode` behaviours through the real gate.
The archive case that used to expect `ask` now asserts `allow` for a new destination plus a separate
`ask` case for an existing one.

## 0.6.1 — 2026-11-25

Found by reading the live install after six days of use (6 366 ledger rows, 101 gate asks).

### Fixed — the audit clocks were UTC with no label

The ledger stores `ts` as a UTC ISO string (`…T15:37:47Z`). The settings section rendered
`ts.slice(11,19)`, i.e. the UTC clock face, so a 23:37 local event appeared as 15:37 — eight hours
behind in UTC+8, with nothing saying so. The section and `status.ps1` now format the timestamp in the
**viewer's** timezone and label the column/card as local time.

### Fixed — PANIC-prefixed escalations were invisible to the panel

`approval/asked` carries `[PANIC MODE] dsh-guard ASK [rule]: …` when PANIC is active, and the
outcome ring filtered with `reason.startsWith('dsh-guard')` — so exactly the PANIC escalations were
dropped (81 of 243 measured) and their rules were parsed as `PANIC MODE`. The filter now matches
anywhere in the reason, and `rulesFromReason` locates the `dsh-guard ASK|DENY [ … ]` tag first.

### Fixed — the panel could not tell "no answerer" from "the human said no"

Measured: 81 gate asks were rejected **within 50 ms**, all PANIC ones — this build fails closed when
no answerer is attached, so those asks were silent blocks, not human rejections; the other 162
reached a human (median 10.8 s). Each outcome now records `latencyMs` and a `panic` flag, the panel
shows `autoRejected`, and it explains that a window with gate asks but no answered ask means the calls
did not run. The status report also gained `audit.window` (24 h allow/ask/deny straight from the
ledger), so the gate's own asks stay visible even when no answerer exists.

### Fixed — a linked bundle put its config and receipt in the repository

`plugin_manager` installs a local package directory by **linking** it, so `import.meta.url` points at
the source checkout, and the module-derived profile path resolved to `<project>\lib`. The settings
section therefore reported `config.file = F:\…\dsh-guard\lib\dsh-guard.json`, and the load receipt was
written there. `apply()` now resolves the profile once: an installed package uses its module path, a
linked one scans `<dshHome>\profiles\*\package.json` for the profile that declares this bundle (the
host exports no profile path to plugin code), and `DSH_PROFILE_DIR` remains a fallback.

### Tests

6 new checks (223 → **229**): PANIC-prefixed rule parsing, the ledger's 24 h window separate from the
last-200 rollup, the sub-50 ms `autoRejected` classification, a PANIC ask recorded with its real rule,
flag and latency, and both profile-location paths. The isolation guard now counts `load` rows instead
of comparing file sizes, because the live Harness appends its own allow row for the matrix command
itself (a false positive observed on this run).

## 0.6.0 — 2026-11-19

### Added — the package is now a DSH bundle with a settings section

- **Bundle form.** `package.json` declares `dsh.bundle.patch` (the package's own `cordis.patch.yml`)
  and `dsh.client` (`platform: web`, injects `@deepseek-ai/dsh-client-ui-settings`). Installed with
  `plugin_manager` `install_bundle` against the package directory; it then appears in **Plugins**
  with a title, description, icon and detail page, and can be enabled, disabled or removed there.
- **Hand-written client half** (`client/client.js`, no build step): registers the
  **Settings → dsh-guard 闸门** section. It shows posture, the judged sessions and their current
  directories, the 24-hour approval panel with rejected-by-rule, lifetime totals, the audit tail,
  and the emergency-switch controls; it can write `statusLine`, `gating` and `rememberApproved` to
  `dsh-guard.json`.
- **Display resources**: `locale/en.json` and `locale/zh.json` (`meta.title`, `meta.description`,
  `meta.detail`), an original 36×36 shield icon, and `docs/DETAIL.md` as the bundle's detail page.
- **Zero-config bundle row**: the patch carries no machine paths. The host exports `DSH_PROFILE_DIR`,
  so the plugin discovers `<profile>\dsh-guard.json` and derives its load receipt from the same value.
- **`POST /dsh-guard/action`** backs the section: `{kind: "switch"}` creates or removes a
  DISABLE/PANIC/HARD-STOP file (immediate), `{kind: "config"}` merges an allow-listed subset into the
  settings file (restart). Unknown keys/kinds/switches are refused.
- **`audit.recent`** in the status report: the newest 12 ledger rows, for the section's tail.
- The two export forms are no longer mixed: the Host plugin exports `apply` (plus `name`) only.

### Fixed — the discovery source

The first bundle build discovered `<profile>\dsh-guard.json` from `DSH_PROFILE_DIR`, which the docs
guarantee only for **shell** calls. The host process that imports a plugin does not necessarily export
it — measured on 2026-11-19: the bundle applied with no env var, so it never read the settings file and
never wrote its load receipt (the status page showed no `config`, the receipt mtime did not move). The
profile directory is now derived from the module's own URL (`<profile>\node_modules\<pkg>\lib\index.mjs`
→ `<profile>`; a legacy loose `.mjs` → its own directory), with the env var kept only as a fallback.

### Migration

The legacy profile-local mode (a loose `.mjs` copied next to `cordis.patch.yml`, row id
`guard-native`) is superseded. `scripts/install.ps1 -Uninstall` removes it; running both would gate
every call twice. The audit ledger, emergency switches and `guard-outcomes.json` are untouched.

### Tests

11 new manifest self-checks (210 → **221**): bundle patch presence and portable content, client
factory id equals the package name, `dsh.client`/exports/files completeness, both locale files, the
detail document path, and the icon format/size. The suite now also guards the package metadata from
drifting.

## 0.5.0 — 2026-11-19

### Added — the 24h approval panel (precision, permanently observable)

The guard already recorded that it *asked*; it never recorded how the human *answered*, so "how often
is the gate wrong?" could only be measured by hand-joining the ledger with session logs (the 0.2.0
analysis did exactly that, 135/135 by timestamp). `approval/asked` and `approval/decided` are session
events, so the plugin now listens on `session/event` and pairs them **by approval id** — exact.

- Outcomes are attributed to their rules (parsed from the approval reason) and persisted to
  `<stateDir>\guard-outcomes.json` (a ring, `outcomesKeep` = 1000), so the panel survives restarts.
- A second `approval/asked` for the same id (hot reload, retry) does **not** downgrade a decided row
  back to pending — that bug was caught by the new test before it shipped.
- Surfaces: the status page shows `approvals (last 24h)` with counts, approval rate, rejected-by-rule
  and asked-by-rule; `status.ps1` prints the same block; `?format=json` carries it as `approvals`.
- Non-guard approvals (any other plugin's questions) are ignored.

### Tests

9 new checks (187 → **196**): `rulesFromReason`, window counting (approved/rejected/pending, older
rows dropped), approval rate, rejected-by-rule, live pairing through `session/event`, non-guard
events ignored, duplicate-id dedup that keeps the decision, the report/HTML block, and the ring cap.

## 0.4.0 — 2026-11-19

### Fixed — the working directory vs. the workspace root (P1-7)

`Session.header.cwd` is the session's **origin and permission root**; `working_directory` /
`create_worktree` change a *different* thing — the session's **current directory**, kept by the
`workingDirectory` service and recorded as a `working-directory/change` event. The guard only read the
header, so after a `cd` it judged relative targets against the wrong directory:

- `cd C:\Users\me` then `Remove-Item -Recurse .\*` carried **no absolute token at all**, so no scope
  rule could fire while the real target was inside a protected root. That is now `ask`
  (`relative-target-in-protected-root`).
- A mutation attempted after the session moved outside every trusted root is now `ask`
  (`cwd-outside-workspace`), because a relative target cannot be scoped at all.
- The plugin now injects the optional `workingDirectory` service (readiness-safe, like `webServer`)
  and resolves dot-relative write targets (`.`, `.\x`, `..\y`) against the live directory.
- The live directory is recorded per audit row (`cwd`) and shown by the status line only when it
  differs from the origin (`… | cwd: D:\other`), so a moved session is visible without lengthening the
  common case.

`inside` is deliberately **unchanged**: the current directory is where commands run, not a permission
root, and the sandbox's writable roots stay fixed to the header. Adding it to `inside` would have
silently allowed writes the sandbox refuses.

### Fixed — DENY rules matched words, not commands

`format-volume` was `/\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i`, so the WORD anywhere in a
command was a denial. Observed while editing documentation: a `-replace '…format-volume…'` was denied
as a disk format. All three DENY patterns are now anchored to command position
(`(?:^|[\s;&|])`), which keeps a real invocation denied (including after `;`) while a quoted literal
passes.

### Tests

12 new checks (175 → **187**): four `resolveRelative`/`relativeTargetsOf` units, the protected-root
relative delete, the same inside the workspace (must not fire), the outside-cwd relative write, a
`write` with a relative `file_path`, and four DENY-anchoring shapes (start, after `;`, quoted pattern,
doc edit).

## 0.3.0 — 2026-11-19

The P1/P2 items from `docs/OPTIMIZATION.md`. Every option below is opt-in except the two that only
remove friction or bound growth (`statusLine: "brief"` is a mode you choose; rotation and the receipt
cap are on with a large default).

### Added — coverage

- **`plugin_manager` is gated.** `install_bundle` / `remove_bundle` / `set_bundle` / `set_plugin` /
  `set_version_exemption` always ask with the new `plugin-install` rule, because they change the code
  dsh loads at its **next** launch — more durable than any single deletion. Inventory reads still pass.
- **`extraGatedTools`.** A tool the guard does not know (e.g. `run_code`) can be given the same
  scope check as `write`, via config, without a release. A tool whose name looks mutating but is not
  gated is recorded **once per process** as `untracked-tool`, so an upgrade that introduces a new
  mutating tool is visible in the ledger instead of silent.

### Added — fewer prompts, on request

- **`additionalRoots`.** Extra trusted roots for sessions that span several projects. Evidence: three
  workspaces (`Nad-Net` 1466, `dsh` 191, `ZeroPanel` 41) and 89 `external-path-target` hits.
- **`rememberApproved` (opt-in, default off).** Remembers an exact command + scope after it was
  approved **and actually executed** — observed through `tools/post-execute`, never on the strength of
  an `ask`, because the model may retry a command the user rejected. Keys are in-process and expire
  after `ttlSeconds` (default 900). Evidence: 21 distinct commands produced 63 asks (47% of all asks).
- **PowerShell dry runs pass.** `-WhatIf` on a cmdlet that genuinely honours it (`Remove-Item`,
  `Set-Content`, `Format-Volume`, …) is `allow` with rule `dry-run`. Native tools and `cmd /c` are
  excluded on purpose: a flag they ignore must not be able to hide a real command.

### Added — operations

- **Ledger rotation.** `auditMaxBytes` (8 MB) with `auditKeep` (3) copies; a `rotation` row is written
  into the fresh file. Evidence: 34 KB/day, 1.2 MB after 35 days, no bound.
- **Status page URL follows the request.** The page and `status.ps1` now use the Host header /
  `DSH_WEB_URL` instead of `127.0.0.1:19387`; dsh changed ports three times in one afternoon
  (`19387 → 64794 → 60939`), so the old hardcoded URL was already dead.
- **Load receipt is capped** at `loadMarkerKeep` blocks (20) instead of growing one block per apply().
- **`statusLine: "brief"`.** Posture + workspace + switches without the counters, ~120 chars instead
  of ~430. The full text remains available with `statusLine: true`.

### Fixed

- `ConvertTo-JsonBool` was used before its definition, so `install.ps1` threw on the default path
  (only the `-StatusLine brief` path avoided it). The helper now sits with the other section-1 helpers.
- `DEFAULTS.workspace` still carried the retired `…\ZeroPanel` constant; it is now empty by design.

### Tests

24 new checks (151 → **175**): additionalRoots for write and edit, three dry-run shapes, plugin
install/inventory/hard-stop, extraGatedTools in and out of scope, brief vs full status line, ledger
rotation + marker row, receipt cap, approval memory in five states (disabled, first, pre-settlement,
post-settlement, audit row), untracked-tool once-per-process, and the Host-derived page URL.

## 0.2.0 — 2026-11-19

Measured from 35 days of live operation: 1859 ledger rows joined with 135 human approval decisions
(`docs/OPTIMIZATION.md`). Four precision/coverage defects were fixed, each with a regression built from
the command that caused it.

### Fixed

- **Read-side wildcards made a single-file write "mass".** `Get-ChildItem releases\adnet-v*.zip | … |
  Set-Content releases\SHA256SUMS.txt` writes ONE file, but the wildcard in the enumeration made the
  whole call `overwrite-mass` (rejected by the user, live ledger `2026-11-10T10:21:13Z`). Scope is now
  decided by the **write-side operands**: the command is split into statement/pipeline segments, the
  segments containing a mutating verb own wildcard and multi-target scope, and `ps-mass-pipeline` now
  covers only cmdlets that consume the piped items as *targets* (delete/move/copy), not
  `Set-Content`/`Out-File` where the piped text is the *content*.
- **Rules leaked across statement separators.** `ps-wildcard-write` and `ps-recursive-delete` used
  `[^\r\n|]*`, so `Remove-Item one.py; Get-ChildItem -Filter '_tmp*'` attributed the second statement's
  read-side wildcard to the first statement's delete (live `2026-10-16T08:47:27Z`). Both now stop at
  `;` and `&` as well.
- **POSIX phantoms from code path expressions.** `root/"releases"/f"{stem}.zip"` produced the "outside
  targets" `/f` and `/stem`, escalating three packaging runs on 2026-11-10. A POSIX-looking token is now
  a filesystem target only when it names a real Unix top-level root (`/etc`, `/tmp`, `/home`, …); on
  Windows `pwsh` there are no POSIX absolute paths, so the accidents are ignored. Real Unix paths still
  escalate.
- **Doubled backslashes were read as a different path.** A command whose script text contains
  `'C:\\Users\\me\\.dsh\\…'` (how a path looks inside a JS/JSON literal) reported the same file as
  "outside every trusted root" — 26 such rows, the most recent `2026-11-19T07:25:05Z`. `normalize()`
  now folds repeated backslashes while preserving the two prefixes where a leading pair is meaningful
  (`\\server\share` UNC and `\\?\` long paths).
- **`edit` was not gated at all**, although it is the most frequent mutation in real use (1202 calls vs
  88 `write` calls in 35 days) and can touch files outside the session workspace. `edit` is now gated
  by **scope only**: an in-workspace single file stays silent (`edit-outside-workspace`,
  `edit-in-protected-root`, `edit-wildcard-target`, `edit-without-path` otherwise).

### Added

- **`callId` in every audit row**, so an escalation can be joined with `approval/asked` →
  `approval/decided` exactly instead of by timestamp proximity. This is what makes "was this escalation
  approved or rejected?" — i.e. precision — measurable from the guard's own record.
- Exported `commandSegments()` / `writeSegmentsOf()` / `POSIX_TARGET` for tests and tooling.
- Ten regression checks built from the live commands above (141 → **151** checks).

## 0.1.0 — 2026-10-16

First packaged release. The gate itself had been running in a live dsh profile since 2026-10-15; this
release turns it into an installable, configurable, updatable project and records the defects the live
runs exposed.

### Added

- **Standalone project layout**: `lib/index.mjs` (the whole plugin, one dependency-free ESM module),
  `config.schema.mjs` (config shape + validator), `scripts/`, `test/`, `docs/`.
- **`scripts/install.ps1`** — install / update / `-Status` / `-Uninstall` for any profile:
  - copies the module and writes `dsh-guard.json`, then records one inline-configured entry in
    `cordis.patch.yml` (relative specifier, which is the form this loader loads);
  - idempotent (re-running updates the same entry), backs up the patch file and module first,
    validates what it wrote (hash, entry presence, JSON parse, patch structure) and runs the offline
    matrix when Node is available;
  - prints exact rollback commands; `-DryRun` writes nothing.
- **`scripts/install.cmd`** for `cmd.exe`.
- **`scripts/status.ps1`** — read-only on-demand report (`-Json` for machine reading), including a
  deployed-vs-source hash comparison.
- **`scripts/sync-source.mjs`** — explicit `--check` / `--write` between this tree and the development
  workspace, so two copies of the rule table cannot drift silently.
- **Config surface**: every knob documented, mirrored into `dsh-guard.json`, exposed to dsh's settings
  UI through an exported `~standard` schema, and validated by `config.schema.mjs`.
- **`configFile` support**: the patch entry may reference a JSON config file; inline fields win
  field by field, and an unreadable file degrades to the inline values instead of failing the load.
- **On-demand status page** at `/dsh-guard/status` (`?format=json`), registered through
  `ctx.inject(['webServer'], …)` so it neither races service readiness nor throws without a web carrier.
- **Bilingual documentation**: `README.md` (reference) and `README.zh.md` (Chinese), plus
  `docs/ARCHITECTURE.md`.

### Fixed

Defects found by running the gate against real sessions. Each one is pinned by a regression test.

- **The scope was a constant.** Every call was judged against the configured `workspace` instead of the
  session's own cwd, so an ordinary single-file write inside a *different* project's session was
  escalated as "a bulk destructive operation". Scope now resolves per session
  (`exec.agent.session.header.cwd`, cached per agent); the configured value is a documented fallback,
  and the dialog names both the root and its provenance.
- **Read-only commands were escalated.** The scope rules `wildcard-target` and `multiple-path-targets`
  fired regardless of whether the command could mutate anything, so public read patterns
  (`Get-Item a, b`, `Get-ChildItem -Recurse -Filter *.json | Select-Object -First 3`) asked for
  approval. All scope rules now share one mutation predicate, and `MUTATING_VERB` was widened to every
  wildcard/array-taking cmdlet.
- **Aliases widened scope.** `\bmd\b` matched the extension in `README.md`, classifying a wildcard
  **read** as "BULK CREATES"; `\bri\b` matched inside ordinary identifiers. Scope now uses full cmdlets
  only; aliases are boundary-anchored (`(?<=^|[\s;&|])name(?=\s|$)`) and used for classification only.
- **A path was scanned as a command line.** `D:\stuff\note.md` was classified as a *create* because of
  the `md` in the name. `write` is now classified by what is on disk: creation vs overwrite.
- **Phantom `posix` paths out of prose and URLs.** `'approval/asked'` produced an outside target
  `/asked`; `(/json|zstd/)` produced `/json|zstd/`; `</body></html>` produced `/body>`; `-join " / "`
  produced the root `/`; and fetching the guard's **own status page**
  (`http://127.0.0.1:19387/dsh-guard/status?format=json`) produced
  `p://127.0.0.1:19387/...` plus a wildcard hit from the `?`. All are filtered, with a regression test
  each, while real paths (`/etc/hosts`, `2>/dev/null`, `C:/Users/...`) still register.
- **Forward-slash Windows paths and script file APIs produced no signal.** `C:/Users/...` yielded no
  path token at all (scope checking silently skipped), and `node -e "fs.writeFileSync(...)"` carried no
  recognised verb. Both are now detected.
- **The sandbox-bypass floor missed its own case.** It compared the action against `'copy'` while the
  verb table classifies `Copy-Item`/`cp`/`mv` as `context`, so the floor matched nothing — through a
  test run that looked green because the assertion used the same wrong name. The floor now covers
  delete, overwrite, create, extract, attribute, disk, `copy` and `context`, and every escalation test
  asserts a baseline-vs-escalated transition instead of a single verdict.
- **A `deny` read like a question.** The decision line was chosen by testing whether the label started
  with `DENY`, which it never did (the label is `dsh-guard DENY [...]`), so a hard deny told the reader
  "the call has NOT run; approve only if you intend this scope". The kind is now passed explicitly.
- **The status script mis-reported the ledger.** Windows PowerShell 5.1 decoded the UTF-8 ledger with
  the ANSI code page, the mangled lines failed `ConvertFrom-Json`, and the catch dropped them silently:
  222 rows and `deny=0` were reported for a 266-row ledger containing 2 denies. Reads are now explicit
  UTF-8 and dropped rows are counted and printed.
- **The status page route 404'd.** It was registered with a one-shot `ctx.get('webServer')` at `apply()`
  time, before the service existed, inside a `try/catch` that swallowed the result. It now registers
  through `ctx.inject(['webServer'], cb)`, and a refused registration is written to
  `dsh-guard-native-status-route.txt`.

### Notes

- The gate deliberately has **no allow-list**: approvals are per call.
- `HARD-STOP` denies the bypass floor too; `DISABLE` remains the human's own off-button and always
  wins.
- Rule text that merely *quotes* a denied pattern (for example a test command containing `rm -rf /`)
  is itself denied. That is a consequence of matching text, documented rather than worked around.
