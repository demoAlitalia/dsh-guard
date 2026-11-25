<#
.SYNOPSIS
  Install, update, inspect or remove the dsh-guard plugin in a DeepSeek Harness (dsh) profile.

.DESCRIPTION
  dsh composes a profile from `package.json` bundles plus `cordis.patch.yml`. This plugin needs no
  module tree and no build step: it is one dependency-free ESM file, so the installer copies that
  file and a generated `dsh-guard.json` next to `cordis.patch.yml` and records ONE insert entry in
  the patch layer. That entry resolves by RELATIVE path, which is the form this loader actually
  loads (a `file:///` URL was measured not to load).

  The installer is idempotent: running it again updates the same entry and rewrites the same files.
  It backs up both files before touching them, validates what it wrote, and prints the exact
  rollback command.

  Why run it from outside dsh: writing into the profile directory is outside a dsh session's
  sandbox, so an agent inside dsh cannot do it for you.

.PARAMETER Mode
  install (default) installs or updates. uninstall removes the entry and the copied files.

.PARAMETER Uninstall
  Shorthand for -Mode uninstall.

.PARAMETER Status
  Read-only report: entry, files, hashes, load receipt, switches, ledger. Writes nothing.

.PARAMETER DryRun
  Print every intended action and write nothing.

.PARAMETER NoRestart
  Skip only the closing "restart dsh" reminder (the installer never restarts anything itself).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
  Install with defaults for the `desktop` profile, then restart dsh.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\work" -ProtectedRoots 'C:\Users\me','C:\'
  Install into another profile with an explicit protected-root list.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Status
  Show what is installed and whether the deployed module matches this source tree.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Uninstall
  Remove the entry and the copied files (the audit ledger is never touched).
#>
[CmdletBinding()]
param(
    [ValidateSet('install', 'uninstall')]
    [string]$Mode = 'install',

    [switch]$Uninstall,
    [switch]$Status,
    [switch]$DryRun,
    [switch]$NoRestart,

    # --- where ---------------------------------------------------------------------------------
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),

    # --- configuration written into <ProfileDir>\dsh-guard.json --------------------------------
    # `workspace` is a FALLBACK: each call is judged against its own session's cwd. Set it only if
    # some session can expose no cwd at all.
    [string]$Workspace = '',
    [string]$StateDir = '',
    [string]$AuditLog = '',
    [string]$LoadMarker = '',
    [string[]]$ProtectedRoots = @(),
    # Extra trusted roots: projects you also work in during the same session.
    [string[]]$AdditionalRoots = @(),
    # true | full | brief | false. 'brief' keeps posture/workspace/switches and drops the counters.
    [string]$StatusLine = '',
    [string]$Gating = '',
    [string]$Enabled = '',
    # Ledger rotation and the receipt cap.
    [int]$AuditMaxBytes = 8000000,
    [int]$AuditKeep = 3,
    [int]$LoadMarkerKeep = 20,
    # Opt-in: remember an escalation that was approved AND executed, for a short TTL.
    [switch]$RememberApproved,
    [int]$RememberSeconds = 900,
    # Tools beyond pwsh/write/edit that should get the scope check (e.g. run_code).
    [string[]]$ExtraGatedTools = @(),
    # Pre-create these emergency switch files in the state directory (DISABLE / PANIC / HARD-STOP).
    [string[]]$EmergencySwitches = @(),

    # Write only `configFile: <json>` into the patch entry and keep the knobs in that JSON file.
    # The plugin reads and merges it; inline config (the default) always wins.
    [switch]$UseConfigFile
)

$ErrorActionPreference = 'Stop'

# --- fixed identity -----------------------------------------------------------------------------
# The entry id is stable on purpose: idempotent update and clean uninstall both key off it.
$EntryId = 'guard-native'
$ModuleFileName = 'dsh-guard-native.mjs'
$ConfigFileName = 'dsh-guard.json'
$StatusScriptName = 'dsh-guard-status.ps1'
$LegacyEntryId = 'guard-native'          # older ad-hoc installs used this same id
$InstallerVersion = '0.5.0'

if ($Uninstall) { $Mode = 'uninstall' }

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceModule = Join-Path $projectRoot 'lib\index.mjs'
$sourceStatus = Join-Path $projectRoot 'scripts\status.ps1'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'
$modulePath = Join-Path $ProfileDir $ModuleFileName
$configPath = Join-Path $ProfileDir $ConfigFileName
$statusPath = Join-Path $ProfileDir $StatusScriptName

# --- helpers ------------------------------------------------------------------------------------
function Get-Sha256([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return '' }
    try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash } catch { return '' }
}

function Write-Step([string]$Text) { Write-Output ("  " + $Text) }

# A switch-typed CLI value that may be absent, so the default stays the file's business.
# NOTE: helpers are used while resolving options (before section 3), so they are all defined in
# section 1; PowerShell executes top-down and a later definition is not yet callable.
function ConvertTo-JsonBool([bool]$Value) { if ($Value) { return 'true' } else { return 'false' } }

function Resolve-Bool([string]$Value, [bool]$Default) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
    switch ($Value.Trim().ToLowerInvariant()) {
        'true' { return $true }
        '1' { return $true }
        'yes' { return $true }
        'on' { return $true }
        'false' { return $false }
        '0' { return $false }
        'no' { return $false }
        'off' { return $false }
        default { throw "invalid boolean value '$Value' (use true/false)" }
    }
}

function ConvertTo-JsonString([string]$Value) {
    # Minimal JSON string escaping: paths are the only strings written, but backslashes and quotes
    # must survive a round trip through the JSON parser the plugin uses.
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"' { [void]$sb.Append('\"') }
            '\' { [void]$sb.Append('\\') }
            "`n" { [void]$sb.Append('\n') }
            "`r" { [void]$sb.Append('\r') }
            "`t" { [void]$sb.Append('\t') }
            default { [void]$sb.Append($ch) }
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function ConvertTo-YamlQuoted([string]$Value) {
    # Double-quoted YAML so backslashes are escaped, matching the file's existing style.
    return '"' + ($Value -replace '\\', '\\') + '"'
}

# The generated patch entry. Rendered as text because the profile file is hand-edited YAML that must
# stay readable, and because a YAML library is not available to this script.
#
# The loader's patch semantics are `{ id, insert, name, ...overrides }`: for an insert without an
# id, the entries are pushed onto the top-level array, and everything else on the entry (including
# `config`) is carried through untouched. So the plugin's knobs go INLINE under `config:` -- that is
# the only form guaranteed to reach `apply(ctx, config)`.
function New-PatchEntry([string]$Specifier, [string[]]$ConfigLines) {
    $lines = @()
    $lines += '- insert:'
    $lines += "    - id: $EntryId"
    $lines += "      name: `"$Specifier`""
    $lines += '      config:'
    foreach ($l in $ConfigLines) { $lines += ('        ' + $l) }
    return ($lines -join "`r`n")
}

function New-ConfigLines([bool]$AsJsonFile, [string]$ConfigFile) {
    if ($AsJsonFile) {
        return @("configFile: $(ConvertTo-YamlQuoted $ConfigFile)")
    }
    $lines = @()
    $lines += 'enabled: ' + (ConvertTo-JsonBool $enabledValue)
    $lines += 'gating: ' + (ConvertTo-JsonBool $gatingValue)
    $lines += 'statusLine: ' + $statusLineYaml
    $lines += 'workspace: ' + (ConvertTo-YamlQuoted $Workspace)
    $lines += 'dshHome: ' + (ConvertTo-YamlQuoted $DshHome)
    $lines += 'stateDir: ' + (ConvertTo-YamlQuoted $StateDir)
    $lines += 'auditLog: ' + (ConvertTo-YamlQuoted $AuditLog)
    $lines += 'loadMarker: ' + (ConvertTo-YamlQuoted $LoadMarker)
    $roots = (@($ProtectedRoots | ForEach-Object { ConvertTo-YamlQuoted $_ }) -join ', ')
    $lines += 'protectedRoots: [ ' + $roots + ' ]'
    $extra = (@($AdditionalRoots | ForEach-Object { ConvertTo-YamlQuoted $_ }) -join ', ')
    $lines += 'additionalRoots: [ ' + $extra + ' ]'
    $lines += 'auditMaxBytes: ' + $AuditMaxBytes
    $lines += 'auditKeep: ' + $AuditKeep
    $lines += 'loadMarkerKeep: ' + $LoadMarkerKeep
    $lines += 'rememberApproved: { enabled: ' + (ConvertTo-JsonBool ([bool]$RememberApproved)) + ', ttlSeconds: ' + $RememberSeconds + ' }'
    $tools = (@($ExtraGatedTools | ForEach-Object { ConvertTo-YamlQuoted $_ }) -join ', ')
    $lines += 'extraGatedTools: [ ' + $tools + ' ]'
    return $lines
}

function Get-EntryPattern([string]$Id) {
    return "(?ms)^\s*- (insert:\s*\r?\n\s*- )?id:\s*$([regex]::Escape($Id))\s*$.*?(?=^- |\z)"
}

function Get-EntryPresencePattern([string]$Id) {
    return "(?m)^\s*- (insert:\s*\r?\n\s*- )?id:\s*$([regex]::Escape($Id))\s*$"
}

function Remove-EntryFromPatch([string]$Text, [string]$Id) {
    $pattern = Get-EntryPattern $Id
    if ($Text -match (Get-EntryPresencePattern $Id)) {
        $next = [regex]::Replace($Text, $pattern, '')
        $next = $next -replace "(\r?\n){3,}", "`r`n`r`n"
        return $next
    }
    return $Text
}

function Set-EntryInPatch([string]$Text, [string]$Block) {
    $pattern = Get-EntryPattern $EntryId
    if ($Text -match (Get-EntryPresencePattern $EntryId)) {
        # Replace in place, keeping the entry where the user's file has it.
        return [regex]::Replace($Text, $pattern, ($Block.TrimEnd() + "`r`n"))
    }

    # An EMPTY entry list is a legal starting point: dsh's own `cordis.yml` ships as `[]`. Appending to
    # it would produce `[]` followed by entries, which is not a valid array, so the placeholder line is
    # replaced instead of kept.
    $meaningful = @(($Text -split "`r?`n") | Where-Object { $_.Trim() -ne '' -and $_.Trim() -notmatch '^#' })
    if ($meaningful.Count -eq 1 -and $meaningful[0].Trim() -eq '[]') {
        $header = @(($Text -split "`r?`n") | Where-Object { $_ -notmatch '^\s*\[\]\s*$' })
        $headerText = ($header -join "`r`n")
        if ($headerText -ne '' -and -not $headerText.EndsWith("`n")) { $headerText += "`r`n" }
        return $headerText + $Block.TrimEnd() + "`r`n"
    }

    $firstEntry = [regex]::Match($Text, '(?m)^- ')
    if ($firstEntry.Success) {
        return $Text.Substring(0, $firstEntry.Index) + $Block.TrimEnd() + "`r`n" + $Text.Substring($firstEntry.Index)
    }
    if (-not $Text.EndsWith("`n")) { $Text += "`r`n" }
    return $Text + $Block.TrimEnd() + "`r`n"
}

# Structural validation of the patch file: a YAML entry list. Each top-level item is either
# `- <key>: ...` with arbitrarily indented continuation lines, or `- insert:` whose nested `- id:`
# rows are the inserted entries. An empty list is legal -- dsh's own `cordis.yml` ships as `[]` -- so
# a scratch/test profile must not be rejected. This is the whole surface this plugin touches, so a
# typo that would break profile composition is caught here instead of at boot.
function Test-PatchStructure([string]$Text) {
    $problems = @()
    $tidy = ($Text -split "`r?`n") | ForEach-Object { $_.TrimEnd() }
    $meaningful = @($tidy | Where-Object { $_.Trim() -ne '' -and $_.Trim() -notmatch '^#' })
    if ($meaningful.Count -eq 0) { return @('the patch file is empty (expected a YAML entry list)') }
    if ($meaningful.Count -eq 1 -and $meaningful[0].Trim() -eq '[]') { return @() }   # empty list
    foreach ($line in $meaningful) {
        if ($line -match '^- ') { continue }                       # top-level entry
        if ($line -match '^\s+- id:\s*\S') { continue }            # an inserted entry
        if ($line -match '^\s+[A-Za-z_][\w-]*:') { continue }      # a field (name/config/…)
        if ($line -match '^\s') { continue }                       # deeper YAML (list item, scalar)
        $problems += "unexpected line: $line"
    }
    if (-not ($meaningful | Where-Object { $_ -match '^- ' })) {
        $problems += 'no top-level entries found (the file must be a YAML array)'
    }
    return $problems
}

function Get-SwitchList([string[]]$Names) {
    $present = @()
    foreach ($n in $Names) { if (Test-Path -LiteralPath (Join-Path $StateDir $n)) { $present += $n } }
    return $present
}

# --- 0. status is read-only ---------------------------------------------------------------------
if ($Status) {
    Write-Output '=== dsh-guard status ==='
    Write-Output "installer        : $InstallerVersion"
    Write-Output "profile          : $ProfileDir"
    Write-Output ''
    $hasEntry = (Test-Path -LiteralPath $patchPath) -and ((Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8) -match (Get-EntryPresencePattern $EntryId))
    Write-Output "patch entry      : $(if ($hasEntry) { "present (id=$EntryId)" } else { 'ABSENT' })"
    Write-Output "patch file       : $patchPath"
    Write-Output "module           : $modulePath"
    Write-Output "                   $(if (Test-Path -LiteralPath $modulePath) { (Get-Sha256 $modulePath) } else { '(missing)' })"
    Write-Output "source module    : $sourceModule"
    Write-Output "                   $(Get-Sha256 $sourceModule)"
    if ((Get-Sha256 $modulePath) -ne '' -and (Get-Sha256 $modulePath) -eq (Get-Sha256 $sourceModule)) {
        Write-Output '                   same revision as this source tree'
    } elseif (Test-Path -LiteralPath $modulePath) {
        Write-Output '                   DIFFERS from this source tree (update with -Mode install)'
    }
    Write-Output "config file      : $configPath $(if (Test-Path -LiteralPath $configPath) { '' } else { '(missing)' })"
    if (Test-Path -LiteralPath $configPath) {
        try {
            $cfg = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
            Write-Output "                   enabled=$($cfg.enabled) gating=$($cfg.gating) statusLine=$($cfg.statusLine)"
            Write-Output "                   workspace(fallback)=$($cfg.workspace)"
            Write-Output "                   stateDir=$($cfg.stateDir)"
        } catch { Write-Output '                   (unreadable JSON)' }
    }
    $markerPath = Join-Path $ProfileDir 'dsh-guard-native-loaded.txt'
    Write-Output "load receipt     : $markerPath"
    if (Test-Path -LiteralPath $markerPath) { Write-Output ("                   last load: " + (((Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8) -split "`r?`n---`r?`n" | Where-Object { $_.Trim() -ne '' })[-1] -replace "`r?`n", '  ')) }
    $statusRouteTrace = Join-Path $ProfileDir 'dsh-guard-native-status-route.txt'
    if (Test-Path -LiteralPath $statusRouteTrace) {
        Write-Output "route trace      : $statusRouteTrace"
        Get-Content -LiteralPath $statusRouteTrace -Encoding UTF8 | Select-Object -Last 3 | ForEach-Object { Write-Output ("                   " + $_) }
    }
    # Status must report the EFFECTIVE paths: the config file if it exists, else the CLI values with
    # the same defaults the install path uses. Reading an empty CLI switch here produced an empty
    # ledger path and a parameter-binding error.
    $effDshHome = if ($DshHome) { $DshHome } else { Join-Path $env:USERPROFILE '.dsh' }
    $effStateDir = $StateDir
    $effAuditLog = $AuditLog
    $cfgForStatus = $null
    if (Test-Path -LiteralPath $configPath) {
        try { $cfgForStatus = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfgForStatus = $null }
    }
    if ($cfgForStatus) {
        if ($cfgForStatus.dshHome) { $effDshHome = [string]$cfgForStatus.dshHome }
        if ($cfgForStatus.stateDir) { $effStateDir = [string]$cfgForStatus.stateDir }
        if ($cfgForStatus.auditLog) { $effAuditLog = [string]$cfgForStatus.auditLog }
    }
    if (-not $effStateDir) { $effStateDir = Join-Path $effDshHome 'emergency' }
    if (-not $effAuditLog) { $effAuditLog = Join-Path $effStateDir 'guard-audit.jsonl' }
    $ledger = $effAuditLog
    Write-Output "audit ledger     : $ledger"
    if (Test-Path -LiteralPath $ledger) {
        $rows = @(Get-Content -LiteralPath $ledger -Encoding UTF8 | Where-Object { $_.Trim() -ne '' })
        Write-Output "                   $($rows.Count) rows"
    }
    $switchDir = $effStateDir
    $switches = @()
    foreach ($n in @('DISABLE', 'PANIC', 'HARD-STOP')) { if (Test-Path -LiteralPath (Join-Path $switchDir $n)) { $switches += $n } }
    Write-Output "emergency        : $(if ($switches.Count) { $switches -join ', ' } else { 'none' })  (state dir: $switchDir)"
    Write-Output ''
    Write-Output 'restart dsh after changing the entry or the module; config-only changes also need a restart'
    Write-Output 'because the loader reads the patch layer once at startup.'
    return
}

# --- 1. resolve ---------------------------------------------------------------------------------
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $sourceModule)) { throw "missing plugin module: $sourceModule" }
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "profile directory not found: $ProfileDir (run dsh once to create it, or pass -ProfileDir)" }
if (-not (Test-Path -LiteralPath $patchPath)) { throw "cordis.patch.yml not found in $ProfileDir" }

if (-not $StateDir) { $StateDir = Join-Path $DshHome 'emergency' }
if (-not $AuditLog) { $AuditLog = Join-Path $StateDir 'guard-audit.jsonl' }
if (-not $LoadMarker) { $LoadMarker = Join-Path $ProfileDir 'dsh-guard-native-loaded.txt' }
if ($ProtectedRoots.Count -eq 0) { $ProtectedRoots = @($env:USERPROFILE, 'C:\') }

$enabledValue = Resolve-Bool $Enabled $true
$gatingValue = Resolve-Bool $Gating $true
# statusLine accepts true / false / full / brief. `brief` is a mode, not a boolean.
$statusLineMode = $StatusLine.Trim().ToLowerInvariant()
if ($statusLineMode -eq 'brief' -or $statusLineMode -eq 'full') {
    $statusLineValue = ($statusLineMode -eq 'full')
    $statusLineYaml = if ($statusLineMode -eq 'brief') { 'brief' } else { 'true' }
} else {
    $statusLineValue = Resolve-Bool $StatusLine $true
    $statusLineYaml = ConvertTo-JsonBool $statusLineValue
}

$sourceHash = Get-Sha256 $sourceModule
$installedHash = Get-Sha256 $modulePath
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# The manifest records the revision the offline matrix passed against. A mismatch is a WARNING (not a
# refusal): someone may be installing a deliberate local edit. Silently shipping an untested gate is
# what this check exists to prevent, so it is loud.
$manifestPath = Join-Path $projectRoot 'manifest.json'
$manifestHash = ''
if (Test-Path -LiteralPath $manifestPath) {
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $manifestHash = [string]$manifest.sha256
    } catch { $manifestHash = '' }
}
if ($manifestHash -and ($manifestHash.ToUpperInvariant() -ne $sourceHash)) {
    Write-Warning "lib/index.mjs does not match the recorded revision in manifest.json"
    Write-Warning "  manifest: $manifestHash"
    Write-Warning "  file    : $sourceHash"
    Write-Warning "the offline matrix may not cover this edit; run: node test/matrix.mjs  then  node scripts/sync-source.mjs --record"
}

Write-Output "dsh-guard $Mode plan"
Write-Output "  installer    : $InstallerVersion"
Write-Output "  profile      : $ProfileDir"
Write-Output "  entry id     : $EntryId"
Write-Output "  module       : $sourceModule"
Write-Output "             ->  $modulePath"
Write-Output "                 $sourceHash"
Write-Output "  installed    : $(if ($installedHash) { $installedHash } else { '(absent)' })"
Write-Output "  config       : $configPath"
Write-Output "  state dir    : $StateDir"
Write-Output "  ledger       : $AuditLog"
Write-Output "  load marker  : $LoadMarker"
Write-Output "  roots        : $($ProtectedRoots -join ', ')"
Write-Output "  falls back to: $(if ($Workspace) { $Workspace } else { "(unset: each call uses its session's cwd)" })"
Write-Output ''

# --- 2. uninstall -------------------------------------------------------------------------------
if ($Mode -eq 'uninstall') {
    $patch = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
    $next = Remove-EntryFromPatch $patch $EntryId
    $removed = $next -ne $patch
    if ($DryRun) {
        Write-Step "dry run: would remove the patch entry (present: $removed)"
        Write-Step "dry run: would delete $modulePath, $configPath, $statusPath"
        Write-Output ''
        Write-Output '(dry run: nothing was written)'
        return
    }
    if ($removed) {
        $backup = "$patchPath.bak-$stamp"
        Copy-Item -LiteralPath $patchPath -Destination $backup -Force
        [System.IO.File]::WriteAllText($patchPath, $next, (New-Object System.Text.UTF8Encoding($false)))
        Write-Step "patch entry removed (backup: $backup)"
    } else {
        Write-Step 'patch entry was already absent'
    }
    foreach ($f in @($modulePath, $configPath, $statusPath)) {
        if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Step "deleted $f" }
    }
    Write-Output ''
    Write-Output 'the audit ledger and the emergency switches were NOT touched:'
    Write-Output "  ledger : $AuditLog"
    Write-Output "  state  : $StateDir"
    Write-Output ''
    if (-not $NoRestart) { Write-Output 'restart dsh to drop the entry from the composed profile.' }
    return
}

# --- 3. install / update ------------------------------------------------------------------------
# JSON is assembled field by field rather than with ConvertTo-Json: the file is hand-readable,
# the key order is stable across PowerShell versions, and nothing depends on a JSON library being
# present. Every value is escaped by ConvertTo-JsonString / ConvertTo-JsonBool.
#
# Defined in section 1 below (before first use): a helper used while resolving options must already
# exist at that point in the script.

$configLines = @()
$configLines += '{'
$configLines += '  "enabled": ' + (ConvertTo-JsonBool $enabledValue) + ','
$configLines += '  "gating": ' + (ConvertTo-JsonBool $gatingValue) + ','
$statusJson = if ($statusLineMode -eq 'brief') { '"brief"' } else { ConvertTo-JsonBool $statusLineValue }
$configLines += '  "statusLine": ' + $statusJson + ','
$configLines += '  "workspace": ' + (ConvertTo-JsonString $Workspace) + ','
$configLines += '  "dshHome": ' + (ConvertTo-JsonString $DshHome) + ','
$configLines += '  "stateDir": ' + (ConvertTo-JsonString $StateDir) + ','
$configLines += '  "auditLog": ' + (ConvertTo-JsonString $AuditLog) + ','
$configLines += '  "loadMarker": ' + (ConvertTo-JsonString $LoadMarker) + ','
$rootsJson = (@($ProtectedRoots | ForEach-Object { ConvertTo-JsonString $_ }) -join ', ')
$extraRootsJson = (@($AdditionalRoots | ForEach-Object { ConvertTo-JsonString $_ }) -join ', ')
$toolsJson = (@($ExtraGatedTools | ForEach-Object { ConvertTo-JsonString $_ }) -join ', ')
$swJson = (@($EmergencySwitches | ForEach-Object { ConvertTo-JsonString $_ }) -join ', ')
$configLines += '  "protectedRoots": [' + $rootsJson + '],'
$configLines += '  "additionalRoots": [' + $extraRootsJson + '],'
$configLines += '  "extraGatedTools": [' + $toolsJson + '],'
$configLines += '  "auditMaxBytes": ' + $AuditMaxBytes + ','
$configLines += '  "auditKeep": ' + $AuditKeep + ','
$configLines += '  "loadMarkerKeep": ' + $LoadMarkerKeep + ','
$configLines += '  "rememberApproved": { "enabled": ' + (ConvertTo-JsonBool ([bool]$RememberApproved)) + ', "ttlSeconds": ' + $RememberSeconds + ' },'
$configLines += '  "emergencySwitches": [' + $swJson + ']'
$configLines += '}'
$configJson = ($configLines -join "`r`n")


# Validate what we are about to write before writing it.
try { $null = $configJson | ConvertFrom-Json } catch { throw "generated config is not valid JSON: $($_.Exception.Message)" }

$specifier = './' + $ModuleFileName
$configLines = New-ConfigLines ([bool]$UseConfigFile) $configPath
$block = New-PatchEntry $specifier $configLines
$patchText = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
$nextPatch = Set-EntryInPatch $patchText $block
$structureProblems = Test-PatchStructure $nextPatch
if ($structureProblems.Count -gt 0) {
    Write-Output 'generated patch file failed structural validation:'
    $structureProblems | ForEach-Object { Write-Output ("  - " + $_) }
    throw 'refusing to write an invalid cordis.patch.yml'
}

if ($DryRun) {
    Write-Output '--- config to write ---'
    Write-Output $configJson
    Write-Output ''
    Write-Output '--- patch entry to write ---'
    Write-Output $block
    Write-Output ''
    Write-Output '--- resulting cordis.patch.yml ---'
    Write-Output $nextPatch
    Write-Output '(dry run: nothing was written)'
    return
}

# Back up both files, then write module + config + patch.
if (Test-Path -LiteralPath $patchPath) {
    $patchBackup = "$patchPath.bak-$stamp"
    Copy-Item -LiteralPath $patchPath -Destination $patchBackup -Force
    Write-Step "backup: $patchBackup"
}
if (Test-Path -LiteralPath $modulePath) {
    Copy-Item -LiteralPath $modulePath -Destination "$modulePath.bak-$stamp" -Force
    Write-Step "backup: $modulePath.bak-$stamp"
}
Copy-Item -LiteralPath $sourceModule -Destination $modulePath -Force
Write-Step "installed module: $modulePath"
if (Test-Path -LiteralPath $sourceStatus) {
    Copy-Item -LiteralPath $sourceStatus -Destination $statusPath -Force
    Write-Step "installed status script: $statusPath"
}
[System.IO.File]::WriteAllText($configPath, $configJson, (New-Object System.Text.UTF8Encoding($false)))
Write-Step "wrote config: $configPath"
[System.IO.File]::WriteAllText($patchPath, $nextPatch, (New-Object System.Text.UTF8Encoding($false)))
Write-Step "wrote patch: $patchPath"

# --- 4. verify what landed ----------------------------------------------------------------------
$ok = $true
$writtenHash = Get-Sha256 $modulePath
if ($writtenHash -ne $sourceHash) { $ok = $false; Write-Output "ERROR: module hash mismatch after copy ($writtenHash)" }
$readPatch = Get-Content -LiteralPath $patchPath -Raw -Encoding UTF8
if (-not ($readPatch -match (Get-EntryPresencePattern $EntryId))) { $ok = $false; Write-Output 'ERROR: entry not present after write' }
try { $null = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
catch { $ok = $false; Write-Output "ERROR: written config is not valid JSON ($($_.Exception.Message))" }

if (Get-Command node -ErrorAction SilentlyContinue) {
    $testFile = Join-Path $projectRoot 'test\matrix.mjs'
    if (Test-Path -LiteralPath $testFile) {
        Write-Output ''
        Write-Output 'running the offline test matrix...'
        # The matrix deliberately prints to stderr in one case (it asserts that a failing
        # agent.inject() never escapes into session creation), and with $ErrorActionPreference =
        # 'Stop' PowerShell 5.1 turns ANY native-command stderr into a terminating error -- so a
        # passing matrix was reported as a failed install. The preference is relaxed for this call
        # only; the verdict still comes from the exit code and the ALL PASS line.
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $out = & node $testFile 2>&1
            $nodeExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousEap
        }
        $summary = @($out | Select-String -Pattern 'ALL PASS|FAILURES')
        if ($summary) { Write-Step ($summary[-1].ToString().Trim()) }
        if ($nodeExit -ne 0) { $ok = $false; Write-Output "ERROR: the offline matrix failed (exit $nodeExit)" }
    }
}

Write-Output ''
if (-not $ok) {
    Write-Output 'verification FAILED -- roll back with:'
    Write-Output "  Copy-Item '$patchPath.bak-$stamp' '$patchPath' -Force"
    Write-Output "  Copy-Item '$modulePath.bak-$stamp' '$modulePath' -Force"
    exit 1
}

Write-Output 'installed and verified.'
Write-Output ''
Write-Output 'rollback:'
Write-Output "  Copy-Item '$patchPath.bak-$stamp' '$patchPath' -Force"
if (Test-Path -LiteralPath "$modulePath.bak-$stamp") { Write-Output "  Copy-Item '$modulePath.bak-$stamp' '$modulePath' -Force" }
Write-Output ''
if (-not $NoRestart) {
    Write-Output 'NEXT: restart dsh. After the restart:'
    Write-Output '  * the session status line reports "workspace: <that session''s own cwd>"'
    Write-Output '  * a bulk/traversal pwsh command or a write outside the session workspace asks once,'
    Write-Output '    with one classified sentence first (e.g. "dsh-guard: BULK DELETES paths OUTSIDE this project workspace")'
    Write-Output '  * reading files, and single-file writes inside the workspace, ask nothing'
    Write-Output '  * the status page answers at <the URL dsh reports in DSH_WEB_URL>/dsh-guard/status (`?format=json` for JSON)'
    Write-Output "  * the load receipt is appended at $LoadMarker"
}
