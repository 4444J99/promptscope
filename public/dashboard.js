'use strict';

const $ = (id) => document.getElementById(id);

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v % 1_000_000 ? 1 : 0) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(v % 1_000 ? 1 : 0) + 'k';
  return String(v);
}

function pct(part, whole) {
  if (!whole) return '0%';
  return (Math.round((part / whole) * 1000) / 10) + '%';
}

function sumField(daily, field) {
  return daily.reduce((acc, d) => acc + (Number(d[field]) || 0), 0);
}

// Field-by-field maximum so a row is never `undefined` if a counter never fired.
const get = (obj, field) => Number(obj && obj[field]) || 0;

function renderCards(data) {
  const totals = data.totals || {};
  const today = data.today || {};
  const daily = data.daily || [];

  const windowAnalyses = sumField(daily, 'analyze');

  $('stat-today').textContent = fmt(get(today, 'analyze'));
  $('stat-today-sub').textContent =
    `${fmt(get(today, 'analyze_free'))} free · ${fmt(get(today, 'analyze_pro'))} pro`;

  $('stat-total').textContent = fmt(get(totals, 'analyze'));
  $('stat-total-sub').textContent = `${fmt(windowAnalyses)} in last ${data.window_days || 14}d`;

  $('stat-pro').textContent = pct(get(totals, 'analyze_pro'), get(totals, 'analyze'));
  $('stat-pro-sub').textContent =
    `${fmt(get(totals, 'analyze_pro'))} pro · ${fmt(get(totals, 'analyze_free'))} free`;

  $('stat-shares').textContent = fmt(get(totals, 'share_created'));
  $('stat-shares-sub').textContent = `${fmt(get(today, 'share_created'))} today`;

  $('stat-rewrites').textContent = fmt(get(totals, 'rewrite'));
  $('stat-tokens').textContent = fmt(get(totals, 'tokens'));

  $('dash-cards').hidden = false;
}

function renderChart(data) {
  const daily = data.daily || [];
  const chart = $('chart');
  chart.innerHTML = '';
  $('chart-title').textContent = `Analyses — last ${data.window_days || daily.length} days`;

  const max = Math.max(1, ...daily.map((d) => get(d, 'analyze')));
  for (const d of daily) {
    const count = get(d, 'analyze');
    const proCount = get(d, 'analyze_pro');
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = Math.round((count / max) * 100) + '%';
    bar.title = `${d.date}: ${count} analyses (${proCount} pro)`;

    if (proCount > 0 && count > 0) {
      const pro = document.createElement('div');
      pro.className = 'bar-pro';
      pro.style.height = Math.round((proCount / count) * 100) + '%';
      bar.appendChild(pro);
    }

    const col = document.createElement('div');
    col.className = 'bar-col';
    col.appendChild(bar);
    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = d.date.slice(5); // MM-DD
    col.appendChild(label);
    chart.appendChild(col);
  }
  $('dash-chart').hidden = false;
}

const OPS_ROWS = [
  ['analyze', 'Analyses'],
  ['analyze_free', 'Free analyses'],
  ['analyze_pro', 'Pro analyses'],
  ['rewrite', 'Rewrites'],
  ['share_created', 'Share links'],
  ['rate_limited', 'Free quota hits'],
  ['license_valid', 'Valid license checks'],
  ['license_invalid', 'Invalid license checks'],
];

function renderOps(data) {
  const totals = data.totals || {};
  const today = data.today || {};
  const body = $('ops-body');
  body.innerHTML = '';
  for (const [field, label] of OPS_ROWS) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${label}</td><td>${fmt(get(today, field))}</td><td>${fmt(get(totals, field))}</td>`;
    body.appendChild(tr);
  }
  $('dash-ops').hidden = false;
}

function setStatus(data) {
  const since = data.since ? `since ${data.since}` : 'since launch';
  const when = new Date(data.generated_at || Date.now()).toLocaleString();
  const pro = data.config && data.config.pro_checkout_configured ? 'Pro checkout live' : 'Pro checkout not configured';
  $('dash-status').textContent = `Updated ${when} · ${since} · ${pro}`;
}

async function load() {
  const err = $('dash-error');
  err.hidden = true;
  $('dash-status').textContent = 'Loading metrics…';
  try {
    const resp = await fetch('/api/stats', { headers: { accept: 'application/json' } });
    if (!resp.ok) throw new Error(`stats request failed (${resp.status})`);
    const data = await resp.json();
    setStatus(data);
    renderCards(data);
    renderChart(data);
    renderOps(data);
  } catch (e) {
    $('dash-status').textContent = 'Could not load metrics.';
    err.textContent = String((e && e.message) || e);
    err.hidden = false;
  }
}

$('refresh-btn').addEventListener('click', load);
load();
