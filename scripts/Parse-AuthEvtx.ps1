<#
.SYNOPSIS
    Parses exported Security .evtx files locally and produces a JSON file
    for the Service Account Inventory web app.

.DESCRIPTION
    Designed to run on a domain-joined jumphost (not the DC). The workflow is:

    1. Export filtered events from the DC using wevtutil (fast, minimal DC load):
         wevtutil epl Security C:\Temp\dc_security.evtx /q:"*[System[(EventID=4624 or EventID=4776)]]" /r:DC01.contoso.com

    2. Copy the .evtx file to this machine (or use a network share).

    3. Run this script to parse locally:
         .\Parse-AuthEvtx.ps1 -EvtxPath C:\Temp\dc_security.evtx -DomainController DC01.contoso.com

    OU lookups use standard LDAP queries that work from any domain-joined machine.

.PARAMETER EvtxPath
    Path to one or more .evtx files (supports wildcards like C:\Temp\*.evtx).

.PARAMETER OutputPath
    Folder for the JSON output. Defaults to script directory.

.PARAMETER DomainController
    Name of the DC the logs were exported from (stored in output metadata).
    Default: the exporting machine name parsed from the log, or "Unknown".

.PARAMETER HoursBack
    Only process events from the last N hours. Default: 0 (all events in file).

.PARAMETER ExportFromDC
    If specified, automatically runs wevtutil to export filtered events from
    this DC before parsing. Requires network access and admin rights on the DC.

.EXAMPLE
    # Manual two-step: export on DC, parse on jumphost
    # (on DC or via WinRM):
    wevtutil epl Security \\jumphost\c$\temp\dc01_security.evtx /q:"*[System[(EventID=4624 or EventID=4776)]]"
    # (on jumphost):
    .\Parse-AuthEvtx.ps1 -EvtxPath C:\temp\dc01_security.evtx -DomainController DC01

.EXAMPLE
    # Automatic: export + parse in one step (needs admin rights to the DC)
    .\Parse-AuthEvtx.ps1 -ExportFromDC DC01.contoso.com -HoursBack 72

.EXAMPLE
    # Parse multiple files
    .\Parse-AuthEvtx.ps1 -EvtxPath C:\Exports\*.evtx
#>

[CmdletBinding(DefaultParameterSetName = 'ParseLocal')]
param(
    [Parameter(ParameterSetName = 'ParseLocal', Mandatory = $true)]
    [string]$EvtxPath,

    [Parameter(ParameterSetName = 'ExportAndParse', Mandatory = $true)]
    [string]$ExportFromDC,

    [string]$OutputPath = $PSScriptRoot,
    [string]$DomainController = "",
    [int]$HoursBack = 0
)

$ErrorActionPreference = "Continue"

# ── Banner ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service Account Authentication Inventory                      " -ForegroundColor Cyan
Write-Host "  Local .evtx parser (jumphost mode)                            " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$startTime = Get-Date

# ── Auto-export from DC if requested ───────────────────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'ExportAndParse') {
    $DomainController = $ExportFromDC

    $tempDir = Join-Path $env:TEMP "AuthInventory"
    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

    $exportFile = Join-Path $tempDir "dc_security_$(Get-Date -Format 'yyyyMMdd_HHmmss').evtx"

    # Build XPath filter: always filter by EventID, optionally by time
    $xpathParts = @("EventID=4624 or EventID=4776")
    if ($HoursBack -gt 0) {
        $ms = $HoursBack * 3600 * 1000
        $xpathParts += "TimeCreated[timediff(@SystemTime) <= $ms]"
    }
    $xpath = "*[System[($($xpathParts[0])) and $($xpathParts[1..99] -join ' and ')]]"
    if ($HoursBack -le 0) {
        $xpath = "*[System[($($xpathParts[0]))]]"
    }

    Write-Host "[*] Exporting from DC : $ExportFromDC" -ForegroundColor Yellow
    Write-Host "[*] XPath filter      : $xpath" -ForegroundColor Yellow
    Write-Host "[*] Temp file         : $exportFile" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[1/4] Exporting Security log via wevtutil..." -ForegroundColor Cyan

    try {
        $wevtArgs = @("epl", "Security", $exportFile, "/q:$xpath", "/r:$ExportFromDC", "/ow:true")
        & wevtutil @wevtArgs 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "    ERROR: wevtutil failed (exit code $LASTEXITCODE)" -ForegroundColor Red
            Write-Host "    Make sure you have admin rights on $ExportFromDC and WinRM/RPC is open." -ForegroundColor Red
            exit 1
        }

        $fileSize = (Get-Item $exportFile).Length
        Write-Host "    Exported $([math]::Round($fileSize / 1MB, 1)) MB" -ForegroundColor Green
    } catch {
        Write-Host "    ERROR: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }

    $EvtxPath = $exportFile
    $stepOffset = 1  # steps shift by 1 since export was step 1
} else {
    $stepOffset = 0
}

# ── Resolve .evtx files ────────────────────────────────────────────────────
$evtxFiles = @(Get-Item $EvtxPath -ErrorAction SilentlyContinue)
if ($evtxFiles.Count -eq 0) {
    Write-Host "ERROR: No .evtx files found matching: $EvtxPath" -ForegroundColor Red
    exit 1
}

Write-Host "[*] Files to parse    : $($evtxFiles.Count)" -ForegroundColor Yellow
foreach ($f in $evtxFiles) {
    $sz = [math]::Round($f.Length / 1MB, 1)
    Write-Host "    $($f.Name) ($sz MB)" -ForegroundColor Yellow
}
if ($DomainController) {
    Write-Host "[*] Domain Controller : $DomainController" -ForegroundColor Yellow
}
if ($HoursBack -gt 0) {
    $cutoff = $startTime.AddHours(-$HoursBack)
    Write-Host "[*] Time filter       : events after $($cutoff.ToString('yyyy-MM-dd HH:mm'))" -ForegroundColor Yellow
}
Write-Host ""

# ── Hashtables to collect unique data ───────────────────────────────────────
$computerMap = @{}

# ── Helper: Resolve OU from AD ──────────────────────────────────────────────
$ouCache = @{}
function Get-ComputerOU {
    param([string]$ComputerName)
    if ([string]::IsNullOrWhiteSpace($ComputerName)) { return "" }
    $clean = $ComputerName.TrimEnd('$').ToUpper()
    if ($ouCache.ContainsKey($clean)) { return $ouCache[$clean] }

    try {
        $searcher = New-Object System.DirectoryServices.DirectorySearcher
        $searcher.Filter = "(&(objectClass=computer)(sAMAccountName=$clean`$))"
        $searcher.PropertiesToLoad.Add("distinguishedName") | Out-Null
        $result = $searcher.FindOne()
        if ($result) {
            $dn = $result.Properties["distinguishedname"][0]
            $parts = $dn -split ',', 2
            $ou = if ($parts.Length -gt 1) { $parts[1] } else { $dn }
            $ouCache[$clean] = $ou
            return $ou
        }
    } catch { }
    $ouCache[$clean] = ""
    return ""
}

# ── Helper: Normalize computer name ─────────────────────────────────────────
function Normalize-ComputerName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    $n = $Name.Trim().TrimEnd('$').ToUpper()
    if ($n -eq '-' -or $n -eq '' -or $n -eq 'LOCALHOST' -or $n.Length -lt 2) { return $null }
    return $n
}

# ── Helper: Add an auth mapping ─────────────────────────────────────────────
function Add-AuthMapping {
    param(
        [string]$Computer,
        [string]$IpAddress,
        [string]$Account
    )

    $comp = Normalize-ComputerName $Computer
    if (-not $comp) { return }

    $acct = $Account.Trim()
    if ([string]::IsNullOrWhiteSpace($acct) -or $acct -eq '-' -or $acct -eq 'ANONYMOUS LOGON') { return }

    if (-not $computerMap.ContainsKey($comp)) {
        $computerMap[$comp] = @{
            ips      = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            accounts = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        }
    }

    if ($IpAddress -and $IpAddress -ne '-' -and $IpAddress -ne '::1' -and $IpAddress -ne '127.0.0.1') {
        $ip = $IpAddress -replace '^::ffff:', ''
        $computerMap[$comp].ips.Add($ip) | Out-Null
    }

    $computerMap[$comp].accounts.Add($acct) | Out-Null
}

# ── Parse each .evtx file ──────────────────────────────────────────────────
$stepParse = $stepOffset + 1
Write-Host "[$stepParse/$(3 + $stepOffset)] Parsing .evtx files..." -ForegroundColor Cyan

$total4624 = 0
$total4776 = 0
$totalRaw  = 0

foreach ($evtxFile in $evtxFiles) {
    Write-Host "    Parsing $($evtxFile.Name)..." -ForegroundColor Gray

    $filterXml = @"
<QueryList>
  <Query Id="0" Path="file://$($evtxFile.FullName)">
    <Select Path="file://$($evtxFile.FullName)">
      *[System[(EventID=4624 or EventID=4776)]]
    </Select>
  </Query>
</QueryList>
"@

    try {
        $events = Get-WinEvent -FilterXml $filterXml -ErrorAction SilentlyContinue
    } catch {
        Write-Host "    Warning: Could not read $($evtxFile.Name): $($_.Exception.Message)" -ForegroundColor Yellow
        continue
    }

    if (-not $events) {
        Write-Host "    No matching events in $($evtxFile.Name)" -ForegroundColor Yellow
        continue
    }

    $totalRaw += $events.Count
    $fileCount4624 = 0
    $fileCount4776 = 0

    foreach ($evt in $events) {
        # Optional time filter (if user specified -HoursBack and didn't use ExportFromDC with time filter)
        if ($HoursBack -gt 0 -and $evt.TimeCreated -lt $cutoff) { continue }

        $xml = [xml]$evt.ToXml()
        $ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
        $ns.AddNamespace("e", "http://schemas.microsoft.com/win/2004/08/events/event")

        if ($evt.Id -eq 4624) {
            $logonType = ($xml.SelectSingleNode("//e:Data[@Name='LogonType']", $ns)).'#text'
            if ($logonType -notin @('3', '4', '5', '10', '11')) { continue }

            $targetUser   = ($xml.SelectSingleNode("//e:Data[@Name='TargetUserName']", $ns)).'#text'
            $targetDomain = ($xml.SelectSingleNode("//e:Data[@Name='TargetDomainName']", $ns)).'#text'
            $workstation  = ($xml.SelectSingleNode("//e:Data[@Name='WorkstationName']", $ns)).'#text'
            $ipAddress    = ($xml.SelectSingleNode("//e:Data[@Name='IpAddress']", $ns)).'#text'

            if ($targetUser -match '\$$') { continue }
            if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'DWM-1', 'DWM-2', 'UMFD-0', 'UMFD-1')) { continue }
            if ($targetDomain -in @('Window Manager', 'Font Driver Host', 'NT AUTHORITY')) { continue }

            $computerName = if ($workstation) { $workstation } else { $DomainController }
            $account = if ($targetDomain -and $targetDomain -ne '-') { "$targetDomain\$targetUser" } else { $targetUser }

            Add-AuthMapping -Computer $computerName -IpAddress $ipAddress -Account $account
            $fileCount4624++
        }
        elseif ($evt.Id -eq 4776) {
            $targetUser  = ($xml.SelectSingleNode("//e:Data[@Name='TargetUserName']", $ns)).'#text'
            $workstation = ($xml.SelectSingleNode("//e:Data[@Name='Workstation']", $ns)).'#text'

            if ([string]::IsNullOrWhiteSpace($targetUser) -or $targetUser -match '\$$') { continue }
            if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE')) { continue }

            if ($workstation) {
                Add-AuthMapping -Computer $workstation -IpAddress $null -Account $targetUser
                $fileCount4776++
            }
        }
    }

    $total4624 += $fileCount4624
    $total4776 += $fileCount4776
    Write-Host "    $($evtxFile.Name): $fileCount4624 logon + $fileCount4776 NTLM events (from $($events.Count) raw)" -ForegroundColor Green
}

Write-Host "    Total: $total4624 logon + $total4776 NTLM events from $totalRaw raw events" -ForegroundColor Green

# ── Resolve OUs ─────────────────────────────────────────────────────────────
$stepOU = $stepOffset + 2
Write-Host "[$stepOU/$(3 + $stepOffset)] Resolving OUs for $($computerMap.Count) computers..." -ForegroundColor Cyan
$ouResolved = 0
foreach ($compName in @($computerMap.Keys)) {
    $ou = Get-ComputerOU $compName
    $computerMap[$compName].ou = $ou
    if ($ou) { $ouResolved++ }

    if ($ouResolved % 50 -eq 0 -and $ouResolved -gt 0) {
        Write-Host "    Resolved $ouResolved OUs..." -ForegroundColor Gray
    }
}
Write-Host "    Resolved $ouResolved / $($computerMap.Count) computer OUs" -ForegroundColor Green

# ── Build output ────────────────────────────────────────────────────────────
$stepOut = $stepOffset + 3
Write-Host "[$stepOut/$(3 + $stepOffset)] Writing output..." -ForegroundColor Cyan

$output = @{
    collected_at      = $startTime.ToString("o")
    domain_controller = if ($DomainController) { $DomainController } else { "Unknown" }
    hours_back        = $HoursBack
    source_files      = @($evtxFiles | ForEach-Object { $_.Name })
    computers         = @()
}

foreach ($compName in ($computerMap.Keys | Sort-Object)) {
    $entry = $computerMap[$compName]
    $output.computers += @{
        name     = $compName
        ips      = @($entry.ips | Sort-Object)
        ou       = $entry.ou
        accounts = @($entry.accounts | Sort-Object)
    }
}

$totalAccounts = ($computerMap.Values | ForEach-Object { $_.accounts.Count } | Measure-Object -Sum).Sum
$uniqueAccounts = ($computerMap.Values | ForEach-Object { $_.accounts } | Sort-Object -Unique).Count

# ── Write JSON ──────────────────────────────────────────────────────────────
$timestamp = $startTime.ToString("yyyyMMdd_HHmmss")
$fileName = "auth_inventory_${timestamp}.json"
$filePath = Join-Path $OutputPath $fileName

$output | ConvertTo-Json -Depth 5 | Set-Content -Path $filePath -Encoding UTF8

# ── Cleanup temp export if we created one ───────────────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'ExportAndParse') {
    Remove-Item $exportFile -Force -ErrorAction SilentlyContinue
    Write-Host "    Cleaned up temp export file" -ForegroundColor Gray
}

$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Parsing Complete                                              " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Files parsed       : $($evtxFiles.Count)" -ForegroundColor White
Write-Host "  Raw events         : $totalRaw" -ForegroundColor White
Write-Host "  Logon (4624)       : $total4624" -ForegroundColor White
Write-Host "  NTLM (4776)       : $total4776" -ForegroundColor White
Write-Host "  Computers found    : $($computerMap.Count)" -ForegroundColor White
Write-Host "  Unique accounts    : $uniqueAccounts" -ForegroundColor White
Write-Host "  Total mappings     : $totalAccounts" -ForegroundColor White
Write-Host "  OUs resolved       : $ouResolved" -ForegroundColor White
Write-Host "  Elapsed time       : $($elapsed.ToString('mm\:ss'))" -ForegroundColor White
Write-Host "  Output file        : $filePath" -ForegroundColor White
Write-Host ""
