'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let _db;

function getDb() {
  if (_db) return _db;
  const dbPath = path.join(dataDir, 'auth_inventory.db');
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema();
  return _db;
}

/* ── Schema ────────────────────────────────────────────────────────────── */

function initSchema() {
  const db = _db;

  db.exec(`
    CREATE TABLE IF NOT EXISTS import_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      imported_at     TEXT NOT NULL DEFAULT (datetime('now')),
      source_file     TEXT,
      domain_controller TEXT,
      hours_back      INTEGER,
      collected_at    TEXT,
      computers_count INTEGER DEFAULT 0,
      accounts_count  INTEGER DEFAULT 0,
      mappings_count  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS computers (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      name    TEXT NOT NULL UNIQUE COLLATE NOCASE,
      ou      TEXT DEFAULT '',
      tier    TEXT DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_computers_name ON computers(name);
    CREATE INDEX IF NOT EXISTS idx_computers_ou   ON computers(ou);

    CREATE TABLE IF NOT EXISTS computer_ips (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
      ip          TEXT NOT NULL,
      UNIQUE(computer_id, ip)
    );

    CREATE INDEX IF NOT EXISTS idx_computer_ips_computer ON computer_ips(computer_id);

    CREATE TABLE IF NOT EXISTS accounts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
      tier       TEXT DEFAULT '',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_name ON accounts(name);

    CREATE TABLE IF NOT EXISTS auth_mappings (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      computer_id INTEGER NOT NULL REFERENCES computers(id) ON DELETE CASCADE,
      account_id  INTEGER NOT NULL REFERENCES accounts(id)  ON DELETE CASCADE,
      auth_types  TEXT NOT NULL DEFAULT '',
      first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen   TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(computer_id, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_auth_computer ON auth_mappings(computer_id);
    CREATE INDEX IF NOT EXISTS idx_auth_account  ON auth_mappings(account_id);
  `);

  // Migrate: add auth_types column if missing (existing databases)
  try {
    db.prepare(`SELECT auth_types FROM auth_mappings LIMIT 0`).get();
  } catch {
    db.exec(`ALTER TABLE auth_mappings ADD COLUMN auth_types TEXT NOT NULL DEFAULT ''`);
  }

  // Migrate: add tier column to computers and accounts if missing
  try {
    db.prepare(`SELECT tier FROM computers LIMIT 0`).get();
  } catch {
    db.exec(`ALTER TABLE computers ADD COLUMN tier TEXT DEFAULT ''`);
  }
  try {
    db.prepare(`SELECT tier FROM accounts LIMIT 0`).get();
  } catch {
    db.exec(`ALTER TABLE accounts ADD COLUMN tier TEXT DEFAULT ''`);
  }
}

/* ── Import ────────────────────────────────────────────────────────────── */

function importData(jsonData, sourceFile) {
  const db = getDb();

  const insertRun = db.prepare(`
    INSERT INTO import_runs (source_file, domain_controller, hours_back, collected_at, computers_count, accounts_count, mappings_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const upsertComputer = db.prepare(`
    INSERT INTO computers (name, ou) VALUES (?, ?)
    ON CONFLICT(name) DO UPDATE SET ou = CASE WHEN excluded.ou != '' THEN excluded.ou ELSE computers.ou END,
                                    last_seen = datetime('now')
  `);
  const getComputerId = db.prepare(`SELECT id FROM computers WHERE name = ? COLLATE NOCASE`);

  const upsertIp = db.prepare(`
    INSERT INTO computer_ips (computer_id, ip) VALUES (?, ?)
    ON CONFLICT(computer_id, ip) DO NOTHING
  `);

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (name) VALUES (?)
    ON CONFLICT(name) DO UPDATE SET last_seen = datetime('now')
  `);
  const getAccountId = db.prepare(`SELECT id FROM accounts WHERE name = ? COLLATE NOCASE`);

  const upsertMapping = db.prepare(`
    INSERT INTO auth_mappings (computer_id, account_id, auth_types) VALUES (?, ?, ?)
    ON CONFLICT(computer_id, account_id) DO UPDATE SET
      last_seen = datetime('now'),
      auth_types = CASE
        WHEN excluded.auth_types = '' THEN auth_mappings.auth_types
        WHEN auth_mappings.auth_types = '' THEN excluded.auth_types
        ELSE auth_mappings.auth_types || ',' || excluded.auth_types
      END
  `);

  let computersCount = 0;
  const accountSet = new Set();
  let mappingsCount = 0;

  const doImport = db.transaction(() => {
    const computers = jsonData.computers || [];

    for (const comp of computers) {
      const compName = (comp.name || '').trim().toUpperCase();
      if (!compName) continue;

      upsertComputer.run(compName, comp.ou || '');
      const compRow = getComputerId.get(compName);
      if (!compRow) continue;
      const compId = compRow.id;
      computersCount++;

      // Auto-tier: Domain Controllers → T0 (only if not already tiered)
      if (/OU=Domain Controllers/i.test(comp.ou || '')) {
        db.prepare(`UPDATE computers SET tier = 'T0' WHERE id = ? AND (tier IS NULL OR tier = '')`).run(compId);
      }

      // IPs
      if (Array.isArray(comp.ips)) {
        for (const ip of comp.ips) {
          if (ip && ip !== '-') upsertIp.run(compId, ip);
        }
      }

      // Accounts
      if (Array.isArray(comp.accounts)) {
        for (const acct of comp.accounts) {
          // Support both old format (string) and new format ({ name, auth_types })
          const acctName = (typeof acct === 'string' ? acct : (acct && acct.name) || '').trim();
          if (!acctName) continue;

          const authTypes = (typeof acct === 'object' && Array.isArray(acct.auth_types))
            ? [...new Set(acct.auth_types)].sort().join(',')
            : '';

          upsertAccount.run(acctName);
          const acctRow = getAccountId.get(acctName);
          if (!acctRow) continue;

          upsertMapping.run(compId, acctRow.id, authTypes);
          accountSet.add(acctName.toUpperCase());
          mappingsCount++;
        }
      }
    }

    insertRun.run(
      sourceFile || null,
      jsonData.domain_controller || null,
      jsonData.hours_back || null,
      jsonData.collected_at || null,
      computersCount,
      accountSet.size,
      mappingsCount
    );
  });

  doImport();

  return { computers: computersCount, accounts: accountSet.size, mappings: mappingsCount };
}

/** Parse a stored comma-separated auth_types string into a sorted, deduplicated array */
function parseAuthTypes(str) {
  if (!str) return [];
  return [...new Set(str.split(',').map(s => s.trim()).filter(Boolean))].sort();
}

/* ── Queries ───────────────────────────────────────────────────────────── */

function buildSvcCondition(col, patterns) {
  if (!patterns || patterns.length === 0) return { sql: '1=0', params: [] };
  const sql = '(' + patterns.map(() => `${col} LIKE ?`).join(' OR ') + ')';
  const params = patterns.map(p => `%${p}%`);
  return { sql, params };
}

function getDashboardStats(svcPatterns) {
  const db = getDb();

  const totalComputers = db.prepare(`SELECT COUNT(*) as cnt FROM computers`).get().cnt;
  const totalAccounts  = db.prepare(`SELECT COUNT(*) as cnt FROM accounts`).get().cnt;
  const totalMappings  = db.prepare(`SELECT COUNT(*) as cnt FROM auth_mappings`).get().cnt;
  const totalImports   = db.prepare(`SELECT COUNT(*) as cnt FROM import_runs`).get().cnt;
  const totalIps       = db.prepare(`SELECT COUNT(DISTINCT ip) as cnt FROM computer_ips`).get().cnt;

  // Accounts with most computers (top 10)
  const topAccounts = db.prepare(`
    SELECT a.name, COUNT(DISTINCT m.computer_id) as computer_count
    FROM accounts a
    JOIN auth_mappings m ON m.account_id = a.id
    GROUP BY a.id
    ORDER BY computer_count DESC
    LIMIT 10
  `).all();

  // Computers with most accounts (top 10)
  const topComputers = db.prepare(`
    SELECT c.name, COUNT(DISTINCT m.account_id) as account_count
    FROM computers c
    JOIN auth_mappings m ON m.computer_id = c.id
    GROUP BY c.id
    ORDER BY account_count DESC
    LIMIT 10
  `).all();

  // Account type breakdown (service vs user)
  const svcCond = buildSvcCondition('name', svcPatterns || ['svc', 'service']);
  const svcAccounts = db.prepare(`
    SELECT COUNT(*) as cnt FROM accounts
    WHERE ${svcCond.sql}
  `).get(...svcCond.params).cnt;

  // OUs with most computers
  const topOUs = db.prepare(`
    SELECT ou, COUNT(*) as cnt FROM computers
    WHERE ou != ''
    GROUP BY ou ORDER BY cnt DESC LIMIT 10
  `).all();

  // Recent imports
  const recentImports = db.prepare(`
    SELECT * FROM import_runs ORDER BY imported_at DESC LIMIT 5
  `).all();

  // Accounts per computer distribution
  const distribution = db.prepare(`
    SELECT
      CASE
        WHEN acct_count = 1 THEN '1'
        WHEN acct_count BETWEEN 2 AND 5 THEN '2-5'
        WHEN acct_count BETWEEN 6 AND 10 THEN '6-10'
        WHEN acct_count BETWEEN 11 AND 20 THEN '11-20'
        ELSE '20+'
      END as bucket,
      COUNT(*) as cnt
    FROM (
      SELECT c.id, COUNT(DISTINCT m.account_id) as acct_count
      FROM computers c
      JOIN auth_mappings m ON m.computer_id = c.id
      GROUP BY c.id
    )
    GROUP BY bucket
    ORDER BY MIN(acct_count)
  `).all();

  return {
    totalComputers, totalAccounts, totalMappings, totalImports, totalIps,
    svcAccounts, userAccounts: totalAccounts - svcAccounts,
    topAccounts, topComputers, topOUs, recentImports, distribution
  };
}

function getComputers({ search, ouFilter, tierFilter, sort, dir, page, limit, svcOnly, svcPatterns }) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`(c.name LIKE ? OR ci.ip LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`);
  }
  if (ouFilter) {
    conditions.push(`c.ou LIKE ?`);
    params.push(`%${ouFilter}%`);
  }
  if (tierFilter) {
    conditions.push(`c.tier = ?`);
    params.push(tierFilter);
  }
  if (svcOnly && svcPatterns && svcPatterns.length > 0) {
    const svcCond = buildSvcCondition('sa.name', svcPatterns);
    conditions.push(`c.id IN (SELECT sm.computer_id FROM auth_mappings sm JOIN accounts sa ON sa.id = sm.account_id WHERE ${svcCond.sql})`);
    params.push(...svcCond.params);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const allowedSort = { name: 'c.name', ou: 'c.ou', account_count: 'account_count', ip_count: 'ip_count', first_seen: 'c.first_seen', last_seen: 'c.last_seen' };
  const orderCol = allowedSort[sort] || 'c.name';
  const orderDir = dir === 'DESC' ? 'DESC' : 'ASC';

  const countSql = `
    SELECT COUNT(DISTINCT c.id) as total
    FROM computers c
    LEFT JOIN computer_ips ci ON ci.computer_id = c.id
    ${where}
  `;

  const dataSql = `
    SELECT c.id, c.name, c.ou, c.tier, c.first_seen, c.last_seen,
           COUNT(DISTINCT m.account_id) as account_count,
           (SELECT COUNT(*) FROM computer_ips ci2 WHERE ci2.computer_id = c.id) as ip_count,
           (SELECT GROUP_CONCAT(ci3.ip, '; ') FROM computer_ips ci3 WHERE ci3.computer_id = c.id) as ips
    FROM computers c
    LEFT JOIN auth_mappings m ON m.computer_id = c.id
    LEFT JOIN computer_ips ci ON ci.computer_id = c.id
    ${where}
    GROUP BY c.id
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ? OFFSET ?
  `;

  const total = db.prepare(countSql).get(...params).total;
  const offset = ((page || 1) - 1) * (limit || 100);
  const data = db.prepare(dataSql).all(...params, limit || 100, offset);

  return { data, total, page: page || 1, limit: limit || 100 };
}

function getComputerDetail(name) {
  const db = getDb();
  const computer = db.prepare(`SELECT * FROM computers WHERE name = ? COLLATE NOCASE`).get(name);
  if (!computer) return null;

  const ips = db.prepare(`SELECT ip FROM computer_ips WHERE computer_id = ?`).all(computer.id).map(r => r.ip);

  const accounts = db.prepare(`
    SELECT a.name, m.first_seen, m.last_seen, m.auth_types
    FROM auth_mappings m
    JOIN accounts a ON a.id = m.account_id
    WHERE m.computer_id = ?
    ORDER BY a.name
  `).all(computer.id).map(a => ({ ...a, auth_types: parseAuthTypes(a.auth_types) }));

  return { ...computer, ips, accounts };
}

function getAccounts({ search, tierFilter, sort, dir, page, limit, svcOnly, svcPatterns }) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`a.name LIKE ?`);
    params.push(`%${search}%`);
  }
  if (tierFilter) {
    conditions.push(`a.tier = ?`);
    params.push(tierFilter);
  }
  if (svcOnly && svcPatterns && svcPatterns.length > 0) {
    const svcCond = buildSvcCondition('a.name', svcPatterns);
    conditions.push(svcCond.sql);
    params.push(...svcCond.params);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const allowedSort = { name: 'a.name', computer_count: 'computer_count', first_seen: 'a.first_seen', last_seen: 'a.last_seen' };
  const orderCol = allowedSort[sort] || 'a.name';
  const orderDir = dir === 'DESC' ? 'DESC' : 'ASC';

  const countSql = `SELECT COUNT(*) as total FROM accounts a ${where}`;

  const dataSql = `
    SELECT a.id, a.name, a.tier, a.first_seen, a.last_seen,
           COUNT(DISTINCT m.computer_id) as computer_count
    FROM accounts a
    LEFT JOIN auth_mappings m ON m.account_id = a.id
    ${where}
    GROUP BY a.id
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ? OFFSET ?
  `;

  const total = db.prepare(countSql).get(...params).total;
  const offset = ((page || 1) - 1) * (limit || 100);
  const data = db.prepare(dataSql).all(...params, limit || 100, offset);

  return { data, total, page: page || 1, limit: limit || 100 };
}

function getAccountDetail(name) {
  const db = getDb();
  const account = db.prepare(`SELECT * FROM accounts WHERE name = ? COLLATE NOCASE`).get(name);
  if (!account) return null;

  const computers = db.prepare(`
    SELECT c.name, c.ou, m.first_seen, m.last_seen, m.auth_types,
           (SELECT GROUP_CONCAT(ci2.ip, '; ') FROM computer_ips ci2 WHERE ci2.computer_id = c.id) as ips
    FROM auth_mappings m
    JOIN computers c ON c.id = m.computer_id
    WHERE m.account_id = ?
    GROUP BY c.id
    ORDER BY c.name
  `).all(account.id).map(c => ({ ...c, auth_types: parseAuthTypes(c.auth_types) }));

  return { ...account, computers };
}

function getNetworkData({ search, accountFilter, ouFilter, tierFilter, svcOnly, svcPatterns }) {
  const db = getDb();
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`(c.name LIKE ? OR a.name LIKE ?)`);
    params.push(`%${search}%`, `%${search}%`);
  }
  if (accountFilter) {
    conditions.push(`a.name LIKE ?`);
    params.push(`%${accountFilter}%`);
  }
  if (ouFilter) {
    conditions.push(`c.ou LIKE ?`);
    params.push(`%${ouFilter}%`);
  }
  if (tierFilter) {
    conditions.push(`(c.tier = ? OR a.tier = ?)`);
    params.push(tierFilter, tierFilter);
  }
  if (svcOnly && svcPatterns && svcPatterns.length > 0) {
    const svcCond = buildSvcCondition('a.name', svcPatterns);
    conditions.push(svcCond.sql);
    params.push(...svcCond.params);
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  const nodes = new Map();
  const links = [];

  const rows = db.prepare(`
    SELECT c.name as computer_name, c.tier as computer_tier, a.name as account_name, a.tier as account_tier, m.auth_types
    FROM auth_mappings m
    JOIN computers c ON c.id = m.computer_id
    JOIN accounts a ON a.id = m.account_id
    ${where}
    LIMIT 5000
  `).all(...params);

  for (const row of rows) {
    if (!nodes.has('c:' + row.computer_name)) {
      nodes.set('c:' + row.computer_name, { id: 'c:' + row.computer_name, label: row.computer_name, type: 'computer', tier: row.computer_tier || '' });
    }
    if (!nodes.has('a:' + row.account_name)) {
      nodes.set('a:' + row.account_name, { id: 'a:' + row.account_name, label: row.account_name, type: 'account', tier: row.account_tier || '' });
    }
    links.push({ source: 'a:' + row.account_name, target: 'c:' + row.computer_name });
  }

  return { nodes: Array.from(nodes.values()), links };
}

function getExportData({ type, search, accountFilter, ouFilter }) {
  const db = getDb();

  if (type === 'computers') {
    const conditions = [];
    const params = [];
    if (search) { conditions.push(`c.name LIKE ?`); params.push(`%${search}%`); }
    if (ouFilter) { conditions.push(`c.ou LIKE ?`); params.push(`%${ouFilter}%`); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    return db.prepare(`
      SELECT c.name as Computer,
             (SELECT GROUP_CONCAT(ci2.ip, '; ') FROM computer_ips ci2 WHERE ci2.computer_id = c.id) as IPs,
             c.ou as OU, c.tier as Tier,
             COUNT(DISTINCT m.account_id) as Account_Count, c.first_seen as First_Seen, c.last_seen as Last_Seen
      FROM computers c
      LEFT JOIN auth_mappings m ON m.computer_id = c.id
      ${where}
      GROUP BY c.id ORDER BY c.name
    `).all(...params);
  }

  if (type === 'accounts') {
    const conditions = [];
    const params = [];
    if (search) { conditions.push(`a.name LIKE ?`); params.push(`%${search}%`); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    return db.prepare(`
      SELECT a.name as Account, a.tier as Tier, COUNT(DISTINCT m.computer_id) as Computer_Count,
             a.first_seen as First_Seen, a.last_seen as Last_Seen
      FROM accounts a
      LEFT JOIN auth_mappings m ON m.account_id = a.id
      ${where}
      GROUP BY a.id ORDER BY a.name
    `).all(...params);
  }

  // type === 'mappings' (default)
  const conditions = [];
  const params = [];
  if (search) { conditions.push(`(c.name LIKE ? OR a.name LIKE ?)`); params.push(`%${search}%`, `%${search}%`); }
  if (accountFilter) { conditions.push(`a.name LIKE ?`); params.push(`%${accountFilter}%`); }
  if (ouFilter) { conditions.push(`c.ou LIKE ?`); params.push(`%${ouFilter}%`); }
  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  return db.prepare(`
      SELECT c.name as Computer,
           (SELECT GROUP_CONCAT(ci2.ip, '; ') FROM computer_ips ci2 WHERE ci2.computer_id = c.id) as IPs,
           c.ou as OU, c.tier as Computer_Tier,
           a.name as Account, a.tier as Account_Tier, m.first_seen as First_Seen, m.last_seen as Last_Seen
    FROM auth_mappings m
    JOIN computers c ON c.id = m.computer_id
    JOIN accounts a ON a.id = m.account_id
    ${where}
    ORDER BY c.name, a.name
  `).all(...params);
}

function getImportRuns() {
  const db = getDb();
  return db.prepare(`SELECT * FROM import_runs ORDER BY imported_at DESC`).all();
}

function deleteImportRun(id) {
  const db = getDb();
  // We can't fully undo an import since data was merged, but we can delete the record
  db.prepare(`DELETE FROM import_runs WHERE id = ?`).run(id);
}

function purgeAllData() {
  const db = getDb();
  db.exec(`
    DELETE FROM auth_mappings;
    DELETE FROM computer_ips;
    DELETE FROM accounts;
    DELETE FROM computers;
    DELETE FROM import_runs;
  `);
}

function setComputerTier(name, tier) {
  const db = getDb();
  const result = db.prepare(`UPDATE computers SET tier = ? WHERE name = ? COLLATE NOCASE`).run(tier, name);
  return result.changes > 0;
}

function setAccountTier(name, tier) {
  const db = getDb();
  const result = db.prepare(`UPDATE accounts SET tier = ? WHERE name = ? COLLATE NOCASE`).run(tier, name);
  return result.changes > 0;
}

function getBackupData() {
  const db = getDb();
  const computers = db.prepare(`SELECT * FROM computers ORDER BY name`).all();
  const computerIps = db.prepare(`SELECT ci.*, c.name as computer_name FROM computer_ips ci JOIN computers c ON c.id = ci.computer_id ORDER BY c.name, ci.ip`).all();
  const accounts = db.prepare(`SELECT * FROM accounts ORDER BY name`).all();
  const mappings = db.prepare(`
    SELECT c.name as computer_name, a.name as account_name, m.auth_types, m.first_seen, m.last_seen
    FROM auth_mappings m
    JOIN computers c ON c.id = m.computer_id
    JOIN accounts a ON a.id = m.account_id
    ORDER BY c.name, a.name
  `).all();
  const importRuns = db.prepare(`SELECT * FROM import_runs ORDER BY imported_at DESC`).all();

  return {
    _backup: true,
    _version: 1,
    _created: new Date().toISOString(),
    computers: computers.map(c => ({
      name: c.name,
      ou: c.ou || '',
      tier: c.tier || '',
      first_seen: c.first_seen,
      last_seen: c.last_seen,
      ips: computerIps.filter(ci => ci.computer_id === c.id).map(ci => ci.ip)
    })),
    accounts: accounts.map(a => ({
      name: a.name,
      tier: a.tier || '',
      first_seen: a.first_seen,
      last_seen: a.last_seen
    })),
    mappings,
    importRuns
  };
}

function restoreBackupData(data) {
  const db = getDb();

  const doRestore = db.transaction(() => {
    // Clear all existing data
    db.exec(`
      DELETE FROM auth_mappings;
      DELETE FROM computer_ips;
      DELETE FROM accounts;
      DELETE FROM computers;
      DELETE FROM import_runs;
    `);

    // Restore computers
    const insertComputer = db.prepare(`
      INSERT INTO computers (name, ou, tier, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    `);
    const getComputerId = db.prepare(`SELECT id FROM computers WHERE name = ? COLLATE NOCASE`);

    for (const c of (data.computers || [])) {
      insertComputer.run(c.name, c.ou || '', c.tier || '', c.first_seen, c.last_seen);
      const row = getComputerId.get(c.name);
      if (!row) continue;
      if (Array.isArray(c.ips)) {
        for (const ip of c.ips) {
          if (ip) db.prepare(`INSERT INTO computer_ips (computer_id, ip) VALUES (?, ?)`).run(row.id, ip);
        }
      }
    }

    // Restore accounts
    const insertAccount = db.prepare(`
      INSERT INTO accounts (name, tier, first_seen, last_seen) VALUES (?, ?, ?, ?)
    `);
    for (const a of (data.accounts || [])) {
      insertAccount.run(a.name, a.tier || '', a.first_seen, a.last_seen);
    }

    // Restore mappings
    const getAccountId = db.prepare(`SELECT id FROM accounts WHERE name = ? COLLATE NOCASE`);
    const insertMapping = db.prepare(`
      INSERT INTO auth_mappings (computer_id, account_id, auth_types, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
    `);
    for (const m of (data.mappings || [])) {
      const compRow = getComputerId.get(m.computer_name);
      const acctRow = getAccountId.get(m.account_name);
      if (compRow && acctRow) {
        insertMapping.run(compRow.id, acctRow.id, m.auth_types || '', m.first_seen, m.last_seen);
      }
    }

    // Restore import runs
    const insertRun = db.prepare(`
      INSERT INTO import_runs (source_file, domain_controller, hours_back, collected_at, computers_count, accounts_count, mappings_count, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of (data.importRuns || [])) {
      insertRun.run(r.source_file, r.domain_controller, r.hours_back, r.collected_at, r.computers_count, r.accounts_count, r.mappings_count, r.imported_at);
    }
  });

  doRestore();

  return {
    computers: (data.computers || []).length,
    accounts: (data.accounts || []).length,
    mappings: (data.mappings || []).length
  };
}

module.exports = {
  getDb,
  importData,
  getDashboardStats,
  getComputers,
  getComputerDetail,
  getAccounts,
  getAccountDetail,
  getNetworkData,
  getExportData,
  getImportRuns,
  deleteImportRun,
  purgeAllData,
  setComputerTier,
  setAccountTier,
  getBackupData,
  restoreBackupData
};
