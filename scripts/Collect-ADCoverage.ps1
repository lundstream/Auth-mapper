<#
.SYNOPSIS
    Collects all computer and account objects from Active Directory and outputs
    a coverage snapshot JSON file for gap analysis in the Auth Mapper web app.

.DESCRIPTION
    Queries Active Directory for all enabled computer objects and user/service accounts,
    then outputs a JSON file listing every object. When imported into the Auth Mapper
    web app, it is compared against authentication data to identify computers and
    accounts that exist in AD but have never been seen in security event logs.

    This script can be run standalone from any domain-joined machine.

.PARAMETER OutputPath
    Directory where the JSON output file will be written. Defaults to script directory.

.PARAMETER IncludeDisabled
    Also include disabled computer and account objects (excluded by default).

.PARAMETER ComputersOnly
    Only collect computer objects (skip accounts).

.PARAMETER AccountsOnly
    Only collect account objects (skip computers).

.PARAMETER SearchBase
    Optional AD search base (distinguished name) to limit scope.
    Example: "OU=Servers,DC=contoso,DC=com"

.PARAMETER Server
    Target Domain Controller to query. Default: auto-detect.

.EXAMPLE
    .\Collect-ADCoverage.ps1
    .\Collect-ADCoverage.ps1 -IncludeDisabled
    .\Collect-ADCoverage.ps1 -SearchBase "OU=Servers,DC=contoso,DC=com"
    .\Collect-ADCoverage.ps1 -Server DC01.contoso.com -OutputPath C:\exports
#>

[CmdletBinding()]
param(
    [string]$OutputPath = $PSScriptRoot,
    [switch]$IncludeDisabled,
    [switch]$ComputersOnly,
    [switch]$AccountsOnly,
    [string]$SearchBase,
    [string]$Server
)

$ErrorActionPreference = "Continue"

# ── Banner ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Active Directory Coverage Snapshot                            " -ForegroundColor Cyan
Write-Host "  Collecting AD objects for gap analysis                        " -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

$startTime = Get-Date

# ── AD query helper ─────────────────────────────────────────────────────────
function Search-AD {
    param(
        [string]$Filter,
        [string[]]$Properties,
        [string]$SearchBase,
        [string]$Server
    )

    $searcher = New-Object System.DirectoryServices.DirectorySearcher

    if ($SearchBase) {
        $entry = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$SearchBase")
        $searcher.SearchRoot = $entry
    }
    if ($Server) {
        if ($SearchBase) {
            $entry = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$Server/$SearchBase")
        } else {
            $entry = New-Object System.DirectoryServices.DirectoryEntry("LDAP://$Server")
        }
        $searcher.SearchRoot = $entry
    }

    $searcher.Filter = $Filter
    $searcher.PageSize = 1000
    $searcher.SizeLimit = 0
    foreach ($prop in $Properties) {
        [void]$searcher.PropertiesToLoad.Add($prop)
    }

    $results = $searcher.FindAll()
    $items = @()
    foreach ($r in $results) {
        $items += $r
    }
    $results.Dispose()
    return $items
}

# ── Collect Computers ───────────────────────────────────────────────────────
$computers = @()
if (-not $AccountsOnly) {
    Write-Host "[*] Querying AD for computer objects..." -ForegroundColor Yellow

    if ($IncludeDisabled) {
        $filter = '(objectCategory=computer)'
    } else {
        $filter = '(&(objectCategory=computer)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
    }

    $adComputers = Search-AD -Filter $filter `
        -Properties @('cn', 'distinguishedName', 'operatingSystem', 'whenCreated', 'whenChanged', 'lastLogonTimestamp', 'userAccountControl') `
        -SearchBase $SearchBase -Server $Server

    foreach ($c in $adComputers) {
        $cn   = [string]$c.Properties['cn'][0]
        $dn   = [string]$c.Properties['distinguishedname'][0]
        $os   = if ($c.Properties['operatingsystem'].Count -gt 0) { [string]$c.Properties['operatingsystem'][0] } else { '' }
        $created = if ($c.Properties['whencreated'].Count -gt 0) { ([datetime]$c.Properties['whencreated'][0]).ToString('o') } else { '' }
        $modified = if ($c.Properties['whenchanged'].Count -gt 0) { ([datetime]$c.Properties['whenchanged'][0]).ToString('o') } else { '' }
        $lastLogon = ''
        if ($c.Properties['lastlogontimestamp'].Count -gt 0) {
            try { $lastLogon = [datetime]::FromFileTime([long]$c.Properties['lastlogontimestamp'][0]).ToString('o') } catch { }
        }

        # Extract OU from DN (remove CN=name, part)
        $ou = ''
        if ($dn -match '^CN=[^,]+,(.+)$') {
            $ou = $Matches[1]
        }

        # Detect enabled state
        $uac = 0
        if ($c.Properties['useraccountcontrol'].Count -gt 0) {
            $uac = [int]$c.Properties['useraccountcontrol'][0]
        }
        $enabled = -not [bool]($uac -band 2)

        $computers += [PSCustomObject]@{
            name       = $cn.ToUpper()
            ou         = $ou
            os         = $os
            created    = $created
            modified   = $modified
            last_logon = $lastLogon
            enabled    = $enabled
        }
    }

    Write-Host "    Found $($computers.Count) computer objects" -ForegroundColor Green
}

# ── Resolve domain NetBIOS name (needed for DOMAIN\user prefix) ─────────────
$domain = ''
$domainPrefix = ''
try {
    if ($env:USERDNSDOMAIN) {
        $domain = $env:USERDNSDOMAIN
        $domainPrefix = ($env:USERDNSDOMAIN -split '\.')[0].ToUpper()
    } elseif ($env:USERDOMAIN) {
        $domain = $env:USERDOMAIN
        $domainPrefix = $env:USERDOMAIN.ToUpper()
    }
} catch { }

# ── Collect Accounts ────────────────────────────────────────────────────────
$accounts = @()
if (-not $ComputersOnly) {
    Write-Host "[*] Querying AD for user/service accounts..." -ForegroundColor Yellow

    if ($IncludeDisabled) {
        $filter = '(&(objectCategory=person)(objectClass=user))'
    } else {
        $filter = '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
    }

    $adAccounts = Search-AD -Filter $filter `
        -Properties @('sAMAccountName', 'distinguishedName', 'whenCreated', 'whenChanged', 'lastLogonTimestamp', 'userAccountControl', 'servicePrincipalName') `
        -SearchBase $SearchBase -Server $Server

    foreach ($a in $adAccounts) {
        $sam  = [string]$a.Properties['samaccountname'][0]
        $dn   = [string]$a.Properties['distinguishedname'][0]
        $created = if ($a.Properties['whencreated'].Count -gt 0) { ([datetime]$a.Properties['whencreated'][0]).ToString('o') } else { '' }
        $modified = if ($a.Properties['whenchanged'].Count -gt 0) { ([datetime]$a.Properties['whenchanged'][0]).ToString('o') } else { '' }
        $lastLogon = ''
        if ($a.Properties['lastlogontimestamp'].Count -gt 0) {
            try { $lastLogon = [datetime]::FromFileTime([long]$a.Properties['lastlogontimestamp'][0]).ToString('o') } catch { }
        }
        $hasSPN = $a.Properties['serviceprincipalname'].Count -gt 0

        $uac = 0
        if ($a.Properties['useraccountcontrol'].Count -gt 0) {
            $uac = [int]$a.Properties['useraccountcontrol'][0]
        }
        $enabled = -not [bool]($uac -band 2)

        # Extract OU from DN
        $ou = ''
        if ($dn -match '^CN=[^,]+,(.+)$') {
            $ou = $Matches[1]
        }

        $acctName = if ($domainPrefix) { "$domainPrefix\$sam" } else { $sam }

        $accounts += [PSCustomObject]@{
            name       = $acctName
            ou         = $ou
            created    = $created
            modified   = $modified
            last_logon = $lastLogon
            enabled    = $enabled
            has_spn    = $hasSPN
        }
    }

    # Also collect gMSA accounts
    Write-Host "[*] Querying AD for gMSA accounts..." -ForegroundColor Yellow
    $gmsaFilter = '(objectClass=msDS-GroupManagedServiceAccount)'
    if (-not $IncludeDisabled) {
        $gmsaFilter = '(&(objectClass=msDS-GroupManagedServiceAccount)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))'
    }

    try {
        $adGmsa = Search-AD -Filter $gmsaFilter `
            -Properties @('sAMAccountName', 'distinguishedName', 'whenCreated', 'whenChanged', 'lastLogonTimestamp', 'userAccountControl') `
            -SearchBase $SearchBase -Server $Server

        foreach ($g in $adGmsa) {
            $sam  = [string]$g.Properties['samaccountname'][0]
            $dn   = [string]$g.Properties['distinguishedname'][0]
            $created = if ($g.Properties['whencreated'].Count -gt 0) { ([datetime]$g.Properties['whencreated'][0]).ToString('o') } else { '' }
            $modified = if ($g.Properties['whenchanged'].Count -gt 0) { ([datetime]$g.Properties['whenchanged'][0]).ToString('o') } else { '' }
            $lastLogon = ''
            if ($g.Properties['lastlogontimestamp'].Count -gt 0) {
                try { $lastLogon = [datetime]::FromFileTime([long]$g.Properties['lastlogontimestamp'][0]).ToString('o') } catch { }
            }

            $ou = ''
            if ($dn -match '^CN=[^,]+,(.+)$') {
                $ou = $Matches[1]
            }

            $gmsaName = if ($domainPrefix) { "$domainPrefix\$sam" } else { $sam }

            $accounts += [PSCustomObject]@{
                name       = $gmsaName
                ou         = $ou
                created    = $created
                modified   = $modified
                last_logon = $lastLogon
                enabled    = $true
                has_spn    = $true
            }
        }
        Write-Host "    Found $($accounts.Count) account objects (including gMSA)" -ForegroundColor Green
    } catch {
        Write-Host "    Warning: Could not query gMSA accounts: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "    Found $($accounts.Count) account objects" -ForegroundColor Green
    }
}

# ── Build output ────────────────────────────────────────────────────────────
$output = @{
    _type        = 'ad_coverage'
    domain       = $domain
    collected_at = (Get-Date).ToString('o')
    server       = if ($Server) { $Server } else { 'localhost' }
    search_base  = if ($SearchBase) { $SearchBase } else { '' }
    include_disabled = [bool]$IncludeDisabled
    computers    = @($computers)
    accounts     = @($accounts)
}

# ── Write JSON ──────────────────────────────────────────────────────────────
if (-not (Test-Path $OutputPath)) {
    New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null
}

$timestamp = (Get-Date).ToString('yyyy-MM-dd_HHmmss')
$filename  = "ad_coverage_${timestamp}.json"
$filePath  = Join-Path $OutputPath $filename

$output | ConvertTo-Json -Depth 4 -Compress | Set-Content -Path $filePath -Encoding UTF8

$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "================================================================" -ForegroundColor Green
Write-Host "  Collection complete!" -ForegroundColor Green
Write-Host "  Computers : $($computers.Count)" -ForegroundColor Green
Write-Host "  Accounts  : $($accounts.Count)" -ForegroundColor Green
Write-Host "  Time      : $($elapsed.TotalSeconds.ToString('0.0'))s" -ForegroundColor Green
Write-Host "  Output    : $filePath" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Import this file into the Auth Mapper web app to see coverage gaps." -ForegroundColor Cyan
Write-Host ""
