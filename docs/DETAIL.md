# dsh-guard 闸门

A semantic gate in front of the DeepSeek Harness filesystem sandbox. It sits on the harness's
`tools/pre-execute` hook, so it decides **before** the sandbox policy and the approval policy run, and
it never delegates a decision it made.

## What it gates

| Tool | When it can escalate |
|---|---|
| `pwsh` | a bulk or recursive shape (wildcards, `-Recurse`, `robocopy`, archive extraction, a pipeline feeding a deleting/moving cmdlet), a destructive verb aimed outside the session's trusted roots, or two or more existing targets |
| `write` | a target outside the session's trusted roots, under a protected root, or naming a wildcard |
| `edit` | the same scope check only: an in-workspace single file stays silent |
| `plugin_manager` | `install_bundle` / `remove_bundle` / `set_bundle` / `set_plugin` / `set_version_exemption` — these change the code dsh loads at the next launch |
| extra tools | names listed in `extraGatedTools` get the same scope check (`run_code`, `str_replace_editor`, …) |

Reads never ask. A single in-workspace write never asks. A PowerShell `-WhatIf` dry run never asks.

Four shapes that used to ask are now silent, because the live ledger showed them as noise:

- **Remote payloads**: `ssh host '…'`, `scp`, `sshpass`, `wsl`, `Invoke-Command` — POSIX paths inside
  the remote payload are on the other machine, not local targets. A remote payload that deletes or
  rewrites still asks once as `remote-command`.
- **Read-only externals**: a deploy key (`.ssh\…`, `id_ed25519`) or an executable (`chrome.exe`) in a
  read position is not a write target.
- **Sinks**: `/dev/null`, `NUL`, `$null`.
- **Archive destinations**: extraction into a missing or empty directory is not an overwrite; an
  existing directory that already holds files still asks.

## Where "inside" comes from

Every call is judged against **its own session's** current directory (`workingDirectory`), with the
session's `Session.header.cwd` as the origin and permission root. `additionalRoots` adds other trusted
projects for sessions that span several checkouts. The configured `workspace` is a fallback used only
when a session exposes no directory at all.

Dot-relative write targets (`.`, `.\x`, `..\y`) are resolved against the session's **current**
directory; a target that resolves into a protected root outside the workspace asks
(`relative-target-in-protected-root`), and a mutation attempted after the session moved outside every
trusted root asks (`cwd-outside-workspace`).

## Rules

- **Bulk**: `ps-recursive-delete`, `ps-wildcard-write`, `ps-mass-pipeline`, `cmd-recursive-delete`,
  `cmd-mass-copy`, `shell-recursive-rm`, `shell-recursive-attr`, `shell-find-exec`, `git-rollback`,
  `git-bulk-restore`, `indirect-execution`, `archive-overwrite`, `bulk-attribute-write`.
- **Scope**: `external-path-target`, `wildcard-target`, `multiple-path-targets`,
  `directory-target-outside-workspace`, `relative-target-in-protected-root`, `cwd-outside-workspace`.
- **Deny** (never runs): `unbounded-root-delete` (a drive/folder root), `posix-root-delete` (`rm -rf /`),
  `format-volume`. Deny patterns are anchored to command position, so the same words inside a quoted
  pattern or a document edit are not denials.
- **Sandbox-bypass floor**: a call carrying `sandbox_permissions` is escalated only for a crossing — a
  deletion, or a mass rewrite — because the sandbox is not a backstop for that call.

Each escalation's dialog leads with ONE classified sentence (what it does + where it lands), then the
rule ids, then the scope and the truncated target.

## Emergency switches

Files in `<stateDir>` (default `%USERPROFILE%\.dsh\emergency`), immediate, no restart:

- `DISABLE` — the gate allows everything (a warning is prepended to the session line).
- `PANIC` — hard denials become questions.
- `HARD-STOP` — questions become denials.

They can be toggled from the settings section or created by hand.

## Settings section

**Settings → dsh-guard 闸门** shows the posture, the judged sessions and their current directories, the
24-hour approval panel (asked / approved / rejected / pending, approval rate, which rules were
rejected), the lifetime totals, the audit ledger tail, and the emergency-switch controls. It can also
write `statusLine`, `gating` and `rememberApproved` into `dsh-guard.json`.

The 24-hour panel pairs session events `approval/asked` and `approval/decided` by **approval id**, so it
is exact rather than timestamp-guessed. The rows persist in `guard-outcomes.json` next to the ledger.

## Configuration

`<profile>\\dsh-guard.json`, discovered from the plugin module's own location (the bundle row carries no machine paths), or an
explicit `configFile` on the row. Most keys need a `dsh` restart; the emergency switches and the audit
rotation thresholds do not.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the load receipt and status line but gates nothing |
| `gating` | `true` | `false` is shadow mode: rules are evaluated and audited, every call is allowed |
| `statusLine` | `true` | `true`, `false` or `"brief"` (posture + workspace + switches, no counters) |
| `askMode` | `ask` | `deny` refuses with the same reason where no approval answerer exists |
| `additionalRoots` | `[]` | extra trusted roots |
| `extraGatedTools` | `[]` | tools beyond pwsh/write/edit that get the scope check |
| `protectedRoots` | home and `C:\` | roots where mass scope is assumed |
| `rememberApproved` | `{ enabled: false, ttlSeconds: 900 }` | opt-in: remember an exact command after it was approved **and executed** |
| `auditMaxBytes` / `auditKeep` | `8000000` / `3` | ledger rotation |
| `outcomesKeep` | `1000` | approval rows kept for the panel |

## Limitations

- Classification is **text-based**: it reads the command string, so a quoted literal can still be
  mistaken for an invocation (that is why the DENY patterns are anchored), and an unusual script can
  hide a mutation inside a heredoc.
- It cannot tell a directory's contents, so "two existing targets" counts the paths it can see.
- `edit` is gated by scope only; it is not treated as a bulk operation.
- The client section's labels are Chinese; it does not route text through the Client locale service.
- Ledger times are stored as UTC and rendered in the **viewer's** timezone. If you compare the raw
  `guard-audit.jsonl` with the panel, remember the JSON is UTC.
- A gate `ask` only works when an answerer is attached. With approvals disabled (or in PANIC mode in
  this build) the ask is rejected in milliseconds and the call does **not** run — effectively a silent
  deny. The panel reports those as `autoRejected`.
- Changing most configuration keys, and installing a new JavaScript generation of this plugin, needs a
  `dsh` restart. The settings section says so when it saves.
- A `link:` install keeps the module in its source checkout; the profile is then located by scanning
  the profiles that declare this bundle (`<dshHome>\profiles\*\package.json`).

## Bundle vs. legacy

This package is the bundle form: `dsh.profile.bundles` lists `dsh-guard-native`, the host applies the
package's `cordis.patch.yml`, and the client half is served as `/plugins/dsh-guard-native/client.js`.
The older profile-local form (a loose `dsh-guard-native.mjs` copied next to `cordis.patch.yml`, with the
row id `guard-native`) is still supported by `scripts/install.ps1` for machines that cannot install
packages. Do not run both: two instances would gate every call twice.
