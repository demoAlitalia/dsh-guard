# dsh-guard

A **semantic gate in front of the sandbox** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It inspects every `pwsh` and `write` tool call *before it runs*, classifies it, and escalates the ones
that are worth a human's attention — bulk deletes, traversal, mass writes, and anything aimed outside
the session's own workspace. Reads ask nothing. A directly named single file inside the workspace asks
nothing. Everything it decides is written to an append-only ledger, and the panel shows one classified
sentence instead of a wall of rule names.

```
dsh-guard ASK [ps-recursive-delete, external-path-target]: BULK DELETES paths OUTSIDE this project workspace
  - 摘要: 批量删除（本工作区外）
  - decision: the call has NOT run; approve only if you intend exactly this scope.
  - workspace: F:\work\my-project (this session's own workspace root)
  - rule: ps-recursive-delete -- PowerShell recursive delete (-Recurse / -r)
  - rule: external-path-target -- a destructive verb aimed at a path outside every trusted root of this session
  - target: Remove-Item -Recurse -Force C:\Users\me\Desktop
```

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install](#install)
- [Verify the install](#verify-the-install)
- [Configuration](#configuration)
- [Using it](#using-it)
- [What you can observe](#what-you-can-observe)
- [Emergency switches](#emergency-switches)
- [How the gate decides](#how-the-gate-decides)
- [Update and uninstall](#update-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [Honest limits](#honest-limits)
- [Development](#development)

---

## What it does

| Behaviour | Detail |
|---|---|
| **Reads never escalate** | A command with no mutating verb passes through, wildcards or not: `Get-Item a, b`, `Get-ChildItem -Recurse -Filter *.json \| Select-Object -First 3`, `git status`, `rg`. |
| **Single in-workspace targets pass** | `Remove-Item .\out\old.js`, `write` to a file inside the session workspace. |
| **Bulk / traversal / mass scope asks** | Recursive deletes, wildcard targets, pipelines feeding a modifying cmdlet, recursive copies, archive extraction, whole-tree git rollbacks, indirect execution (`cmd /c`, `Invoke-Expression`, `wsl`), and multiple real targets. |
| **Outside the workspace asks** | Any destructive verb whose target is outside the session workspace (and outside the dsh home / state dir). |
| **Unbounded targets are denied** | Deleting a drive root, `rm -rf /`, `Format-Volume` / `Clear-Disk`. |
| **The sandbox bypass floor** | A call carrying `sandbox_permissions` (the platform's "let the sandbox stand down for this one call" escalation) is escalated when it is a *crossing*: a deletion, or a mass rewrite. A single in-workspace write or a read with that field is still allowed. |
| **Every judgement is recorded** | One JSONL row per call: decision, matched rules, action class, mass flag, scope, the workspace root used, targets outside it, the requested sandbox escalation, and the model's own justification. |

The gate sits on `tools/pre-execute`, which `dsh-tools` runs **before** the sandbox policy and the
approval policy are resolved. It therefore does not care which Permissions preset you chose
(`read-only` / `workspace-write` / `danger-full-access`): the plugin never reads the mode. What can
change its behaviour is only the plugin's own configuration and the three emergency switches below.

## Requirements

| | |
|---|---|
| dsh | A profile that composes `@deepseek-ai/dsh-tools` and the Windows `pwsh` executor (`@deepseek-ai/dsh-pwsh-sandbox`). The shipped `desktop` profile does. |
| OS | Windows (the rules cover PowerShell and cmd syntax; the installer is PowerShell). |
| Node | Only for the offline test matrix and `scripts/sync-source.mjs`. **The plugin itself imports nothing outside the Node standard library.** |
| Privileges | Write access to `%USERPROFILE%\.dsh\profiles\<profile>\`. Nothing else. |

> **Why the profile-local install is a script and not an agent action.** The profile directory is
> outside a dsh session's file sandbox, so a dsh session cannot write the plugin there — the sandbox
> refuses it before the guard is even consulted. The npm install goes through DSH's own plugin manager
> and does not have that limitation; run the script installer from a normal terminal.

## Install

### From npm (recommended)

The package is published as `dsh-guard-native`. In DSH, open **Plugins → Add plugin**, enter the package
name, and confirm; or run `dsh plugin --profile desktop add dsh-guard-native` from a terminal. Restart
DSH afterwards. It installs as an ordinary bundle: the package joins `dsh.profile.bundles`, the loader
applies its `cordis.patch.yml`, and the client half is served as `/plugins/dsh-guard-native/client.js`.
There is no build step. Windows only: it gates the `pwsh` executor.

To browse community indexes instead, enable
**Plugins → Experimental plugins → Custom plugin indexes**, open **Discover → Add index source**, and add
the index you trust (for example the Open Plugin Market index `https://dshopen.org/index.json`).

### From a source checkout

Install this package directory with the harness's own installer — `plugin_manager` `install_bundle`
against its absolute path:

```
plugin_manager  action: install_bundle  target: <absolute path to this package>
```

That links the package into the profile, adds `dsh-guard-native` to `dsh.profile.bundles`, and enables
it. It then shows up in **Plugins** with a title, description, icon, detail page, and an
enable/disable/remove control, plus a **Settings → dsh-guard 闸门** section. The client half is served
by the host as `/plugins/dsh-guard-native/client.js`; there is no build step.

Do not keep the legacy row (`guard-native`) at the same time: two instances would gate every call
twice. `scripts/install.ps1 -Uninstall` removes the legacy mode; the ledger, the switches and the
approval history are untouched.

### As a profile-local file (no package install)

```powershell
# from the project root, in a normal (non-dsh) PowerShell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

or double-click style from `cmd.exe`:

```bat
scripts\install.cmd
```

What it does, in order:

1. Resolves the profile (`%USERPROFILE%\.dsh\profiles\desktop` by default; override with `-ProfileDir`).
2. Copies `lib\index.mjs` → `<profile>\dsh-guard-native.mjs`.
3. Writes `<profile>\dsh-guard.json` (a readable mirror of the effective configuration).
4. Adds or updates **one** entry in `<profile>\cordis.patch.yml`, with the configuration inline:

   ```yaml
   - insert:
       - id: guard-native
         name: "./dsh-guard-native.mjs"
         config:
           enabled: true
           gating: true
           statusLine: true
           workspace: ""
           dshHome: "C:\\Users\\you\\.dsh"
           stateDir: "C:\\Users\\you\\.dsh\\emergency"
           auditLog: "C:\\Users\\you\\.dsh\\emergency\\guard-audit.jsonl"
           loadMarker: "C:\\Users\\you\\.dsh\\profiles\\desktop\\dsh-guard-native-loaded.txt"
           protectedRoots: [ "C:\\Users\\you", "C:\\" ]
   ```

   The entry resolves by **relative path**, which is the form this loader actually loads. The name is
   quoted, so Windows backslashes in the config need no YAML escaping beyond `\\`.
5. Backs up `cordis.patch.yml` and any existing module as `*.bak-<timestamp>`.
6. Validates what it wrote: module hash equal to source, entry present, config parses as JSON, patch
   file still structurally a YAML array. It then runs the offline matrix when `node` is available.
7. Prints the rollback commands and asks you to **restart dsh**.

Useful flags:

| Flag | Effect |
|---|---|
| `-DryRun` | Print the config, the entry and the resulting patch file; write nothing. |
| `-Status` | Read-only report: entry, files, hashes, load receipt, switches, ledger size. |
| `-Uninstall` | Remove the entry and the copied files. The ledger and switches are never touched. |
| `-ProfileDir <path>` | Target another profile (e.g. `...\.dsh\profiles\work`). |
| `-Workspace <abs path>` | Set the fallback workspace. Leave it unset and each call uses its session's own cwd. |
| `-ProtectedRoots <a>,<b>` | Roots where anything beyond a directly named single file counts as mass scope. |
| `-Gating false` | Shadow mode: evaluate and audit, allow everything. |
| `-StatusLine false` | Do not inject the per-session status line. |
| `-EmergencySwitches DISABLE` | Pre-create a switch file (see [Emergency switches](#emergency-switches)). |
| `-UseConfigFile` | Put only `configFile: <json>` in the entry and keep the knobs in `dsh-guard.json`. Inline fields still win per-field. |

**Then restart dsh.** The loader reads the patch layer once at startup.

## Verify the install

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Status
```

Expect: `patch entry present`, `same revision as this source tree`, and a `last load:` line whose
timestamp is later than your restart. Then, inside dsh, look for the status line at the start of a
session:

```
dsh-guard active (bulk/traversal pwsh + writes outside the session workspace ask first; unbounded deletes denied).
workspace: F:\work\my-project (this session's own cwd). emergency switches: none. audits: 12 total, ...
```

The `workspace:` field is the root every call in *that* session is judged against. If it says
`configured fallback`, the session exposed no cwd and your configured `workspace` was used instead.

Two quick behavioural checks inside a session:

| Do this | Expect |
|---|---|
| read a file, list a directory with a wildcard, `git status` | no prompt |
| `Remove-Item -Recurse -Force .\out` | one prompt, first line `dsh-guard: BULK DELETES paths inside this project workspace` |

## Configuration

All keys are optional; the defaults are what the installer writes.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` keeps the load receipt and the status line but gates nothing. |
| `gating` | boolean | `true` | `false` is shadow mode: rules are evaluated and audited, every call is allowed. |
| `statusLine` | boolean | `true` | Inject the one-line status when a session is created. |
| `workspace` | absolute path | `""` | **Fallback only.** Each call is judged against its own session's `cwd` (`SessionHeader.cwd`). Set this only for a session that exposes none. |
| `dshHome` | absolute path | `%USERPROFILE%\.dsh` | Drives the defaults of the next three. |
| `stateDir` | absolute path | `<dshHome>\emergency` | Where the emergency switch files are looked for. |
| `auditLog` | absolute path | `<stateDir>\guard-audit.jsonl` | The ledger. |
| `loadMarker` | absolute path | `""` (off) | Load receipt appended on every `apply()`. The status-route trace is written beside it. |
| `protectedRoots` | array of paths | your home and `C:\` | Roots where mass scope is assumed for anything but a named single file. |
| `additionalRoots` | array of paths | `[]` | Extra trusted roots, for sessions that span several projects. Widens `inside`; weakens no rule. |
| `statusLine` | `true` / `false` / `"brief"` | `true` | `"brief"` keeps posture, workspace and switches and drops the counters (~120 chars instead of ~430). |
| `auditMaxBytes` | integer | `8000000` | Rotate the ledger at this size; a `rotation` row marks the new file. |
| `auditKeep` | integer | `3` | Rotated copies to keep (`guard-audit.jsonl.1` … `.N`). |
| `loadMarkerKeep` | integer | `20` | Load-receipt blocks to keep (one block per `apply()`). |
| `askMode` | `"ask"` / `"deny"` | `ask` | What an escalation does: ask, or refuse with the same reason. Use `deny` where approvals are disabled — an ask is auto-rejected there and reads as an approval error. |
| `rememberApproved` | `{ enabled, ttlSeconds }` | `{ false, 900 }` | Opt-in: remember an **exact** command + scope after it was approved **and executed**, for the TTL. |
| `extraGatedTools` | array of tool names | `[]` | Tools beyond `pwsh`/`write`/`edit` that get the scope check (`run_code`, …). Ungated mutating-looking tools are logged once as `untracked-tool`. |
| `outcomesKeep` | integer | `1000` | Approval outcomes kept in `guard-outcomes.json`, the ring behind the 24h panel. |
| `publicBaseUrl` | string | `""` | Override the URL the status page prints; by default it uses the request's Host header. |
| `configFile` | absolute path | unset | Read settings from this JSON file. Inline keys win field by field. |

Editing configuration: change `<profile>\cordis.patch.yml` (or `dsh-guard.json` if you installed with
`-UseConfigFile`) and **restart dsh**. Changing only the plugin *body* still needs a restart, because
the module is imported at startup.

## Using it

### Who it is for

Anyone running dsh with a model that can delete or overwrite files. The gate buys you one thing: **the
irreversible operations stop and ask, with the exact scope in front of you.**

### The three answers you will see

| Decision | What the panel shows | What to do |
|---|---|---|
| **allow** (silent) | nothing | — |
| **ask** | one classified sentence + the matched rules + the exact target | Read the target line. If the scope is what you intended, approve; otherwise reject and say what you actually wanted. |
| **deny** | the same, prefixed `DENY`, with `NOT executed` | The command did not run. It will not run on retry; change the approach. |

### Reading an escalation

Every escalation answers four questions in a fixed order:

1. **What the action does and where it lands** — the first line, classified. `BULK DELETES paths OUTSIDE
   this project workspace`, `批量改写（本工作区内）`, and so on. Action classes: delete, overwrite/create,
   copy, extract, chmod, attribute, rollback, indirect, disk, unknown; single vs mass; inside vs
   outside.
2. **`decision:`** — whether it ran. A `DENY` says `NOT executed`; an `ask` says `has NOT run`.
3. **`workspace:`** — the root that judged it, and whether that root came from the session or from the
   configured fallback.
4. **`rule:` lines and `target:`** — the evidence: which pattern matched, in words, and the command or
   path, truncated to 200 characters.

### Reducing prompts

| Symptom | Fix |
|---|---|
| A legitimate bulk job asks every time | Approve it. The gate is per call; it keeps no allow-list on purpose. |
| A whole class of work asks (e.g. archive extraction) | `-Gating false` in shadow mode records the same ledger without prompting, or narrow `protectedRoots`. |
| The gate is in the way right now | Create the `DISABLE` switch (below) — one file, no restart. |
| You want the record but not the prompts | Shadow mode (`gating: false`) plus reading `guard-audit.jsonl`. |

## What you can observe

| Surface | Where | What it shows |
|---|---|---|
| **Session status line** | the conversation, once per session | posture, the workspace root in effect, switches, audit totals, the newest notable decision |
| **Approval prompt** | the panel, when a call is escalated | the classified sentence; the full reason is in the tool card |
| **Session events** | `approval/asked` in the session log | the complete reason text that was displayed — an auditable trail of what a human saw |
| **`/dsh-guard/status`** | `http://127.0.0.1:19387/dsh-guard/status` (`?format=json`) | on-demand report: posture, load time/pid/node, workspace model, audit totals, sessions judged, rule inventory, and what each surface can and cannot do |
| **Ledger** | `<stateDir>\guard-audit.jsonl` | every judgement, one JSON object per line |
| **Status script** | `scripts\status.ps1` (installed as `dsh-guard-status.ps1`) | the same report from the command line; `-Json` for machine reading |

A ledger row:

```json
{"ts":"2026-10-16T02:26:28.948Z","session":"session-3a3bfc97…","tool":"pwsh","decision":"ask",
 "action":"overwrite","mass":true,"scope":"inside","summary":"批量改写（本工作区内）",
 "rule":"ps-wildcard-write, wildcard-target","rules":["ps-wildcard-write","wildcard-target"],
 "workspace":"F:\\work\\my-project","workspaceSource":"session","externalTargets":[],
 "sandbox":"","justification":"","preview":"Set-Content -Path .\\out\\*.log -Value \"\""}
```

There is **no settings-page block** for this plugin, and that is a platform constraint rather than an
omission: `settings.section` is a *client* slot, and a client contribution must ship a built
`lib/client.js` that the host serves as `/plugins/<package>/client.js`. A profile-local module cannot
register one. The status page above is the supported on-demand surface.

## Emergency switches

Files in the state directory (`%USERPROFILE%\.dsh\emergency` by default). **Creating or deleting one
takes effect immediately — no restart.** They live outside the session workspace, so a session cannot
write them.

| Switch | Effect |
|---|---|
| `DISABLE` | The gate stops judging: everything is allowed. The status line says `WARNING: dsh-guard is DISABLED` instead of pretending to be active. |
| `PANIC` | Hard denies become questions, so you can approve one unbounded delete you really meant. |
| `HARD-STOP` | Every escalation becomes a deny — including the sandbox-bypass floor. |

```powershell
$s = "$env:USERPROFILE\.dsh\emergency"
New-Item -ItemType File "$s\PANIC"        # allow me to approve a normally-denied command
New-Item -ItemType File "$s\DISABLE"      # stop gating entirely
New-Item -ItemType File "$s\HARD-STOP"    # approve nothing for a while
Remove-Item "$s\PANIC"                    # back to normal
```

## How the gate decides

Four layers, in order:

1. **Tool scope** — only `pwsh` and `write` are judged. `read`, `glob`, `grep`, `edit`, web and
   subagent tools pass through (`edit` can only change a file this session already read, and the file
   sandbox plus version snapshots cover it).
2. **Read-only** — no mutating verb anywhere in the command ⇒ allow. This is what keeps wildcard
   reads, directory listings and `rg` quiet.
3. **Rule tables** — bulk signals (recursion, wildcards, mass pipelines, recursive copy, archive
   extraction, tree rollbacks, indirect shells, unbounded targets), then scope: does any target fall
   outside the session workspace and outside the dsh home/state dir?
4. **Sandbox-bypass floor** — a call that asks the sandbox to stand down, escalated when it is a
   deletion or a mass rewrite.

`write` is judged differently from a command line: a file path is not a shell command, so a path is
never scanned for verbs (a `README.md` path once matched the `md` alias and turned a read into "BULK
CREATES"). A write is classified by what is on disk — first-time creation, or an overwrite.

## Update and uninstall

**Update (npm install)** — open **Plugins → Installed**: a newer release on the registry shows
**Update available**, and updating replaces the installed copy. Or run
`dsh plugin --profile desktop add dsh-guard-native`, then restart DSH. DSH checks the npm registry for
registry-installed copies, so a new version reaches users without republishing an index entry.

**Update (source checkout)** — replace `lib\index.mjs` with the new revision, then:

```powershell
node test/matrix.mjs                                        # optional, offline
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Status   # see what differs
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1           # install
# restart dsh
```

`-Status` before installing tells you whether the deployed module matches your tree, so an update is
never a guess.

**Uninstall (npm install):** remove the bundle from **Plugins → Installed**, then restart DSH.

**Uninstall (profile-local install):**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Uninstall
# restart dsh
```

It removes the patch entry and the copied module, config and status script. Your **ledger, switches and
backups are left alone**; delete them yourself if you want them gone.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The status line never appears | The entry did not load. Check `-Status`; then read the load receipt (`<profile>\dsh-guard-native-loaded.txt`) — no new `loaded_at` block means the loader never accepted the entry. Confirm `name: "./dsh-guard-native.mjs"` (relative, quoted) in `cordis.patch.yml`. |
| dsh fails to start after installing | Roll back: `Copy-Item '<profile>\cordis.patch.yml.bak-<stamp>' '<profile>\cordis.patch.yml' -Force`, then delete `<profile>\dsh-guard-native.mjs`. |
| `/dsh-guard/status` answers 404 | The host web carrier was not present when the plugin applied, or registration failed. Look for `<profile>\dsh-guard-native-status-route.txt` — a refused registration is recorded there. |
| Everything asks, including reads | You are on an old revision. `-Status` shows the hash; reinstall. |
| Nothing asks at all | A `DISABLE` switch is present, `gating` is false, or `enabled` is false. The status line states which. |
| The config I edited had no effect | The loader reads the patch layer at startup: restart dsh. With `-UseConfigFile`, remember inline keys win. |
| The status script's counts differ from the status page | The script counts the whole ledger (every process, including earlier revisions); the page counts what this process wrote. Both report totals, so compare them knowingly. |

## Honest limits

- **It reads text, not intent.** A command that deletes through a script file, a compiled binary, or a
  language runtime it does not recognise by name can pass. It recognises common file-mutation APIs
  (`fs.writeFileSync`, `shutil.rmtree`, `unlinkSync`, …), which widens the net, but this is a semantic
  gate, **not a sandbox**. Keep the file sandbox on; the guard is what stops *irreversible* things from
  happening silently, not what confines the blast radius.
- **Quoting a dangerous pattern trips it.** The gate cannot tell "run this" from "talk about this", so a
  command whose text merely *contains* `rm -rf /` or `Format-Volume` is denied. Keep such literals out
  of test commands, or run them with `PANIC` present.
- **False positives are preferred to false negatives.** A read-only command that carries a mutating
  verb name is escalated rather than allowed.
- **`edit` is not gated.** It only touches a file this session already read; the file sandbox and your
  version snapshots are the net there.
- **No allow-list.** Approvals are per call; a pattern approved once is evaluated again next time.
- **The ledger is a file, not a service.** Its size grows with use; rotate it yourself if that matters.
- **Windows-shaped.** The rules and installer target PowerShell/cmd on Windows.

## Development

```powershell
node test/matrix.mjs      # 238 offline checks: rule matrix, switches, workspace resolution,
                          # action classification, read-only silence, alias traps, sandbox floor,
                          # escalation wording, status surface, plugin wiring
node scripts/sync-source.mjs --check    # is this tree in sync with the workspace copy?
node scripts/sync-source.mjs --write    # copy workspace -> project
```

The matrix runs with plain Node, injects a fake `readPath`, and never touches a real filesystem. Change
a rule and it must be re-run.

Layout:

```
lib/index.mjs          the whole plugin: one dependency-free ESM module
config.schema.mjs      the config shape, defaults, and a validator
scripts/install.ps1    install / update / status / uninstall (profile-aware, idempotent, verifying)
scripts/status.ps1     on-demand status report (read-only; -Json for machine reading)
scripts/install.cmd    cmd.exe wrapper
scripts/sync-source.mjs   explicit copy between this tree and the development workspace
test/matrix.mjs        the offline matrix
docs/ARCHITECTURE.md   how the gate is built and why, including the bugs that shaped it
docs/OPTIMIZATION.md   measurement-based backlog from 35 days of live operation
CHANGELOG.md           version history
```

MIT licensed — see [LICENSE](LICENSE).
