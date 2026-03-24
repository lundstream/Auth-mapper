<#
.SYNOPSIS
    Parses exported Security .evtx files locally and produces a JSON file
    for the Service Account Inventory web app.

.DESCRIPTION
    Designed to run on a domain-joined jumphost (not the DC). The workflow is:

    1. Export filtered events from the DC using wevtutil (fast, minimal DC load):
         wevtutil epl Security C:\Temp\dc_security.evtx /q:"*[System[(EventID=4624 or EventID=4768 or EventID=4769 or EventID=4776)]]" /r:DC01.contoso.com

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
    wevtutil epl Security \\jumphost\c$\temp\dc01_security.evtx /q:"*[System[(EventID=4624 or EventID=4768 or EventID=4769 or EventID=4776)]]"
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

# ── Detect default domain (for 4776 which lacks domain field) ───────────────
$defaultDomain = ''
try {
    if ($env:USERDNSDOMAIN) {
        $defaultDomain = ($env:USERDNSDOMAIN -split '\.')[0].ToUpper()
    } elseif ($env:USERDOMAIN) {
        $defaultDomain = $env:USERDOMAIN.ToUpper()
    }
} catch { }
if ($defaultDomain) {
    Write-Host "[*] Default domain    : $defaultDomain" -ForegroundColor Yellow
}

# ── Auto-export from DC if requested ───────────────────────────────────────
if ($PSCmdlet.ParameterSetName -eq 'ExportAndParse') {
    $DomainController = $ExportFromDC

    $tempDir = Join-Path $env:TEMP "AuthInventory"
    if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

    $exportFile = Join-Path $tempDir "dc_security_$(Get-Date -Format 'yyyyMMdd_HHmmss').evtx"

    # Build XPath filter: always filter by EventID, optionally by time
    $xpathParts = @("EventID=4624 or EventID=4768 or EventID=4769 or EventID=4776")
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
    $n = $Name.Trim().TrimStart('\').TrimEnd('$').ToUpper()
    if ($n -eq '-' -or $n -eq '' -or $n -eq 'LOCALHOST' -or $n.Length -lt 2) { return $null }
    return $n
}

# ── Helper: Normalize domain name (FQDN to NetBIOS) ───────────────────────────
function Normalize-DomainName {
    param([string]$Domain)
    if ([string]::IsNullOrWhiteSpace($Domain) -or $Domain -eq '-') { return $Domain }
    # CONTOSO.COM -> CONTOSO, sub.domain.local -> SUB
    return ($Domain -split '\.')[0].ToUpper()
}

# ── Helper: Reverse-resolve IP to hostname ──────────────────────────────────
$dnsCache = @{}
function Resolve-IpToHostname {
    param([string]$IpAddress)
    if ([string]::IsNullOrWhiteSpace($IpAddress) -or $IpAddress -eq '-' -or $IpAddress -eq '::1' -or $IpAddress -eq '127.0.0.1') { return $null }
    $ip = $IpAddress -replace '^::ffff:', ''
    if ($dnsCache.ContainsKey($ip)) { return $dnsCache[$ip] }
    try {
        $entry = [System.Net.Dns]::GetHostEntry($ip)
        $hostname = ($entry.HostName -split '\.')[0].ToUpper()
        $dnsCache[$ip] = $hostname
        return $hostname
    } catch {
        $dnsCache[$ip] = $null
        return $null
    }
}

# ── Helper: Resolve UPN to DOMAIN\sAMAccountName ────────────────────────────
$upnCache = @{}
function Resolve-AccountName {
    param(
        [string]$UserName,
        [string]$Domain
    )
    # If already in DOMAIN\user format, return as-is
    if ($UserName -match '\\') { return $UserName }

    # Detect UPN format: user@domain.com
    if ($UserName -match '^(.+)@(.+)$') {
        $upn = $UserName
        if ($upnCache.ContainsKey($upn)) { return $upnCache[$upn] }

        # Try AD lookup: find sAMAccountName by UPN
        try {
            $searcher = New-Object System.DirectoryServices.DirectorySearcher
            $searcher.Filter = "(userPrincipalName=$upn)"
            $searcher.PropertiesToLoad.Add('sAMAccountName') | Out-Null
            $searcher.PropertiesToLoad.Add('msDS-PrincipalName') | Out-Null
            $result = $searcher.FindOne()
            if ($result) {
                $sam = [string]$result.Properties['samaccountname'][0]
                $d = Normalize-DomainName ($Matches[2])
                $resolved = if ($d -and $d -ne '-') { "$d\$sam" } else { $sam }
                $upnCache[$upn] = $resolved
                return $resolved
            }
        } catch { }

        # Fallback: strip @domain and use domain prefix (best effort)
        $d = Normalize-DomainName ($Matches[2])
        $fallback = if ($d -and $d -ne '-') { "$d\$($Matches[1])" } else { $Matches[1] }
        $upnCache[$upn] = $fallback
        return $fallback
    }

    # Plain username: prefix with domain if available
    $d = if ($Domain) { Normalize-DomainName $Domain } else { '' }
    return if ($d -and $d -ne '-') { "$d\$UserName" } else { $UserName }
}

# ── Helper: Add an auth mapping ─────────────────────────────────────────────
function Add-AuthMapping {
    param(
        [string]$Computer,
        [string]$IpAddress,
        [string]$Account,
        [string]$AuthType
    )

    $comp = Normalize-ComputerName $Computer
    if (-not $comp) { return }

    $acct = $Account.Trim()
    if ([string]::IsNullOrWhiteSpace($acct) -or $acct -eq '-' -or $acct -eq 'ANONYMOUS LOGON') { return }

    if (-not $computerMap.ContainsKey($comp)) {
        $computerMap[$comp] = @{
            ips      = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            accounts = @{}
        }
    }

    if ($IpAddress -and $IpAddress -ne '-' -and $IpAddress -ne '::1' -and $IpAddress -ne '127.0.0.1') {
        $ip = $IpAddress -replace '^::ffff:', ''
        $computerMap[$comp].ips.Add($ip) | Out-Null
    }

    if (-not $computerMap[$comp].accounts.ContainsKey($acct)) {
        $computerMap[$comp].accounts[$acct] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    }
    if ($AuthType) { $computerMap[$comp].accounts[$acct].Add($AuthType) | Out-Null }
}

# ── Parse each .evtx file ──────────────────────────────────────────────────
$stepParse = $stepOffset + 1
Write-Host "[$stepParse/$(3 + $stepOffset)] Parsing .evtx files..." -ForegroundColor Cyan

$total4624 = 0
$total4768 = 0
$total4769 = 0
$total4776 = 0
$totalRaw  = 0

foreach ($evtxFile in $evtxFiles) {
    Write-Host "    Parsing $($evtxFile.Name)..." -ForegroundColor Gray

    $fileCount4624 = 0
    $fileCount4768 = 0
    $fileCount4769 = 0
    $fileCount4776 = 0
    $fileRaw = 0

    # Use EventLogReader to stream events (constant memory, much faster than Get-WinEvent)
    $query = New-Object System.Diagnostics.Eventing.Reader.EventLogQuery(
        $evtxFile.FullName,
        [System.Diagnostics.Eventing.Reader.PathType]::FilePath,
        "*[System[(EventID=4624 or EventID=4768 or EventID=4769 or EventID=4776)]]"
    )

    try {
        $reader = New-Object System.Diagnostics.Eventing.Reader.EventLogReader($query)
    } catch {
        Write-Host "    Warning: Could not open $($evtxFile.Name): $($_.Exception.Message)" -ForegroundColor Yellow
        continue
    }

    $progressInterval = 50000
    try {
        while ($true) {
            $evt = $reader.ReadEvent()
            if ($null -eq $evt) { break }

            $fileRaw++
            if ($fileRaw % $progressInterval -eq 0) {
                Write-Host "    Processed $fileRaw events..." -ForegroundColor Gray
            }

            # Optional time filter
            if ($HoursBack -gt 0 -and $evt.TimeCreated -lt $cutoff) {
                $evt.Dispose()
                continue
            }

            $id = $evt.Id

            if ($id -eq 4624) {
                # 4624 Properties: [0]SubjectUserSid [1]SubjectUserName [2]SubjectDomainName [3]SubjectLogonId
                # [4]TargetUserSid [5]TargetUserName [6]TargetDomainName [7]TargetLogonId
                # [8]LogonType [9]LogonProcessName [10]AuthenticationPackageName
                # [11]WorkstationName [12]LogonGuid [13]TransmittedServices [14]LmPackageName
                # [15]KeyLength [16]ProcessId [17]ProcessName [18]IpAddress [19]IpPort
                $props = $evt.Properties
                if ($props.Count -lt 19) { $evt.Dispose(); continue }

                $logonType = [string]$props[8].Value
                if ($logonType -notin @('3', '4', '5', '10', '11')) { $evt.Dispose(); continue }

                $targetUser   = [string]$props[5].Value
                $targetDomain = [string]$props[6].Value
                $workstation  = [string]$props[11].Value
                $ipAddress    = [string]$props[18].Value

                if ($targetUser -match '\$$') { $evt.Dispose(); continue }
                if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'DWM-1', 'DWM-2', 'UMFD-0', 'UMFD-1')) { $evt.Dispose(); continue }
                if ($targetDomain -in @('Window Manager', 'Font Driver Host', 'NT AUTHORITY')) { $evt.Dispose(); continue }

                $computerName = if ($workstation) { $workstation } else { $DomainController }
                $domain = Normalize-DomainName $targetDomain
                $account = if ($domain -and $domain -ne '-') { "$domain\$targetUser" } else { $targetUser }

                Add-AuthMapping -Computer $computerName -IpAddress $ipAddress -Account $account -AuthType 'Logon'
                $fileCount4624++
            }
            elseif ($id -eq 4768) {
                # 4768 Kerberos TGT Request (AS-REQ) — maps account to source workstation
                # Properties: [0]TargetUserName [1]TargetDomainName [2]TargetSid [3]ServiceName
                # [4]ServiceSid [5]TicketOptions [6]Status [7]TicketEncryptionType
                # [8]PreAuthType [9]IpAddress [10]IpPort
                $props = $evt.Properties
                if ($props.Count -lt 10) { $evt.Dispose(); continue }

                # Only successful requests (Status 0x0)
                $status = $props[6].Value
                if ($status -ne 0) { $evt.Dispose(); continue }

                $targetUser   = [string]$props[0].Value
                $targetDomain = [string]$props[1].Value
                $ipAddress    = [string]$props[9].Value

                # Skip machine accounts
                if ($targetUser -match '\$$') { $evt.Dispose(); continue }
                if ([string]::IsNullOrWhiteSpace($targetUser)) { $evt.Dispose(); continue }

                # Reverse-resolve IP to hostname for the source workstation
                $ip = $ipAddress -replace '^::ffff:', ''
                $computerName = Resolve-IpToHostname $ip
                if (-not $computerName) { $evt.Dispose(); continue }  # skip if no DNS match

                $account = Resolve-AccountName -UserName $targetUser -Domain $targetDomain

                Add-AuthMapping -Computer $computerName -IpAddress $ip -Account $account -AuthType 'Kerberos'
                $fileCount4768++
            }
            elseif ($id -eq 4769) {
                # 4769 Kerberos Service Ticket (TGS-REQ)
                # Properties: [0]TargetUserName [1]TargetDomainName [2]ServiceName [3]ServiceSid
                # [4]TicketOptions [5]TicketEncryptionType [6]IpAddress [7]IpPort [8]Status
                $props = $evt.Properties
                if ($props.Count -lt 9) { $evt.Dispose(); continue }

                # Only successful requests (Status 0x0)
                $status = $props[8].Value
                if ($status -ne 0) { $evt.Dispose(); continue }

                $targetUser  = [string]$props[0].Value
                $serviceName = [string]$props[2].Value
                $ipAddress   = [string]$props[6].Value

                # Skip machine accounts and krbtgt (TGT renewals)
                if ($targetUser -match '\$$') { $evt.Dispose(); continue }
                if ([string]::IsNullOrWhiteSpace($serviceName) -or $serviceName -eq 'krbtgt') { $evt.Dispose(); continue }

                # Extract computer name from SPN (format: service/hostname or service/hostname.domain)
                $spnParts = $serviceName -split '/'
                if ($spnParts.Count -lt 2) { $evt.Dispose(); continue }
                $spnHost = $spnParts[1] -split '\.' | Select-Object -First 1  # take short name

                # Resolve UPN to DOMAIN\sAMAccountName via AD lookup
                $account = Resolve-AccountName -UserName $targetUser -Domain ''

                Add-AuthMapping -Computer $spnHost -IpAddress $ipAddress -Account $account -AuthType 'Kerberos'
                $fileCount4769++
            }
            elseif ($id -eq 4776) {
                # 4776 Properties: [0]PackageName [1]TargetUserName [2]Workstation [3]Status
                $props = $evt.Properties
                if ($props.Count -lt 3) { $evt.Dispose(); continue }

                $targetUser  = [string]$props[1].Value
                $workstation = [string]$props[2].Value

                if ([string]::IsNullOrWhiteSpace($targetUser) -or $targetUser -match '\$$') { $evt.Dispose(); continue }
                if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE')) { $evt.Dispose(); continue }

                if ($workstation) {
                    $ntlmAccount = if ($defaultDomain) { "$defaultDomain\$targetUser" } else { $targetUser }
                    Add-AuthMapping -Computer $workstation -IpAddress $null -Account $ntlmAccount -AuthType 'NTLM'
                    $fileCount4776++
                }
            }

            $evt.Dispose()
        }
    } finally {
        $reader.Dispose()
    }

    $totalRaw += $fileRaw
    $total4624 += $fileCount4624
    $total4768 += $fileCount4768
    $total4769 += $fileCount4769
    $total4776 += $fileCount4776
    Write-Host "    $($evtxFile.Name): $fileCount4624 logon + $fileCount4768 TGT + $fileCount4769 TGS + $fileCount4776 NTLM (from $fileRaw raw)" -ForegroundColor Green
}

Write-Host "    Total: $total4624 logon + $total4768 TGT + $total4769 TGS + $total4776 NTLM from $totalRaw raw events" -ForegroundColor Green

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
        accounts = @($entry.accounts.GetEnumerator() | Sort-Object Name | ForEach-Object {
            @{ name = $_.Key; auth_types = @($_.Value | Sort-Object) }
        })
    }
}

$totalAccounts = ($computerMap.Values | ForEach-Object { $_.accounts.Count } | Measure-Object -Sum).Sum
$uniqueAccounts = ($computerMap.Values | ForEach-Object { $_.accounts.Keys } | Sort-Object -Unique).Count

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
Write-Host "  Kerberos TGT (4768): $total4768" -ForegroundColor White
Write-Host "  Kerberos TGS (4769): $total4769" -ForegroundColor White
Write-Host "  NTLM (4776)       : $total4776" -ForegroundColor White
Write-Host "  Computers found    : $($computerMap.Count)" -ForegroundColor White
Write-Host "  Unique accounts    : $uniqueAccounts" -ForegroundColor White
Write-Host "  Total mappings     : $totalAccounts" -ForegroundColor White
Write-Host "  OUs resolved       : $ouResolved" -ForegroundColor White
Write-Host "  Elapsed time       : $($elapsed.ToString('mm\:ss'))" -ForegroundColor White
Write-Host "  Output file        : $filePath" -ForegroundColor White
Write-Host ""
