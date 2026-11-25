<#
dsh-guard 状态查询（随时可查，只读）

两种用法：
  1) 直接跑，看人类可读的报告：
       powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1
  2) 机器可读（供别的脚本/我调用）：
       powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\status.ps1 -Json

它只读四个来源，不做任何判定、不写任何文件：
  * 审计台账   %USERPROFILE%\.dsh\emergency\guard-audit.jsonl
  * 三个开关   %USERPROFILE%\.dsh\emergency\{DISABLE,PANIC,HARD-STOP}
  * 装载回执   <profile>\dsh-guard-native-loaded.txt
  * 插件文件   <profile>\dsh-guard-native.mjs（算哈希，与源码对比看是否同一版本）
若 dsh 正在运行且已加载新版插件，还会附带本地状态页 URL（取自 $env:DSH_WEB_URL，因为 dsh 每次启动都换端口）

重启后 dsh 面板里的对应关系：
  * 会话状态行   = 本报告的极简版（每个会话开始时注入一条）
  * 审批弹窗文案 = 命中规则的分类说明（一句话 + 规则名）
  * 完整台账     = 只有本脚本（或读文件）能看到
  * 设置页区块   = 目前没有（见 -Json 输出里 surfaces.settingsSection 的说明）
#>

[CmdletBinding()]
param(
    [switch]$Json,
    # How many recent decisions to list (0 = skip the tail).
    [int]$Tail = 8
)

$ErrorActionPreference = 'Stop'

$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$pluginPath = Join-Path $profileDir 'dsh-guard-native.mjs'
$markerPath = Join-Path $profileDir 'dsh-guard-native-loaded.txt'
$stateDir   = Join-Path $env:USERPROFILE '.dsh\emergency'
$auditPath  = Join-Path $stateDir 'guard-audit.jsonl'
# Resolved from this script's own location, so the report works from any checkout or from the copy the
# installer drops into the profile. It falls back to the plugin file itself when the lib/ layout is
# absent (that is the layout of the installed copy).
$projectRoot = Split-Path -Parent $PSScriptRoot
$libSource = Join-Path $projectRoot 'lib\index.mjs'
$sourcePath = if (Test-Path -LiteralPath $libSource) { $libSource } else { $pluginPath }
# The manifest records the revision the offline matrix passed against; reported so a user can tell an
# untested local edit from a released revision.
$manifestPath = Join-Path $projectRoot 'manifest.json'

function Get-Sha256([string]$p) {
    if (-not $p -or -not (Test-Path -LiteralPath $p)) { return '' }
    try { return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } catch { return '' }
}

# --- provenance ---------------------------------------------------------------
$deployedHash = Get-Sha256 $pluginPath
$sourceHash   = Get-Sha256 $sourcePath
$sameRevision = ($deployedHash -ne '' -and $deployedHash -eq $sourceHash)
$manifestHash = ''
if (Test-Path -LiteralPath $manifestPath) {
    try { $manifestHash = [string](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).sha256 } catch { $manifestHash = '' }
}

$loadedAt = ''; $loadedPid = ''; $loadedNode = ''; $loadedGating = ''; $loadedEnabled = ''
if (Test-Path -LiteralPath $markerPath) {
    $blocks = (Get-Content -LiteralPath $markerPath -Raw) -split "`r?`n---`r?`n" | Where-Object { $_.Trim() -ne '' }
    $last = $blocks[-1]
    foreach ($line in ($last -split "`r?`n")) {
        if ($line -match '^loaded_at=(.*)$')   { $loadedAt = $Matches[1] }
        elseif ($line -match '^pid=(.*)$')     { $loadedPid = $Matches[1] }
        elseif ($line -match '^node=(.*)$')    { $loadedNode = $Matches[1] }
        elseif ($line -match '^gating=(.*)$')  { $loadedGating = $Matches[1] }
        elseif ($line -match '^enabled=(.*)$') { $loadedEnabled = $Matches[1] }
    }
}

$switches = @()
foreach ($n in @('DISABLE', 'PANIC', 'HARD-STOP')) {
    if (Test-Path -LiteralPath (Join-Path $stateDir $n)) { $switches += $n }
}

# --- audit rollup -------------------------------------------------------------
$rows = @()
$unparsable = 0
if (Test-Path -LiteralPath $auditPath) {
    # -Encoding UTF8 is load-bearing: the ledger carries Chinese summaries, and Windows PowerShell
    # 5.1 otherwise decodes it with the ANSI code page. Mangled lines then fail ConvertFrom-Json and
    # get dropped by the catch below -- which is how this report once said "222 rows, deny=0" while
    # the file actually held 264 rows and two denies. Dropped rows are now COUNTED, not hidden.
    foreach ($line in (Get-Content -LiteralPath $auditPath -Encoding UTF8)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $rows += ($line | ConvertFrom-Json) } catch { $unparsable++ }
    }
}
$window = if ($rows.Count -gt 200) { $rows[-200..-1] } else { $rows }
$allow = @($window | Where-Object { $_.decision -eq 'allow' }).Count
$ask   = @($window | Where-Object { $_.decision -eq 'ask' }).Count
$deny  = @($window | Where-Object { $_.decision -eq 'deny' }).Count
$loads = @($rows | Where-Object { $_.decision -eq 'load' }).Count

$mode = if ($loadedEnabled -eq 'false') { 'DISABLED-BY-CONFIG' }
        elseif ($loadedGating -eq 'off') { 'SHADOW (not gating)' }
        else { 'active' }
$disabled = ($mode -eq 'DISABLED-BY-CONFIG') -or ($switches -contains 'DISABLE')
$headline = if ($disabled) { 'DISABLED -- bulk deletions run unattended' }
            elseif ($mode -eq 'active') { 'ACTIVE -- bulk/traversal and out-of-workspace work ask first' }
            else { 'SHADOW -- records but gates nothing' }

$recent = @()
if ($Tail -gt 0) {
    foreach ($r in ($rows | Select-Object -Last $Tail)) {
        $recent += [ordered]@{
            ts        = $r.ts
            tool      = $r.tool
            decision  = $r.decision
            action    = $r.action
            mass      = $r.mass
            scope     = $r.scope
            rules     = if ($r.rules) { @($r.rules) -join ', ' } else { $r.rule }
            summary   = $r.summary
            workspace = $r.workspace
            preview   = if ($r.preview) { $r.preview.Substring(0, [Math]::Min(90, $r.preview.Length)) } else { '' }
        }
    }
}

# Per-rule tallies over the window: which rules actually fire in practice.
$byRule = @{}
foreach ($r in $window) {
    $id = if ($r.rules) { @($r.rules) } else { @($r.rule) }
    foreach ($one in $id) { if ($one) { $byRule[$one] = [int]$byRule[$one] + 1 } }
}

$report = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    headline    = $headline
    mode        = $mode
    emergency   = if ($switches.Count) { $switches -join ', ' } else { 'none' }
    plugin      = [ordered]@{
        deployedFile  = $pluginPath
        deployedHash  = $deployedHash
        sourceFile    = $sourcePath
        sourceHash    = $sourceHash
        sameRevision  = $sameRevision
        manifestHash  = $manifestHash
        testedRevision = ($manifestHash -ne '' -and $manifestHash.ToUpperInvariant() -eq $sourceHash)
        loadedAt      = $loadedAt
        loadedPid     = $loadedPid
        loadedNode    = $loadedNode
        gating        = $loadedGating
        enabled       = $loadedEnabled
    }
    audit       = [ordered]@{
        file       = $auditPath
        rows       = $rows.Count
        unparsable = $unparsable
        loadRows   = $loads
        last200    = [ordered]@{ allow = $allow; ask = $ask; deny = $deny }
    }
    # 24h approval outcomes: the guard's asks, answered by the human. The plugin derives these from
    # session events (approval/asked + approval/decided) and writes them next to the ledger; the
    # panel is the same numbers on both surfaces.
    approvals   = & {
        $path = Join-Path $stateDir 'guard-outcomes.json'
        $out = [ordered]@{
            file = $path; hours = 24; asked = 0; approved = 0; rejected = 0; pending = 0
            approvalRate = $null; autoRejected = 0; byRuleRejected = @(); newest = ''
        }
        if (Test-Path -LiteralPath $path) {
            try {
                $doc = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
                $cutoff = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - (24 * 3600 * 1000)
                $rows24 = @($doc.rows | Where-Object { $_ -and $_.ts -ge $cutoff })
                $approved = @($rows24 | Where-Object { $_.outcome -in @('allowed-once', 'always', 'allowed') }).Count
                $rejected = @($rows24 | Where-Object { $_.outcome -eq 'rejected' }).Count
                $decided = $approved + $rejected
                $byRule = @{}
                foreach ($r in ($rows24 | Where-Object { $_.outcome -eq 'rejected' })) {
                    foreach ($rule in @($r.rules)) { if ($rule) { $byRule[$rule] = 1 + [int]$byRule[$rule] } }
                }
                $top = @($byRule.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 8 |
                    ForEach-Object { [ordered]@{ rule = $_.Key; count = [int]$_.Value } })
                $newest = @($rows24 | Sort-Object ts -Descending | Select-Object -First 1)
                $out.asked = $rows24.Count
                $out.approved = $approved
                $out.rejected = $rejected
                $out.pending = $rows24.Count - $decided
                $out.approvalRate = if ($decided -gt 0) { [math]::Round($approved / $decided, 3) } else { $null }
                $out.autoRejected = @($rows24 | Where-Object { $_.outcome -eq 'rejected' -and $null -ne $_.latencyMs -and [int64]$_.latencyMs -lt 50 }).Count
                $out.byRuleRejected = $top
                $out.newest = if ($newest.Count -gt 0) { [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$newest[0].ts).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ') } else { '' }
            } catch { $out.error = 'guard-outcomes.json is unreadable: ' + $_.Exception.Message }
        }
        $out
    }
    rulesFired  = $byRule
    recent      = $recent
    surfaces    = [ordered]@{
        # dsh picks a fresh port on every launch (observed: 19387 -> 64794 -> 60939 in one day), so a
        # hardcoded URL is dead on arrival. DSH_WEB_URL is exported into every command this shell runs.
        statusPage      = if ($env:DSH_WEB_URL) { $env:DSH_WEB_URL.TrimEnd('/') + '/dsh-guard/status  (JSON: ...?format=json) -- served by the guard when the host web carrier is present' } else { 'unknown: dsh exports DSH_WEB_URL per launch; run this from a dsh shell, or use -BaseUrl' }
        sessionLine     = 'injected once per session as a sourced user message (kind guard-native)'
        approvalDialog  = 'panel shows the classified sentence; the full reason lands in session events approval/asked'
        settingsSection = 'not available from a profile plugin: settings.section is a CLIENT slot and a client contribution must ship a built lib/client.js served as /plugins/<package>/client.js'
    }
}

if ($Json) {
    $report | ConvertTo-Json -Depth 6
    return
}

Write-Output '=== dsh-guard status ==='
Write-Output ("headline      : {0}" -f $headline)
Write-Output ("mode          : {0}    emergency switches: {1}" -f $mode, $report.emergency)
Write-Output ''
Write-Output ("plugin file   : {0}" -f $report.plugin.deployedFile)
Write-Output ("deployed hash : {0}" -f $report.plugin.deployedHash)
Write-Output ("source hash   : {0}    same revision: {1}" -f $report.plugin.sourceHash, $sameRevision)
if ($manifestHash -ne '') {
    $tested = $report.plugin.testedRevision
    Write-Output ("tested rev    : {0}    {1}" -f $manifestHash, $(if ($tested) { 'matches this tree (offline matrix covered it)' } else { 'THIS TREE IS NOT THE RECORDED REVISION -- run node test/matrix.mjs' }))
}
if (-not $sameRevision) {
    Write-Output 'WARNING       : deployed plugin differs from the verified source -- the running build may be older than the tested one'
}
Write-Output ("last load     : {0}  pid={1}  node={2}  gating={3}  enabled={4}" -f $loadedAt, $loadedPid, $loadedNode, $loadedGating, $loadedEnabled)
Write-Output ''
Write-Output ("audit ledger  : {0}" -f $auditPath)
Write-Output ("audit totals  : {0} rows ({1} load markers, {2} unparsable); last-200 allow={3} ask={4} deny={5}" -f $rows.Count, $loads, $unparsable, $allow, $ask, $deny)
Write-Output ''
Write-Output 'approvals (last 24h):'
$ap = $report.approvals
Write-Output ("  asked={0}  approved={1}  rejected={2}  pending={3}{4}" -f $ap.asked, $ap.approved, $ap.rejected, $ap.pending,
    $(if ($null -ne $ap.approvalRate) { '  approval rate=' + [math]::Round($ap.approvalRate * 100) + '%' } else { '' }))
if ($ap.autoRejected -gt 0) {
    Write-Output ("  {0} rejection(s) arrived within 50 ms: no answerer was attached, so the ask failed closed (a silent block, not a human rejection)." -f $ap.autoRejected)
}
if ($ap.byRuleRejected.Count -gt 0) {
    Write-Output '  rejected by rule (a rule that keeps getting rejected needs work):'
    foreach ($r in $ap.byRuleRejected) { Write-Output ("    {0,5}  {1}" -f $r.count, $r.rule) }
}
Write-Output ''
if ($byRule.Count) {
    Write-Output 'rules that fired (in the last 200):'
    foreach ($k in ($byRule.Keys | Sort-Object { -1 * $byRule[$_] })) {
        Write-Output ("  {0,5}  {1}" -f $byRule[$k], $k)
    }
    Write-Output ''
}
if ($recent.Count) {
    Write-Output ("recent decisions (last {0}; times are local):" -f $recent.Count)
    foreach ($r in $recent) {
        $cls = @($r.action, $(if ($r.mass) { 'mass' } else { 'single' }), $r.scope) | Where-Object { $_ } 
        # The ledger stores UTC; print the viewer's local clock so it matches the settings section.
        $when = try { ([datetimeoffset]::Parse([string]$r.ts)).LocalDateTime.ToString('MM-dd HH:mm:ss') } catch { [string]$r.ts }
        Write-Output ("  {0}  {1,-9} {2,-9} [{3}] {4}" -f $when, $r.decision, ($cls -join '/'), $r.rules, $r.preview)
    }
    Write-Output ''
}
Write-Output 'observable surfaces:'
Write-Output ("  status page    : {0}" -f $report.surfaces.statusPage)
Write-Output ("  session line   : {0}" -f $report.surfaces.sessionLine)
Write-Output ("  approval dialog: {0}" -f $report.surfaces.approvalDialog)
Write-Output ("  settings block : {0}" -f $report.surfaces.settingsSection)
