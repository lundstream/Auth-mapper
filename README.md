# Service Account Inventory

Visualize which accounts authenticate against which servers by collecting data from Domain Controller security logs.

## Features

- **PowerShell collection script** — Queries DC security logs (Event 4624 + 4776) for logon events, resolves computer OUs from AD, outputs JSON
- **Web dashboard** — Dark-themed UI with stats, charts, filterable tables, network graph
- **Computers tab** — List all computers/servers with IPs, OUs, and account counts; sortable and filterable
- **Accounts tab** — All unique accounts with computer counts; filter by pattern (e.g. `svc*`, `admin*`)
- **Network map** — Interactive canvas-based graph showing account → computer authentication relationships
- **Import system** — Drag & drop JSON files, import from server path, supports multiple import runs with data merging
- **CSV export** — Export computers, accounts, or full mappings to CSV; supports filtered exports

## Quick Start

### 1. Collect Data on Domain Controller

```powershell
# Run on DC (requires security log access)
.\scripts\Collect-AuthInventory.ps1 -HoursBack 168

# Customize
.\scripts\Collect-AuthInventory.ps1 -HoursBack 720 -OutputPath C:\exports -DomainController DC01.contoso.com
```

Output: `auth_inventory_YYYYMMDD_HHmmss.json`

### 2. Start the Web App

```bash
npm install
npm start
```

Open http://localhost:3002

### 3. Import Data

- Go to **Import & Export** tab
- Drag & drop the JSON file, or enter the file path and click Import
- Import multiple files — data is merged (unique computers/accounts/mappings)

## Settings

Copy `settings.example.json` to `settings.json` and adjust:

```json
{
  "port": 3002
}
```

## Tech Stack

- Node.js + Express 5
- SQLite (better-sqlite3)
- Chart.js 4
- Feather Icons
- Vanilla JS frontend (same look & feel as [Vire](https://github.com/lundstream/Vire))
