# Auth Mapper

Visualize which accounts authenticate against which servers by collecting data from Domain Controller security logs. Designed to run locally on a Windows machine in your on-prem environment.

## Screenshots

**Dashboard** — Overview with KPI cards, authentication activity chart, and top accounts/computers.
![Dashboard](screenshots/1.png)

**Computers** — All discovered servers with IPs, OUs, and authenticated account counts.
![Computers](screenshots/2.png)

**Accounts** — Every account seen in logon events, with the number of computers it authenticated to.
![Accounts](screenshots/3.png)

**Network Map** — Interactive force-directed graph showing which accounts connect to which servers.
![Network Map](screenshots/4.png)

**Import & Export** — Drag-and-drop JSON import, CSV export, and service account pattern configuration.
![Import & Export](screenshots/5.png)

## Features

- **PowerShell collection script** — Queries DC security logs (Event 4624, 4768, 4769, 4776) for logon, Kerberos TGT/service ticket, and NTLM events; resolves computer OUs from AD, outputs JSON
- **Jumphost parser** — Export .evtx from DC, parse locally on any domain-joined machine (minimal DC load for large environments)
- **Web dashboard** — Dark-themed UI with stats, charts, filterable tables, network graph
- **Computers tab** — List all computers/servers with IPs, OUs, and account counts; sortable and filterable
- **Accounts tab** — All unique accounts with computer counts; filter by pattern (e.g. `svc*`, `admin*`)
- **Network map** — Interactive canvas-based graph showing account → computer authentication relationships; filter by OU, account, or service accounts only
- **Service account detection** — Configurable naming patterns (e.g. `svc`, `service`, `batch`) with "Service Accounts Only" filter on all views
- **Import system** — Drag & drop JSON files, import from server path, supports multiple import runs with data merging
- **CSV export** — Export computers, accounts, or full mappings to CSV; supports filtered exports

## Quick Start

### 1. Collect Data

**Option A — Run directly on DC:**

```powershell
.\scripts\Collect-AuthInventory.ps1 -HoursBack 168
```

**Option B — Export + parse on jumphost (recommended for large environments):**

```powershell
# On DC: export filtered events (takes seconds)
wevtutil epl Security \\jumphost\c$\temp\dc01_security.evtx /q:"*[System[(EventID=4624 or EventID=4768 or EventID=4769 or EventID=4776)]]"

# On jumphost: parse locally
.\scripts\Parse-AuthEvtx.ps1 -EvtxPath C:\temp\dc01_security.evtx -DomainController DC01
```

**Option C — Automatic export + parse from jumphost:**

```powershell
.\scripts\Parse-AuthEvtx.ps1 -ExportFromDC DC01.contoso.com -HoursBack 72
```

Output: `auth_inventory_YYYYMMDD_HHmmss.json`

### 2. Set Up the Web App (Windows)

**Prerequisites:**
- [Node.js](https://nodejs.org/) (v18 or later) — download the Windows installer from nodejs.org
- Git (optional, for cloning the repo)

**Install and run:**

```powershell
# Clone the repo (or download and extract the ZIP)
git clone https://github.com/lundstream/Auth-mapper.git
cd Auth-mapper

# Install dependencies
npm install

# Start the server
npm start
```

Open http://localhost:3002 in your browser.

The app runs entirely on your local machine — no internet connection required after setup.

### 3. Import Data

- Go to **Import & Export** tab
- Drag & drop the JSON file, or enter the file path and click Import
- Import multiple files — data is merged (unique computers/accounts/mappings)

## Settings

Copy `settings.example.json` to `settings.json` and adjust:

```json
{
  "port": 3002,
  "svcPatterns": ["svc", "service"]
}
```

`svcPatterns` — substrings used to identify service accounts (case-insensitive). Configurable from the web UI under Import & Export.

## Tech Stack

- Node.js + Express 5
- SQLite (better-sqlite3)
- Chart.js 4
- Feather Icons
- Vanilla JS frontend (same look & feel as [Vire](https://github.com/lundstream/Vire))
