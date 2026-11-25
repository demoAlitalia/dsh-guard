# dsh-guard architecture

Why the gate is shaped the way it is, and which concrete failures shaped it. Everything here is
grounded in the repository's own history and in observed dsh behaviour; where something was not
verified, it says so.

## Where the gate sits

`dsh-tools` runs a fixed pipeline for every tool call:

```
tools/pre-execute (extensible allow/deny/ask) -> registered monotonic guards -> tools/execute
  -> tools/post-execute -> definition finalizeContent -> tools/result (observe-only)
```

`dsh-pwsh-sandbox` and `dsh-fs-sandbox` resolve their policy (`sandboxPolicy.resolve(...)`) and ask
for escalation approval (`approvePwshEscalation(...)`) in the **execute** stage — after
`tools/pre-execute`. Two consequences:

1. The gate decides before the sandbox and the approval policy exist for that call. It never reads the
   Permissions preset, so switching between `read-only`, `workspace-write` and `danger-full-access`
   cannot change its verdict.
2. A `deny` returned from `tools/pre-execute` ends the call: the sandbox is never consulted. Only the
   emergency switches can soften it.

The plugin is a single ESM module mounted from the profile by a `cordis.patch.yml` entry whose `name`
is a **relative** specifier. It holds no `@deepseek-ai/*` import on purpose: the profile has no module
tree, so a resolution failure there would kill the plugin at import time — before `apply()` runs and
before any load receipt is written, leaving "never loaded" indistinguishable from "loaded and idle".

## The decision layers, and why the order matters

```
1. tool scope      only pwsh and write       (everything else delegates with next())
2. read-only       no mutating verb          -> allow
3. rule tables     bulk signals, then scope  -> ask / deny
4. bypass floor    sandbox_permissions       -> ask when it is a crossing
```

Layer 2 exists because layer 3 alone produced the complaint that started this work: a read-only
command carrying a wildcard (`Get-Item a, b`, `Get-ChildItem -Recurse -Filter *.json`) was escalated
as "a bulk destructive operation". The scope rules (`wildcard-target`, `multiple-path-targets`,
`directory-target-outside-workspace`, `external-path-target`) now share one predicate — "does this
command mutate anything" — so a read is silent and a write with the same shape still escalates.

`MUTATING_VERB` is deliberately wider than "delete verbs": `Remove-Item`, `Move-Item`, `Copy-Item`,
`Set-Content`, `New-Item`, `Out-File`, … all take a wildcard or a target array, and missing any one of
them silently disables the scope half of the gate.

## Workspace identity

A profile's `workspace` value is a **fallback**, not the scope. Every call is judged against the cwd
of the session it runs in — `SessionHeader.cwd`, which the sandbox policy documentation calls "the root
for every call in that session". The plugin reads it from `exec.agent.session.header.cwd` and caches it
per agent (the header is immutable).

This was the original defect: with a hard-coded workspace, an ordinary single-file write inside a
*different* project's session was reported as `write-outside-workspace`, i.e. as a bulk operation. The
dialog also names the root it used and where that root came from (`session` or `config-fallback`), so a
stale fallback is visible instead of being silently applied.

## Classification: one sentence, then evidence

A dialog that only says "a bulk destructive operation needs your approval" forces the human to reverse
engineer which pattern fired. Every escalation therefore leads with one classified sentence built from
three facts:

| axis | values |
|---|---|
| action | delete / overwrite / create / copy / extract / chmod / attribute / rollback / indirect / disk / unknown |
| scope | inside the session workspace, or outside it (decided by the targets, not by "do we have a root") |
| size | single vs mass (recursion, wildcard, pipeline, several real targets, a filesystem root) |

`rule:` lines (id + plain-language explanation), `workspace:` and a 200-character `target:` follow as
evidence. The panel's own dialog takes `displayReason`, so the panel shows the sentence and the rule
ids; the full reason is recorded in the session's `approval/asked` event, which is what makes "what did
the human actually see?" answerable after the fact.

`write` is classified separately: a file path is not a shell command line. Scanning paths with the verb
table once turned `D:\stuff\note.md` into a *create* (the `md` in the name). A write is now classified
by what is on disk — first-time creation vs overwrite — which is also the distinction a human cares
about.

## The sandbox-bypass floor

The platform offers a legitimate escape hatch: after a denial, the model may retry the same call once
with `sandbox_permissions` plus a `justification`, and once approved **that call runs with no file
sandbox behind it**. The gate's first revision only annotated such calls; a call it would otherwise
allow therefore crossed the boundary with nothing in front of it.

The floor now escalates a **crossing**, defined as:

- a deletion (mass, or aimed outside the workspace), or
- a mass rewrite — overwrite / create / extract / attribute / disk / **copy and the
  destination-dependent `context` class** — meaning `Copy-Item -Recurse`, which no rule table catches.

Everything else keeps its verdict: a single in-workspace write with the field is still allowed, an
already-stricter verdict is untouched, `HARD-STOP` turns the floor into a deny, and `DISABLE` remains
the human's own off-button.

## Tokenization: what a "path" is

Scope decisions depend on finding absolute paths in a command, and the same token extractor is the
source of most of the false positives this project has had to fix. The current anchors, each added
after an observed failure:

| Pattern in real text | What it used to become | Anchor |
|---|---|---|
| `'approval/asked'` | an outside target `/asked` | a posix path must start at a boundary (not a word character, not `/`) |
| `(/json\|zstd/)` | an outside target `/json\|zstd/` | a path name does not continue into `\|`, `)` or `>` |
| `-join " / "` | the root `/` as an outside target | a bare `/` is admitted **only** when a root-delete DENY rule matched |
| `</body></html>` | `/body></html>` | the `>` anchor |
| `http://127.0.0.1:19387/dsh-guard/status?format=json` | `p://127.0.0.1:19387/...` as an outside target, plus `?` firing the wildcard rule | a candidate bound to a URL scheme is not a filesystem target |
| `README.md` | a "create" action via the `md` alias | scope decisions use full cmdlets only; aliases are boundary-anchored for classification and cannot widen scope |
| `C:/Users/...` | no token at all, so scope checking silently skipped | the Windows token accepts either slash |
| `fs.writeFileSync('C:/…')` | nothing recognized | Node/Python mutation APIs count as destructive verbs |

## Observability

Three surfaces, one data source (`statusReport()`), so they cannot disagree:

| Surface | Mechanism |
|---|---|
| session status line | `agent/created` → `agent.inject()` with a generated `id` |
| `/dsh-guard/status` (+ `?format=json`) | `ctx.inject(['webServer'], cb)` → `webServer.register({kind:'exact', path, handler})` |
| `scripts/status.ps1` | reads the ledger, the switches, the load receipt and the module hash |

The injected message **must** carry a non-empty `id`: `MessageBase.id` is required, and a stored
`user/message` without one makes the seed validator reject the whole session on resume
(`session event at seq N lacks an identified message`). That is a real outage this project caused and
then repaired; the regression is pinned by a test.

There is **no settings-page block**: `settings.section` is a client slot, and a client contribution
must ship a built `lib/client.js` the host serves as `/plugins/<package>/client.js`. A profile-local
module cannot register one. The status page is the supported alternative.

`ctx.inject([...], cb)` — not a one-shot `ctx.get()` — is the shape for an optional service. The first
implementation used a one-shot `get()` inside a silent `try/catch`, registered nothing because the
carrier did not exist yet, and left the route answering 404 with no trace. Registration failures are
now written to `<loadMarker>-status-route.txt`.

## Verification posture

`test/matrix.mjs` runs 238 checks with plain Node, an injected `readPath`, and no real filesystem: the
rule matrix, switch semantics, workspace resolution, action classification, read-only silence, alias
traps, the bypass floor, escalation wording, the status surface, and plugin wiring. Rule changes must
re-run it.

Two habits are load-bearing, each learned from a bug that a green run hid:

- **Baseline comparisons.** Escalation tests run the same input twice — with and without the field
  under test — and assert the *transition*. A single assertion against an expected verdict would have
  passed while the feature matched nothing.
- **Live evidence over reasoning.** Several defects (the `md` alias trap, the phantom `/`, the URL
  false positive, the status script's ANSI mis-decoding that reported 222 rows and 0 denies for a
  266-row ledger with 2 denies) were found by reading the guard's own ledger and asking why a number
  looked wrong.

Known, unfixed limits are listed in the README's "Honest limits" section rather than implied away.
