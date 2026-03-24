<#
.SYNOPSIS
    Collects authentication events from Domain Controller security logs and outputs
    unique computer/account mappings to a JSON file for the Service Account Inventory web app.

.DESCRIPTION
    Queries Windows Security event logs on a Domain Controller for logon events
    (Event ID 4624 - Successful logon, 4768 - Kerberos TGT request,
    4769 - Kerberos service ticket, 4776 - Credential validation via NTLM).
    Extracts unique computer targets, their IP addresses, the OU of the computer
    object in AD, and the accounts that authenticated against each computer.

    Output is a JSON file that can be imported into the web application.

.PARAMETER OutputPath
    Path where the JSON output file will be written. Defaults to script directory.

.PARAMETER MaxEvents
    Maximum number of security log events to process. Default: 0 (all events).

.PARAMETER HoursBack
    How many hours back to query. Default: 24.

.PARAMETER DomainController
    Target DC to query. Default: localhost.

.EXAMPLE
    .\Collect-AuthInventory.ps1
    .\Collect-AuthInventory.ps1 -HoursBack 168 -OutputPath C:\exports
    .\Collect-AuthInventory.ps1 -DomainController DC01.contoso.com -HoursBack 72
#>

[CmdletBinding()]
param(
    [string]$OutputPath = $PSScriptRoot,
    [int]$MaxEvents = 0,
    [int]$HoursBack = 24,
    [string]$DomainController = "localhost",
    [int]$UpnCacheHours = 24,
    [switch]$RefreshUpnCache
)

$ErrorActionPreference = "Continue"

# ── Banner ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Service Account Authentication Inventory                      " -ForegroundColor Cyan
Write-Host "  Collecting from DC security logs                              " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$startTime = Get-Date
$cutoff = $startTime.AddHours(-$HoursBack)

# ── Detect default domain (for 4776 which lacks domain field) ───────────────
$defaultDomain = ''
try {
    if ($env:USERDNSDOMAIN) {
        $defaultDomain = ($env:USERDNSDOMAIN -split '\.')[0].ToUpper()
    } elseif ($env:USERDOMAIN) {
        $defaultDomain = $env:USERDOMAIN.ToUpper()
    }
} catch { }

Write-Host "[*] Domain Controller : $DomainController" -ForegroundColor Yellow
if ($defaultDomain) {
    Write-Host "[*] Default domain    : $defaultDomain" -ForegroundColor Yellow
}

# ── UPN-to-sAMAccountName cache ────────────────────────────────────────────
$upnCachePath = Join-Path $PSScriptRoot 'upn_cache.json'
$upnMap = @{}

function Build-UpnCache {
    param([string]$CachePath)
    Write-Host "[*] Building UPN cache from AD..." -ForegroundColor Yellow
    $map = @{}
    try {
        $searcher = New-Object System.DirectoryServices.DirectorySearcher
        $searcher.Filter = '(&(objectCategory=person)(objectClass=user)(userPrincipalName=*))'
        $searcher.PropertiesToLoad.AddRange(@('sAMAccountName', 'userPrincipalName'))
        $searcher.PageSize = 1000
        $searcher.SizeLimit = 0
        $results = $searcher.FindAll()
        foreach ($r in $results) {
            $upn = [string]$r.Properties['userprincipalname'][0]
            $sam = [string]$r.Properties['samaccountname'][0]
            if ($upn -and $sam) {
                $map[$upn.ToLower()] = $sam
            }
        }
        $results.Dispose()
        $cache = @{ generated_at = (Get-Date).ToString('o'); entries = $map }
        $cache | ConvertTo-Json -Depth 3 -Compress | Set-Content -Path $CachePath -Encoding UTF8
        Write-Host "    Cached $($map.Count) UPN mappings to $(Split-Path $CachePath -Leaf)" -ForegroundColor Green
    } catch {
        Write-Host "    Warning: Could not query AD for UPN cache: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "    Will fall back to string-based UPN handling" -ForegroundColor Yellow
    }
    return $map
}

# Load or refresh the UPN cache
$needsRefresh = $RefreshUpnCache.IsPresent
if (-not $needsRefresh -and (Test-Path $upnCachePath)) {
    try {
        $cacheData = Get-Content $upnCachePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cacheAge = (Get-Date) - [datetime]$cacheData.generated_at
        if ($cacheAge.TotalHours -gt $UpnCacheHours) {
            Write-Host "[*] UPN cache is $([math]::Round($cacheAge.TotalHours, 1))h old, refreshing..." -ForegroundColor Yellow
            $needsRefresh = $true
        } else {
            # Load from cache file
            $cacheData.entries.PSObject.Properties | ForEach-Object { $upnMap[$_.Name] = $_.Value }
            Write-Host "[*] UPN cache loaded  : $($upnMap.Count) mappings (age: $([math]::Round($cacheAge.TotalHours, 1))h)" -ForegroundColor Yellow
        }
    } catch {
        $needsRefresh = $true
    }
} else {
    $needsRefresh = $true
}

if ($needsRefresh) {
    $upnMap = Build-UpnCache -CachePath $upnCachePath
}

Write-Host "[*] Time range        : $($cutoff.ToString('yyyy-MM-dd HH:mm')) to $($startTime.ToString('yyyy-MM-dd HH:mm'))" -ForegroundColor Yellow
Write-Host "[*] Hours back        : $HoursBack" -ForegroundColor Yellow
Write-Host ""

# ── Hashtables to collect unique data ───────────────────────────────────────
$computerMap = @{}   # key=computerName, value=@{ ips=Set; accounts=Set }

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
            # Extract OU portion (everything after the first comma = parent)
            $parts = $dn -split ',', 2
            $ou = if ($parts.Length -gt 1) { $parts[1] } else { $dn }
            $ouCache[$clean] = $ou
            return $ou
        }
    } catch {
        # AD lookup failed, return empty
    }
    $ouCache[$clean] = ""
    return ""
}

# ── Helper: Normalize computer name ─────────────────────────────────────────
function Normalize-ComputerName {
    param([string]$Name)
    if ([string]::IsNullOrWhiteSpace($Name)) { return $null }
    $n = $Name.Trim().TrimStart('\').TrimEnd('$').ToUpper()
    # Skip common noise entries
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

# ── Helper: Normalize account name (strip UPN suffix, prefix domain) ──────────
function Resolve-AccountName {
    param(
        [string]$UserName,
        [string]$Domain
    )
    # Already in DOMAIN\user format: return as-is
    if ($UserName -match '\\') { return $UserName }

    # UPN format (user@domain.com): look up sAMAccountName in cache, fallback to prefix
    if ($UserName -match '^([^@]+)@(.+)$') {
        $upnLower = $UserName.ToLower()
        $d = Normalize-DomainName $Matches[2]
        if ($upnMap.Count -gt 0 -and $upnMap.ContainsKey($upnLower)) {
            $sam = $upnMap[$upnLower]
            if ($d -and $d -ne '-') { return "$d\$sam" }
            return $sam
        }
        # Fallback: use part before @ as username
        $user = $Matches[1]
        if ($d -and $d -ne '-') { return "$d\$user" }
        return $user
    }

    # Plain username: prefix with domain if provided
    if ($Domain) {
        $d = Normalize-DomainName $Domain
        if ($d -and $d -ne '-') { return "$d\$UserName" }
    }
    return $UserName
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

    # Skip machine accounts authenticating to themselves
    $acct = $Account.Trim()
    if ([string]::IsNullOrWhiteSpace($acct) -or $acct -eq '-' -or $acct -eq 'ANONYMOUS LOGON') { return }

    if (-not $computerMap.ContainsKey($comp)) {
        $computerMap[$comp] = @{
            ips      = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            accounts = @{}
        }
    }

    if ($IpAddress -and $IpAddress -ne '-' -and $IpAddress -ne '::1' -and $IpAddress -ne '127.0.0.1') {
        # Strip IPv6 prefix if present
        $ip = $IpAddress -replace '^::ffff:', ''
        $computerMap[$comp].ips.Add($ip) | Out-Null
    }

    if (-not $computerMap[$comp].accounts.ContainsKey($acct)) {
        $computerMap[$comp].accounts[$acct] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    }
    if ($AuthType) { $computerMap[$comp].accounts[$acct].Add($AuthType) | Out-Null }
}

# ── Query Event ID 4624 (Successful Logon) ─────────────────────────────────
Write-Host "[1/5] Querying Event ID 4624 (Successful Logon)..." -ForegroundColor Cyan

$filterXml4624 = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[(EventID=4624) and TimeCreated[timediff(@SystemTime) &lt;= $(($HoursBack * 3600 * 1000))]]]
    </Select>
  </Query>
</QueryList>
"@

try {
    $params4624 = @{
        FilterXml    = $filterXml4624
        ComputerName = $DomainController
        ErrorAction  = "SilentlyContinue"
    }
    if ($MaxEvents -gt 0) { $params4624['MaxEvents'] = $MaxEvents }

    $events4624 = Get-WinEvent @params4624

    $count4624 = 0
    $progress4624 = 0
    foreach ($evt in $events4624) {
        $progress4624++
        if ($progress4624 % 50000 -eq 0) {
            Write-Host "    Processed $progress4624 events..." -ForegroundColor Gray
        }

        $props = $evt.Properties
        if ($props.Count -lt 19) { continue }

        $logonType = [string]$props[8].Value
        # Focus on network (3), batch (4), service (5), remote interactive (10), cached interactive (11)
        if ($logonType -notin @('3', '4', '5', '10', '11')) { continue }

        $targetUser   = [string]$props[5].Value
        $targetDomain = [string]$props[6].Value
        $workstation  = [string]$props[11].Value
        $ipAddress    = [string]$props[18].Value

        # Skip machine accounts (ending in $) and common system accounts
        if ($targetUser -match '\$$') { continue }
        if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE', 'DWM-1', 'DWM-2', 'UMFD-0', 'UMFD-1')) { continue }
        if ($targetDomain -in @('Window Manager', 'Font Driver Host', 'NT AUTHORITY')) { continue }

        $computerName = if ($workstation) { $workstation } else { $DomainController }
        $account = Resolve-AccountName -UserName $targetUser -Domain $targetDomain

        Add-AuthMapping -Computer $computerName -IpAddress $ipAddress -Account $account -AuthType 'Logon'
        $count4624++
    }
    Write-Host "    Found $count4624 relevant logon events from $($events4624.Count) total 4624 events" -ForegroundColor Green
} catch {
    Write-Host "    Warning: Could not query 4624 events: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── Query Event ID 4776 (NTLM Credential Validation) ───────────────────────
Write-Host "[2/5] Querying Event ID 4776 (NTLM Credential Validation)..." -ForegroundColor Cyan

$filterXml4776 = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[(EventID=4776) and TimeCreated[timediff(@SystemTime) &lt;= $(($HoursBack * 3600 * 1000))]]]
    </Select>
  </Query>
</QueryList>
"@

try {
    $params4776 = @{
        FilterXml    = $filterXml4776
        ComputerName = $DomainController
        ErrorAction  = "SilentlyContinue"
    }
    if ($MaxEvents -gt 0) { $params4776['MaxEvents'] = $MaxEvents }

    $events4776 = Get-WinEvent @params4776

    $count4776 = 0
    foreach ($evt in $events4776) {
        $props = $evt.Properties
        if ($props.Count -lt 3) { continue }

        $targetUser  = [string]$props[1].Value
        $workstation = [string]$props[2].Value

        if ([string]::IsNullOrWhiteSpace($targetUser) -or $targetUser -match '\$$') { continue }
        if ($targetUser -in @('SYSTEM', 'LOCAL SERVICE', 'NETWORK SERVICE')) { continue }

        if ($workstation) {
            $ntlmAccount = Resolve-AccountName -UserName $targetUser -Domain $defaultDomain
            Add-AuthMapping -Computer $workstation -IpAddress $null -Account $ntlmAccount -AuthType 'NTLM'
            $count4776++
        }
    }
    Write-Host "    Found $count4776 relevant NTLM events from $($events4776.Count) total 4776 events" -ForegroundColor Green
} catch {
    Write-Host "    Warning: Could not query 4776 events: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── Query Event ID 4769 (Kerberos Service Ticket) ──────────────────────────
Write-Host "[3/5] Querying Event ID 4769 (Kerberos Service Ticket)..." -ForegroundColor Cyan

$filterXml4769 = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[(EventID=4769) and TimeCreated[timediff(@SystemTime) &lt;= $(($HoursBack * 3600 * 1000))]]]
    </Select>
  </Query>
</QueryList>
"@

try {
    $params4769 = @{
        FilterXml    = $filterXml4769
        ComputerName = $DomainController
        ErrorAction  = "SilentlyContinue"
    }
    if ($MaxEvents -gt 0) { $params4769['MaxEvents'] = $MaxEvents }

    $events4769 = Get-WinEvent @params4769

    $count4769 = 0
    foreach ($evt in $events4769) {
        $props = $evt.Properties
        if ($props.Count -lt 9) { continue }

        # Only successful requests (Status 0x0)
        $status = $props[8].Value
        if ($status -ne 0) { continue }

        $targetUser  = [string]$props[0].Value
        $serviceName = [string]$props[2].Value
        $ipAddress   = [string]$props[6].Value

        # Skip machine accounts and krbtgt (TGT renewals)
        if ($targetUser -match '\$$') { continue }
        if ([string]::IsNullOrWhiteSpace($serviceName) -or $serviceName -eq 'krbtgt') { continue }

        # Extract computer name from SPN (format: service/hostname or service/hostname.domain)
        $spnParts = $serviceName -split '/'
        if ($spnParts.Count -lt 2) { continue }
        $spnHost = $spnParts[1] -split '\.' | Select-Object -First 1

        # Resolve UPN to DOMAIN\sAMAccountName via AD lookup
        $account = Resolve-AccountName -UserName $targetUser -Domain ''

        Add-AuthMapping -Computer $spnHost -IpAddress $ipAddress -Account $account -AuthType 'Kerberos'
        $count4769++
    }
    Write-Host "    Found $count4769 relevant Kerberos events from $($events4769.Count) total 4769 events" -ForegroundColor Green
} catch {
    Write-Host "    Warning: Could not query 4769 events: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── Query Event ID 4768 (Kerberos TGT Request) ────────────────────────────
Write-Host "[4/5] Querying Event ID 4768 (Kerberos TGT Request)..." -ForegroundColor Cyan

$filterXml4768 = @"
<QueryList>
  <Query Id="0" Path="Security">
    <Select Path="Security">
      *[System[(EventID=4768) and TimeCreated[timediff(@SystemTime) &lt;= $(($HoursBack * 3600 * 1000))]]]
    </Select>
  </Query>
</QueryList>
"@

try {
    $params4768 = @{
        FilterXml    = $filterXml4768
        ComputerName = $DomainController
        ErrorAction  = "SilentlyContinue"
    }
    if ($MaxEvents -gt 0) { $params4768['MaxEvents'] = $MaxEvents }

    $events4768 = Get-WinEvent @params4768

    $count4768 = 0
    foreach ($evt in $events4768) {
        $props = $evt.Properties
        if ($props.Count -lt 10) { continue }

        # Only successful requests (Status 0x0)
        $status = $props[6].Value
        if ($status -ne 0) { continue }

        $targetUser   = [string]$props[0].Value
        $targetDomain = [string]$props[1].Value
        $ipAddress    = [string]$props[9].Value

        # Skip machine accounts
        if ($targetUser -match '\$$') { continue }
        if ([string]::IsNullOrWhiteSpace($targetUser)) { continue }

        # Reverse-resolve IP to hostname for the source workstation
        $ip = $ipAddress -replace '^::ffff:', ''
        $computerName = Resolve-IpToHostname $ip
        if (-not $computerName) { continue }  # skip if no DNS match

        $account = Resolve-AccountName -UserName $targetUser -Domain $targetDomain

        Add-AuthMapping -Computer $computerName -IpAddress $ip -Account $account -AuthType 'Kerberos'
        $count4768++
    }
    Write-Host "    Found $count4768 relevant TGT events from $($events4768.Count) total 4768 events" -ForegroundColor Green
} catch {
    Write-Host "    Warning: Could not query 4768 events: $($_.Exception.Message)" -ForegroundColor Yellow
}

# ── Resolve OUs ─────────────────────────────────────────────────────────────
Write-Host "[5/5] Resolving OUs for $($computerMap.Count) computers..." -ForegroundColor Cyan
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
$output = @{
    collected_at     = $startTime.ToString("o")
    domain_controller = $DomainController
    hours_back       = $HoursBack
    computers        = @()
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

$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Collection Complete                                          " -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Computers found    : $($computerMap.Count)" -ForegroundColor White
Write-Host "  Unique accounts    : $uniqueAccounts" -ForegroundColor White
Write-Host "  Total mappings     : $totalAccounts" -ForegroundColor White
Write-Host "  OUs resolved       : $ouResolved" -ForegroundColor White
Write-Host "  Elapsed time       : $($elapsed.ToString('mm\:ss'))" -ForegroundColor White
Write-Host "  Output file        : $filePath" -ForegroundColor White
Write-Host ""
