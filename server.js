'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');

/* ── Settings ──────────────────────────────────────────────────────────── */

let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'settings.json'), 'utf8'));
} catch { /* use defaults */ }

const PORT = settings.port || 3002;

/* ── Express setup ─────────────────────────────────────────────────────── */

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: false }));
app.use(express.json({ limit: '50mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB
db.getDb();

/* ── API Routes ────────────────────────────────────────────────────────── */

// Import data from JSON (file upload or paste)
app.post('/api/import', (req, res) => {
  try {
    const jsonData = req.body;
    if (!jsonData || !Array.isArray(jsonData.computers)) {
      return res.status(400).json({ error: 'Invalid format. Expected { computers: [...] }' });
    }
    const result = db.importData(jsonData, req.query.source || null);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Import from file path on disk
app.post('/api/import/file', (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });

    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });

    const raw = fs.readFileSync(resolved, 'utf8');
    const jsonData = JSON.parse(raw);

    if (!jsonData || !Array.isArray(jsonData.computers)) {
      return res.status(400).json({ error: 'Invalid format. Expected { computers: [...] }' });
    }

    const result = db.importData(jsonData, path.basename(resolved));
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('File import error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Dashboard stats
app.get('/api/dashboard', (req, res) => {
  try {
    res.json(db.getDashboardStats(settings.svcPatterns || ['svc', 'service']));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Computers list
app.get('/api/computers', (req, res) => {
  try {
    const { q, ou, tier, owner, sort, dir, page, limit, svcOnly } = req.query;
    res.json(db.getComputers({
      search: q || '',
      ouFilter: ou || '',
      tierFilter: tier || '',
      ownerFilter: owner || '',
      sort: sort || 'name',
      dir: dir || 'ASC',
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100,
      svcOnly: svcOnly === '1',
      svcPatterns: settings.svcPatterns || ['svc', 'service']
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Computer detail
app.get('/api/computers/:name', (req, res) => {
  try {
    const detail = db.getComputerDetail(req.params.name);
    if (!detail) return res.status(404).json({ error: 'Computer not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accounts list
app.get('/api/accounts', (req, res) => {
  try {
    const { q, tier, owner, sort, dir, page, limit, svcOnly } = req.query;
    res.json(db.getAccounts({
      search: q || '',
      tierFilter: tier || '',
      ownerFilter: owner || '',
      sort: sort || 'name',
      dir: dir || 'ASC',
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100,
      svcOnly: svcOnly === '1',
      svcPatterns: settings.svcPatterns || ['svc', 'service']
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Account detail
app.get('/api/accounts/:name', (req, res) => {
  try {
    const detail = db.getAccountDetail(req.params.name);
    if (!detail) return res.status(404).json({ error: 'Account not found' });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Network graph data
app.get('/api/network', (req, res) => {
  try {
    const { q, ou, tier, owner, svcOnly } = req.query;
    res.json(db.getNetworkData({
      search: q || '',
      ouFilter: ou || '',
      tierFilter: tier || '',
      ownerFilter: owner || '',
      svcOnly: svcOnly === '1',
      svcPatterns: settings.svcPatterns || ['svc', 'service']
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSV export
app.get('/api/export/:type', (req, res) => {
  try {
    const { q, account, ou } = req.query;
    const type = req.params.type; // 'computers', 'accounts', 'mappings'
    if (!['computers', 'accounts', 'mappings'].includes(type)) {
      return res.status(400).json({ error: 'Type must be computers, accounts, or mappings' });
    }

    const rows = db.getExportData({ type, search: q || '', accountFilter: account || '', ouFilter: ou || '' });

    if (rows.length === 0) {
      return res.status(404).json({ error: 'No data to export' });
    }

    // Build CSV
    const headers = Object.keys(rows[0]);
    const csvLines = [headers.join(',')];
    for (const row of rows) {
      csvLines.push(headers.map(h => {
        let val = row[h] == null ? '' : String(row[h]);
        if (val.includes(',') || val.includes('"') || val.includes('\n')) {
          val = '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      }).join(','));
    }

    const csv = csvLines.join('\r\n');
    const filename = `auth_inventory_${type}_${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import runs
app.get('/api/imports', (req, res) => {
  try {
    res.json(db.getImportRuns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Purge all data
app.post('/api/purge', (req, res) => {
  try {
    db.purgeAllData();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SVC patterns
app.get('/api/settings/svc-patterns', (req, res) => {
  res.json(settings.svcPatterns || ['svc', 'service']);
});

app.put('/api/settings/svc-patterns', (req, res) => {
  try {
    const { patterns } = req.body;
    if (!Array.isArray(patterns)) return res.status(400).json({ error: 'patterns must be an array' });
    settings.svcPatterns = patterns.map(p => String(p).trim()).filter(Boolean);
    if (settings.svcPatterns.length === 0) settings.svcPatterns = ['svc', 'service'];
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2));
    res.json({ ok: true, patterns: settings.svcPatterns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tier levels
app.get('/api/settings/tier-levels', (req, res) => {
  res.json(settings.tierLevels || ['T0', 'T1', 'T2']);
});

app.put('/api/settings/tier-levels', (req, res) => {
  try {
    const { levels } = req.body;
    if (!Array.isArray(levels)) return res.status(400).json({ error: 'levels must be an array' });
    settings.tierLevels = levels.map(l => String(l).trim()).filter(Boolean);
    if (settings.tierLevels.length === 0) settings.tierLevels = ['T0', 'T1', 'T2'];
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2));
    res.json({ ok: true, levels: settings.tierLevels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set computer tier
app.put('/api/computers/:name/tier', (req, res) => {
  try {
    const { tier } = req.body;
    if (tier == null) return res.status(400).json({ error: 'tier is required' });
    const ok = db.setComputerTier(req.params.name, String(tier));
    if (!ok) return res.status(404).json({ error: 'Computer not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set account tier
app.put('/api/accounts/:name/tier', (req, res) => {
  try {
    const { tier } = req.body;
    if (tier == null) return res.status(400).json({ error: 'tier is required' });
    const ok = db.setAccountTier(req.params.name, String(tier));
    if (!ok) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set computer owner
app.put('/api/computers/:name/owner', (req, res) => {
  try {
    const { owner } = req.body;
    if (owner == null) return res.status(400).json({ error: 'owner is required' });
    const ok = db.setComputerOwner(req.params.name, String(owner));
    if (!ok) return res.status(404).json({ error: 'Computer not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set account owner
app.put('/api/accounts/:name/owner', (req, res) => {
  try {
    const { owner } = req.body;
    if (owner == null) return res.status(400).json({ error: 'owner is required' });
    const ok = db.setAccountOwner(req.params.name, String(owner));
    if (!ok) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Owners list
app.get('/api/settings/owners', (req, res) => {
  res.json(settings.owners || []);
});

app.put('/api/settings/owners', (req, res) => {
  try {
    const { owners } = req.body;
    if (!Array.isArray(owners)) return res.status(400).json({ error: 'owners must be an array' });
    settings.owners = owners.map(o => String(o).trim()).filter(Boolean);
    fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2));
    res.json({ ok: true, owners: settings.owners });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Backup – download full database as JSON
app.get('/api/backup', (req, res) => {
  try {
    const data = db.getBackupData();
    data.settings = {
      svcPatterns: settings.svcPatterns || ['svc', 'service'],
      tierLevels: settings.tierLevels || ['T0', 'T1', 'T2'],
      owners: settings.owners || []
    };
    const filename = `auth_mapper_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore – upload backup JSON to replace all data
app.post('/api/restore', (req, res) => {
  try {
    const data = req.body;
    if (!data || !data._backup) return res.status(400).json({ error: 'Invalid backup file' });
    const result = db.restoreBackupData(data);
    // Restore settings if included
    if (data.settings) {
      if (Array.isArray(data.settings.svcPatterns) && data.settings.svcPatterns.length) {
        settings.svcPatterns = data.settings.svcPatterns;
      }
      if (Array.isArray(data.settings.tierLevels) && data.settings.tierLevels.length) {
        settings.tierLevels = data.settings.tierLevels;
      }
      if (Array.isArray(data.settings.owners)) {
        settings.owners = data.settings.owners;
      }
      fs.writeFileSync(path.join(__dirname, 'settings.json'), JSON.stringify(settings, null, 2));
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Coverage / Gap Analysis
app.post('/api/coverage/import', (req, res) => {
  try {
    const jsonData = req.body;
    if (!jsonData || jsonData._type !== 'ad_coverage') {
      return res.status(400).json({ error: 'Invalid format. Expected AD coverage JSON with _type: "ad_coverage"' });
    }
    const result = db.importCoverage(jsonData);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Coverage import error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/coverage/import/file', (req, res) => {
  try {
    const { filePath: fp } = req.body;
    if (!fp) return res.status(400).json({ error: 'filePath required' });
    const resolved = path.resolve(fp);
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    const raw = fs.readFileSync(resolved, 'utf8');
    const jsonData = JSON.parse(raw);
    if (!jsonData || jsonData._type !== 'ad_coverage') {
      return res.status(400).json({ error: 'Invalid format. Expected AD coverage JSON with _type: "ad_coverage"' });
    }
    const result = db.importCoverage(jsonData);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Coverage file import error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/coverage', (req, res) => {
  try {
    const data = db.getCoverageData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/coverage/snapshots', (req, res) => {
  try {
    res.json(db.getCoverageSnapshots());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/coverage/snapshots/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid snapshot ID' });
    const ok = db.deleteCoverageSnapshot(id);
    if (!ok) return res.status(404).json({ error: 'Snapshot not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Start ─────────────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`Service Account Inventory running on http://localhost:${PORT}`);
});
