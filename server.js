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
    res.json(db.getDashboardStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Computers list
app.get('/api/computers', (req, res) => {
  try {
    const { q, ou, sort, dir, page, limit } = req.query;
    res.json(db.getComputers({
      search: q || '',
      ouFilter: ou || '',
      sort: sort || 'name',
      dir: dir || 'ASC',
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100
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
    const { q, sort, dir, page, limit } = req.query;
    res.json(db.getAccounts({
      search: q || '',
      sort: sort || 'name',
      dir: dir || 'ASC',
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 100
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
    const { q, account } = req.query;
    res.json(db.getNetworkData({ search: q || '', accountFilter: account || '' }));
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

/* ── Start ─────────────────────────────────────────────────────────────── */

app.listen(PORT, () => {
  console.log(`Service Account Inventory running on http://localhost:${PORT}`);
});
