'use strict';

/* ── State ─────────────────────────────────────────────────────────────── */
let charts = {};
let compSort = 'name', compDir = 'ASC', compPage = 1, compSearch = '', compOuFilter = '';
let acctSort = 'name', acctDir = 'ASC', acctPage = 1, acctSearch = '';
let networkData = null;

// Network graph state
let netZoom = 1, netPanX = 0, netPanY = 0;
let netDragging = false, netDragStartX = 0, netDragStartY = 0;
let netNodePositions = null;

/* ── Helpers ───────────────────────────────────────────────────────────── */
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function toast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = ''; }, 3500);
}

function wildcardToLike(pattern) {
  // Convert user wildcard (svc*, admin?) to SQL-like for the API
  return pattern.replace(/\*/g, '%').replace(/\?/g, '_');
}

function getChartColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    text: cs.getPropertyValue('--text2').trim() || '#9ca3b0',
    grid: cs.getPropertyValue('--border').trim() || '#2a2d37',
    accent: '#4f8cff', success: '#3ddfa0', warning: '#f5a623',
    danger: '#ff4d6a', info: '#6ec1e4',
    palette: ['#4f8cff', '#3ddfa0', '#f5a623', '#ff4d6a', '#6ec1e4', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#f87171']
  };
}

function fmtDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleDateString('sv-SE');
}

/* ── Init ──────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  feather.replace();
  setupTheme();
  setupTabs();
  setupModals();
  setupImport();
  setupExport();
  loadDashboard();
});

/* ── Theme ─────────────────────────────────────────────────────────────── */
function setupTheme() {
  const saved = localStorage.getItem('sai-theme') || 'dark';
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');

  document.getElementById('themeToggle').addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.setAttribute('data-theme', isLight ? '' : 'light');
    localStorage.setItem('sai-theme', isLight ? 'dark' : 'light');
    rebuildCharts();
  });
}

/* ── Tabs ──────────────────────────────────────────────────────────────── */
function setupTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');

      if (btn.dataset.tab === 'dashboard') loadDashboard();
      else if (btn.dataset.tab === 'computers') loadComputers();
      else if (btn.dataset.tab === 'accounts') loadAccounts();
      else if (btn.dataset.tab === 'network') loadNetwork();
      else if (btn.dataset.tab === 'import') loadImportHistory();
    });
  });
}

/* ── Modals ─────────────────────────────────────────────────────────────── */
function setupModals() {
  document.getElementById('compModalClose').addEventListener('click', () => {
    document.getElementById('compModal').classList.remove('open');
    document.body.classList.remove('modal-open');
  });
  document.getElementById('compModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { e.currentTarget.classList.remove('open'); document.body.classList.remove('modal-open'); }
  });

  document.getElementById('acctModalClose').addEventListener('click', () => {
    document.getElementById('acctModal').classList.remove('open');
    document.body.classList.remove('modal-open');
  });
  document.getElementById('acctModal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { e.currentTarget.classList.remove('open'); document.body.classList.remove('modal-open'); }
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── DASHBOARD ────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

async function loadDashboard() {
  try {
    const r = await fetch('/api/dashboard');
    const data = await r.json();
    renderDashStats(data);
    renderDashCharts(data);
    renderDashTables(data);
  } catch (err) {
    console.error('Dashboard load error:', err);
  }
}

function renderDashStats(data) {
  const el = document.getElementById('dashStats');
  el.innerHTML = `
    <div class="stat-card accent">
      <div class="stat-label">Total Computers</div>
      <div class="stat-value">${data.totalComputers}</div>
      <div class="stat-sub">${data.totalIps} unique IPs</div>
    </div>
    <div class="stat-card success">
      <div class="stat-label">Total Accounts</div>
      <div class="stat-value">${data.totalAccounts}</div>
      <div class="stat-sub">${data.svcAccounts} service accounts</div>
    </div>
    <div class="stat-card warning">
      <div class="stat-label">Auth Mappings</div>
      <div class="stat-value">${data.totalMappings}</div>
      <div class="stat-sub">unique computer-account pairs</div>
    </div>
    <div class="stat-card info">
      <div class="stat-label">Imports</div>
      <div class="stat-value">${data.totalImports}</div>
      <div class="stat-sub">data collection runs</div>
    </div>
  `;
}

function renderDashCharts(data) {
  const c = getChartColors();

  // Destroy old charts
  Object.values(charts).forEach(ch => ch.destroy());
  charts = {};

  // Top Accounts bar chart
  if (data.topAccounts.length > 0) {
    charts.topAccounts = new Chart(document.getElementById('chartTopAccounts'), {
      type: 'bar',
      data: {
        labels: data.topAccounts.map(a => a.name.length > 25 ? a.name.slice(0, 25) + '…' : a.name),
        datasets: [{ data: data.topAccounts.map(a => a.computer_count), backgroundColor: c.warning, borderRadius: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: c.text }, grid: { color: c.grid } },
          y: { ticks: { color: c.text, font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }

  // Top Computers bar chart
  if (data.topComputers.length > 0) {
    charts.topComputers = new Chart(document.getElementById('chartTopComputers'), {
      type: 'bar',
      data: {
        labels: data.topComputers.map(a => a.name.length > 25 ? a.name.slice(0, 25) + '…' : a.name),
        datasets: [{ data: data.topComputers.map(a => a.account_count), backgroundColor: c.accent, borderRadius: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: c.text }, grid: { color: c.grid } },
          y: { ticks: { color: c.text, font: { size: 11 } }, grid: { display: false } }
        }
      }
    });
  }

  // Account types doughnut
  charts.types = new Chart(document.getElementById('chartAccountTypes'), {
    type: 'doughnut',
    data: {
      labels: ['Service Accounts', 'User Accounts'],
      datasets: [{ data: [data.svcAccounts, data.userAccounts], backgroundColor: [c.warning, c.accent], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'right', labels: { color: c.text, font: { size: 12 } } } }
    }
  });

  // Distribution bar
  if (data.distribution.length > 0) {
    charts.dist = new Chart(document.getElementById('chartDistribution'), {
      type: 'bar',
      data: {
        labels: data.distribution.map(d => d.bucket + ' accounts'),
        datasets: [{ data: data.distribution.map(d => d.cnt), backgroundColor: c.palette.slice(0, data.distribution.length), borderRadius: 6 }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: c.text }, grid: { display: false } },
          y: { ticks: { color: c.text }, grid: { color: c.grid } }
        }
      }
    });
  }
}

function renderDashTables(data) {
  // OUs
  const ouPanel = document.getElementById('dashOuPanel');
  const ouBody = document.getElementById('dashOuBody');
  if (data.topOUs.length > 0) {
    ouPanel.style.display = '';
    ouBody.innerHTML = data.topOUs.map(o => `<tr><td style="font-size:12px;word-break:break-all;">${esc(o.ou)}</td><td><strong>${o.cnt}</strong></td></tr>`).join('');
  } else {
    ouPanel.style.display = 'none';
  }

  // Recent imports
  const impPanel = document.getElementById('dashImportPanel');
  const impBody = document.getElementById('dashImportBody');
  if (data.recentImports.length > 0) {
    impPanel.style.display = '';
    impBody.innerHTML = data.recentImports.map(i => `
      <tr>
        <td>${fmtDate(i.imported_at)}</td>
        <td>${esc(i.source_file || '-')}</td>
        <td>${esc(i.domain_controller || '-')}</td>
        <td>${i.computers_count}</td>
        <td>${i.accounts_count}</td>
        <td>${i.mappings_count}</td>
      </tr>
    `).join('');
  } else {
    impPanel.style.display = 'none';
  }
}

function rebuildCharts() {
  loadDashboard();
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── COMPUTERS ────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

async function loadComputers() {
  const params = new URLSearchParams({
    page: compPage, limit: 100, sort: compSort, dir: compDir
  });
  if (compSearch) params.set('q', wildcardToLike(compSearch));
  if (compOuFilter) params.set('ou', wildcardToLike(compOuFilter));

  try {
    const r = await fetch('/api/computers?' + params);
    const result = await r.json();
    renderComputers(result.data);
    renderPagination('comp', result);
    setupCompSort();
  } catch (err) {
    console.error('Computers load error:', err);
  }
}

function renderComputers(computers) {
  const body = document.getElementById('compBody');
  if (computers.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:40px;">No computers found.</td></tr>';
    return;
  }
  body.innerHTML = computers.map(c => `
    <tr data-name="${esc(c.name)}">
      <td><strong>${esc(c.name)}</strong></td>
      <td style="font-size:12px;color:var(--text2);">${esc(c.ips || '-')}</td>
      <td style="font-size:11px;color:var(--text3);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c.ou)}">${esc(c.ou || '-')}</td>
      <td><span class="badge ${c.account_count > 10 ? 'badge-yellow' : 'badge-blue'}">${c.account_count}</span></td>
      <td style="font-size:12px;color:var(--text2);">${fmtDate(c.last_seen)}</td>
    </tr>
  `).join('');

  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openComputerDetail(tr.dataset.name));
  });
}

async function openComputerDetail(name) {
  const modal = document.getElementById('compModal');
  document.getElementById('compModalTitle').textContent = name;
  const body = document.getElementById('compModalBody');
  body.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
  modal.classList.add('open');
  document.body.classList.add('modal-open');

  try {
    const r = await fetch('/api/computers/' + encodeURIComponent(name));
    const data = await r.json();

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">Computer Name</div><div class="dv">${esc(data.name)}</div></div>
        <div class="detail-item"><div class="dl">OU</div><div class="dv" style="font-size:12px;">${esc(data.ou || 'Unknown')}</div></div>
        <div class="detail-item"><div class="dl">IP Addresses</div><div class="dv">${data.ips.length > 0 ? data.ips.map(ip => esc(ip)).join(', ') : '-'}</div></div>
        <div class="detail-item"><div class="dl">First / Last Seen</div><div class="dv">${fmtDate(data.first_seen)} / ${fmtDate(data.last_seen)}</div></div>
      </div>
      <h3 style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px;">
        Authenticated Accounts (${data.accounts.length})
      </h3>
      <div class="table-scroll" style="max-height:400px;">
        <table class="data-table">
          <thead><tr><th>Account</th><th>First Seen</th><th>Last Seen</th></tr></thead>
          <tbody>
            ${data.accounts.map(a => `
              <tr style="cursor:pointer;" onclick="openAccountDetail('${esc(a.name).replace(/'/g, "\\'")}')">
                <td><strong>${esc(a.name)}</strong></td>
                <td style="font-size:12px;color:var(--text2);">${fmtDate(a.first_seen)}</td>
                <td style="font-size:12px;color:var(--text2);">${fmtDate(a.last_seen)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${esc(err.message)}</p></div>`;
  }
}

function setupCompSort() {
  document.querySelectorAll('#compTable th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (compSort === col) { compDir = compDir === 'ASC' ? 'DESC' : 'ASC'; }
      else { compSort = col; compDir = 'ASC'; }
      document.querySelectorAll('#compTable th.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(compDir === 'ASC' ? 'sort-asc' : 'sort-desc');
      compPage = 1;
      loadComputers();
    };
  });
}

// Computer search
let compSearchTimer;
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('compSearch');
  if (el) el.addEventListener('input', () => {
    clearTimeout(compSearchTimer);
    compSearchTimer = setTimeout(() => { compSearch = el.value.trim(); compPage = 1; loadComputers(); }, 300);
  });
  const ouEl = document.getElementById('compOuFilter');
  if (ouEl) ouEl.addEventListener('input', () => {
    clearTimeout(compSearchTimer);
    compSearchTimer = setTimeout(() => { compOuFilter = ouEl.value.trim(); compPage = 1; loadComputers(); }, 300);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── ACCOUNTS ─────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

async function loadAccounts() {
  const params = new URLSearchParams({
    page: acctPage, limit: 100, sort: acctSort, dir: acctDir
  });
  if (acctSearch) params.set('q', wildcardToLike(acctSearch));

  try {
    const r = await fetch('/api/accounts?' + params);
    const result = await r.json();
    renderAccounts(result.data);
    renderPagination('acct', result);
    setupAcctSort();
  } catch (err) {
    console.error('Accounts load error:', err);
  }
}

function renderAccounts(accounts) {
  const body = document.getElementById('acctBody');
  if (accounts.length === 0) {
    body.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:40px;">No accounts found.</td></tr>';
    return;
  }
  body.innerHTML = accounts.map(a => {
    const isSvc = /svc|service/i.test(a.name);
    return `
      <tr data-name="${esc(a.name)}">
        <td><strong>${esc(a.name)}</strong> ${isSvc ? '<span class="badge badge-yellow">SVC</span>' : ''}</td>
        <td><span class="badge ${a.computer_count > 10 ? 'badge-yellow' : 'badge-blue'}">${a.computer_count}</span></td>
        <td style="font-size:12px;color:var(--text2);">${fmtDate(a.first_seen)}</td>
        <td style="font-size:12px;color:var(--text2);">${fmtDate(a.last_seen)}</td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', () => openAccountDetail(tr.dataset.name));
  });
}

async function openAccountDetail(name) {
  const modal = document.getElementById('acctModal');
  document.getElementById('acctModalTitle').textContent = name;
  const body = document.getElementById('acctModalBody');
  body.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner"></div></div>';
  modal.classList.add('open');
  document.body.classList.add('modal-open');

  try {
    const r = await fetch('/api/accounts/' + encodeURIComponent(name));
    const data = await r.json();
    const isSvc = /svc|service/i.test(data.name);

    body.innerHTML = `
      <div class="detail-grid">
        <div class="detail-item"><div class="dl">Account Name</div><div class="dv">${esc(data.name)} ${isSvc ? '<span class="badge badge-yellow">Service Account</span>' : ''}</div></div>
        <div class="detail-item"><div class="dl">Computers Used</div><div class="dv">${data.computers.length}</div></div>
        <div class="detail-item"><div class="dl">First Seen</div><div class="dv">${fmtDate(data.first_seen)}</div></div>
        <div class="detail-item"><div class="dl">Last Seen</div><div class="dv">${fmtDate(data.last_seen)}</div></div>
      </div>
      <h3 style="font-size:14px;font-weight:600;color:var(--text2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px;">
        Computers Where This Account Authenticated (${data.computers.length})
      </h3>
      <div class="table-scroll" style="max-height:400px;">
        <table class="data-table">
          <thead><tr><th>Computer</th><th>IPs</th><th>OU</th><th>First Seen</th><th>Last Seen</th></tr></thead>
          <tbody>
            ${data.computers.map(c => `
              <tr style="cursor:pointer;" onclick="openComputerDetail('${esc(c.name).replace(/'/g, "\\'")}')">
                <td><strong>${esc(c.name)}</strong></td>
                <td style="font-size:12px;color:var(--text2);">${esc(c.ips || '-')}</td>
                <td style="font-size:11px;color:var(--text3);max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c.ou)}">${esc(c.ou || '-')}</td>
                <td style="font-size:12px;color:var(--text2);">${fmtDate(c.first_seen)}</td>
                <td style="font-size:12px;color:var(--text2);">${fmtDate(c.last_seen)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = `<div class="empty-state"><h3>Error</h3><p>${esc(err.message)}</p></div>`;
  }
}

function setupAcctSort() {
  document.querySelectorAll('#acctTable th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.sort;
      if (acctSort === col) { acctDir = acctDir === 'ASC' ? 'DESC' : 'ASC'; }
      else { acctSort = col; acctDir = 'ASC'; }
      document.querySelectorAll('#acctTable th.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(acctDir === 'ASC' ? 'sort-asc' : 'sort-desc');
      acctPage = 1;
      loadAccounts();
    };
  });
}

// Account search
let acctSearchTimer;
document.addEventListener('DOMContentLoaded', () => {
  const el = document.getElementById('acctSearch');
  if (el) el.addEventListener('input', () => {
    clearTimeout(acctSearchTimer);
    acctSearchTimer = setTimeout(() => { acctSearch = el.value.trim(); acctPage = 1; loadAccounts(); }, 300);
  });
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── PAGINATION ───────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

function renderPagination(prefix, result) {
  const el = document.getElementById(prefix + 'Pagination');
  const totalPages = Math.ceil(result.total / result.limit) || 1;
  const current = result.page;

  if (totalPages <= 1) { el.innerHTML = `<span class="page-info">${result.total} total</span>`; return; }

  el.innerHTML = `
    <button ${current <= 1 ? 'disabled' : ''} data-page="${current - 1}">← Prev</button>
    <span class="page-info">Page ${current} of ${totalPages} (${result.total} total)</span>
    <button ${current >= totalPages ? 'disabled' : ''} data-page="${current + 1}">Next →</button>
  `;

  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = parseInt(btn.dataset.page);
      if (prefix === 'comp') { compPage = p; loadComputers(); }
      else if (prefix === 'acct') { acctPage = p; loadAccounts(); }
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── NETWORK MAP (Canvas-based force graph) ───────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

async function loadNetwork() {
  const params = new URLSearchParams();
  const search = document.getElementById('netSearch').value.trim();
  const acctFilter = document.getElementById('netAccountFilter').value.trim();
  if (search) params.set('q', wildcardToLike(search));
  if (acctFilter) params.set('account', wildcardToLike(acctFilter));

  try {
    const r = await fetch('/api/network?' + params);
    networkData = await r.json();
    initNetworkGraph();
  } catch (err) {
    console.error('Network load error:', err);
  }
}

function initNetworkGraph() {
  const canvas = document.getElementById('networkCanvas');
  const ctx = canvas.getContext('2d');

  // Set canvas resolution
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  const W = rect.width, H = rect.height;

  if (!networkData || networkData.nodes.length === 0) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim();
    ctx.font = '14px Inter, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No data. Import authentication data and apply filters to view the network map.', W / 2, H / 2);
    return;
  }

  const nodes = networkData.nodes;
  const links = networkData.links;

  // Limit display for performance: if too many nodes, show a subset message
  const MAX_NODES = 300;
  if (nodes.length > MAX_NODES) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text3').trim();
    ctx.font = '14px Inter, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(`Too many nodes (${nodes.length}). Use filters to narrow down the view.`, W / 2, H / 2);
    return;
  }

  // Build adjacency for force layout
  const nodeMap = new Map();
  nodes.forEach((n, i) => {
    n._x = W / 2 + (Math.random() - 0.5) * W * 0.6;
    n._y = H / 2 + (Math.random() - 0.5) * H * 0.6;
    n._vx = 0; n._vy = 0;
    nodeMap.set(n.id, i);
  });

  const linkIdx = links.map(l => ({
    s: nodeMap.get(l.source),
    t: nodeMap.get(l.target)
  })).filter(l => l.s !== undefined && l.t !== undefined);

  // Simple force simulation
  const iterations = 120;
  const repulsion = 800;
  const attraction = 0.003;
  const damping = 0.92;
  const idealDist = 80;

  for (let iter = 0; iter < iterations; iter++) {
    // Repulsion between all nodes
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        let dx = nodes[j]._x - nodes[i]._x;
        let dy = nodes[j]._y - nodes[i]._y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 1;
        let force = repulsion / (dist * dist);
        let fx = (dx / dist) * force;
        let fy = (dy / dist) * force;
        nodes[i]._vx -= fx; nodes[i]._vy -= fy;
        nodes[j]._vx += fx; nodes[j]._vy += fy;
      }
    }

    // Attraction along links
    for (const { s, t } of linkIdx) {
      let dx = nodes[t]._x - nodes[s]._x;
      let dy = nodes[t]._y - nodes[s]._y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let force = (dist - idealDist) * attraction;
      let fx = (dx / dist) * force;
      let fy = (dy / dist) * force;
      nodes[s]._vx += fx; nodes[s]._vy += fy;
      nodes[t]._vx -= fx; nodes[t]._vy -= fy;
    }

    // Center gravity
    for (const n of nodes) {
      n._vx += (W / 2 - n._x) * 0.001;
      n._vy += (H / 2 - n._y) * 0.001;
    }

    // Apply velocity
    for (const n of nodes) {
      n._vx *= damping; n._vy *= damping;
      n._x += n._vx; n._y += n._vy;
      n._x = Math.max(20, Math.min(W - 20, n._x));
      n._y = Math.max(20, Math.min(H - 20, n._y));
    }
  }

  netNodePositions = nodes;
  netPanX = 0; netPanY = 0; netZoom = 1;

  drawNetwork(canvas);
  setupNetworkInteraction(canvas);
}

function drawNetwork(canvas) {
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;
  const cs = getComputedStyle(document.documentElement);

  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(netPanX, netPanY);
  ctx.scale(netZoom, netZoom);

  if (!networkData || !netNodePositions) { ctx.restore(); return; }

  const nodes = netNodePositions;
  const links = networkData.links;
  const nodeMap = new Map();
  nodes.forEach(n => nodeMap.set(n.id, n));

  const accentColor = '#4f8cff';
  const warningColor = '#f5a623';
  const lineColor = cs.getPropertyValue('--border2').trim() || '#353840';
  const textColor = cs.getPropertyValue('--text').trim() || '#e4e6ed';

  // Draw links
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 0.5;
  ctx.globalAlpha = 0.4;
  for (const link of links) {
    const s = nodeMap.get(link.source);
    const t = nodeMap.get(link.target);
    if (!s || !t) continue;
    ctx.beginPath();
    ctx.moveTo(s._x, s._y);
    ctx.lineTo(t._x, t._y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Draw nodes
  for (const node of nodes) {
    const isComputer = node.type === 'computer';
    const color = isComputer ? accentColor : warningColor;
    const radius = isComputer ? 8 : 6;

    ctx.beginPath();
    ctx.arc(node._x, node._y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // Label
    ctx.fillStyle = textColor;
    ctx.font = `${10 / netZoom > 10 ? 10 : Math.max(8, 10 / netZoom)}px Inter, system-ui`;
    ctx.textAlign = 'center';
    const label = node.label.length > 18 ? node.label.slice(0, 18) + '…' : node.label;
    ctx.fillText(label, node._x, node._y + radius + 12);
  }

  ctx.restore();
}

function setupNetworkInteraction(canvas) {
  // Remove old listeners by cloning
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);

  let dragging = false, lastX = 0, lastY = 0;

  newCanvas.addEventListener('mousedown', (e) => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    newCanvas.style.cursor = 'grabbing';
  });

  newCanvas.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    netPanX += e.clientX - lastX;
    netPanY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    drawNetwork(newCanvas);
  });

  newCanvas.addEventListener('mouseup', () => { dragging = false; newCanvas.style.cursor = 'grab'; });
  newCanvas.addEventListener('mouseleave', () => { dragging = false; newCanvas.style.cursor = 'grab'; });

  newCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    netZoom = Math.max(0.2, Math.min(5, netZoom * delta));
    drawNetwork(newCanvas);
  }, { passive: false });

  // Click on node
  newCanvas.addEventListener('click', (e) => {
    if (!netNodePositions) return;
    const rect = newCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - netPanX) / netZoom;
    const my = (e.clientY - rect.top - netPanY) / netZoom;

    for (const node of netNodePositions) {
      const dx = node._x - mx, dy = node._y - my;
      if (dx * dx + dy * dy < 144) { // radius 12
        if (node.type === 'computer') openComputerDetail(node.label);
        else openAccountDetail(node.label);
        break;
      }
    }
  });
}

// Network filter listeners
document.addEventListener('DOMContentLoaded', () => {
  let netTimer;
  const netSearch = document.getElementById('netSearch');
  const netAcct = document.getElementById('netAccountFilter');
  if (netSearch) netSearch.addEventListener('input', () => { clearTimeout(netTimer); netTimer = setTimeout(loadNetwork, 500); });
  if (netAcct) netAcct.addEventListener('input', () => { clearTimeout(netTimer); netTimer = setTimeout(loadNetwork, 500); });
  const netRefresh = document.getElementById('netRefreshBtn');
  if (netRefresh) netRefresh.addEventListener('click', loadNetwork);
});

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── IMPORT ───────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

function setupImport() {
  const zone = document.getElementById('importZone');
  const fileInput = document.getElementById('importFile');

  document.getElementById('importBrowseBtn').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) importFile(fileInput.files[0]);
  });

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) importFile(e.dataTransfer.files[0]);
  });

  // Path import
  document.getElementById('importPathBtn').addEventListener('click', async () => {
    const p = document.getElementById('importPathInput').value.trim();
    if (!p) { toast('Enter a file path', 'error'); return; }
    try {
      const r = await fetch('/api/import/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: p })
      });
      const result = await r.json();
      if (result.error) { toast(result.error, 'error'); return; }
      toast(`Imported ${result.computers} computers, ${result.accounts} accounts, ${result.mappings} mappings`);
      loadImportHistory();
      loadDashboard();
    } catch (err) {
      toast('Import failed: ' + err.message, 'error');
    }
  });

  // Purge
  document.getElementById('purgeBtn').addEventListener('click', async () => {
    if (!confirm('This will permanently delete ALL imported data. Are you sure?')) return;
    try {
      await fetch('/api/purge', { method: 'POST' });
      toast('All data purged');
      loadImportHistory();
      loadDashboard();
    } catch (err) {
      toast('Purge failed', 'error');
    }
  });
}

async function importFile(file) {
  try {
    const text = await file.text();
    const jsonData = JSON.parse(text);
    const r = await fetch('/api/import?source=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonData)
    });
    const result = await r.json();
    if (result.error) { toast(result.error, 'error'); return; }
    toast(`Imported ${result.computers} computers, ${result.accounts} accounts, ${result.mappings} mappings`);
    loadImportHistory();
    loadDashboard();
  } catch (err) {
    toast('Import failed: ' + err.message, 'error');
  }
}

async function loadImportHistory() {
  try {
    const r = await fetch('/api/imports');
    const runs = await r.json();
    const body = document.getElementById('importHistoryBody');
    if (runs.length === 0) {
      body.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:40px;">No imports yet.</td></tr>';
      return;
    }
    body.innerHTML = runs.map(i => `
      <tr>
        <td>${fmtDate(i.imported_at)}</td>
        <td>${esc(i.source_file || '-')}</td>
        <td>${esc(i.domain_controller || '-')}</td>
        <td>${esc(i.collected_at ? fmtDate(i.collected_at) : '-')}</td>
        <td>${i.computers_count}</td>
        <td>${i.accounts_count}</td>
        <td>${i.mappings_count}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Import history error:', err);
  }
}

/* ══════════════════════════════════════════════════════════════════════════ */
/* ── EXPORT ───────────────────────────────────────────────────────────── */
/* ══════════════════════════════════════════════════════════════════════════ */

function setupExport() {
  document.getElementById('exportComputersBtn').addEventListener('click', () => downloadExport('computers'));
  document.getElementById('exportAccountsBtn').addEventListener('click', () => downloadExport('accounts'));
  document.getElementById('exportMappingsBtn').addEventListener('click', () => downloadExport('mappings'));
  document.getElementById('compExportBtn').addEventListener('click', () => {
    const params = new URLSearchParams();
    if (compSearch) params.set('q', wildcardToLike(compSearch));
    if (compOuFilter) params.set('ou', wildcardToLike(compOuFilter));
    downloadExport('computers', params);
  });
  document.getElementById('acctExportBtn').addEventListener('click', () => {
    const params = new URLSearchParams();
    if (acctSearch) params.set('q', wildcardToLike(acctSearch));
    downloadExport('accounts', params);
  });
}

function downloadExport(type, extraParams) {
  const params = extraParams || new URLSearchParams();
  const url = `/api/export/${type}?${params}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
