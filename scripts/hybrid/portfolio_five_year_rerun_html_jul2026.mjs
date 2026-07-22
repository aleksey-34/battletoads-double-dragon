#!/usr/bin/env node
/**
 * API rerun (independent books → equity sum) for 5 storefront portfolios, last ~1y,
 * then write a self-contained HTML with equity charts.
 *
 *   cd /opt/battletoads-double-dragon/backend && node ../scripts/hybrid/portfolio_five_year_rerun_html_jul2026.mjs
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_JSON = path.join(REPO, 'docs', 'portfolio_five_1y_rerun_jul2026.json');
const OUT_HTML = path.join(REPO, 'docs', 'portfolio_five_1y_equity_jul2026.html');

const DATE_FROM = process.env.DATE_FROM || '2025-07-22';
const DATE_TO = process.env.DATE_TO || '2026-07-22';
const PORTFOLIOS = (process.env.SET_KEYS || [
  'portfolio-conservative-jul2026',
  'portfolio-balanced-jul2026',
  'portfolio-aggressive-jul2026',
  'portfolio-quality-tilt-jul2026',
  'portfolio-triple-zz-jul2026',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

process.env.LOG_CONSOLE_LEVEL = process.env.LOG_CONSOLE_LEVEL || 'error';

const require = createRequire(import.meta.url);
const database = require(path.join(backendRoot, 'dist/utils/database.js'));
const { previewAdminSweepBacktest } = require(path.join(backendRoot, 'dist/saas/service.js'));

const downsample = (curve, maxPts = 220) => {
  if (!Array.isArray(curve) || curve.length <= maxPts) return curve || [];
  const step = Math.ceil(curve.length / maxPts);
  const out = [];
  for (let i = 0; i < curve.length; i += step) out.push(curve[i]);
  const last = curve[curve.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
};

const toSeries = (equity) => (equity || [])
  .map((p) => ({
    t: Number(p.time ?? p.t ?? 0),
    e: Number(p.equity ?? p.value ?? p.e ?? NaN),
  }))
  .filter((p) => p.t > 0 && Number.isFinite(p.e));

const main = async () => {
  await database.initDB();
  const results = [];
  const started = Date.now();

  for (const setKey of PORTFOLIOS) {
    console.log(`\n=== ${setKey} ${DATE_FROM}..${DATE_TO} ===`);
    const t0 = Date.now();
    try {
      const data = await previewAdminSweepBacktest({
        kind: 'algofund-ts',
        setKey,
        systemName: setKey,
        portfolioMode: true,
        preferRealBacktest: true,
        dateFrom: DATE_FROM,
        dateTo: DATE_TO,
        portfolioLotMult: 1,
        enablePairLock: true,
      });
      const summary = data?.preview?.summary || {};
      const equity = toSeries(data?.preview?.equity || []);
      const books = Array.isArray(data?.rerun?.books) ? data.rerun.books : (data?.publishMeta?.books || []);
      const row = {
        setKey,
        label: String(data?.publishMeta?.setKey || setKey),
        displayLabel: setKey
          .replace(/^portfolio-/, '')
          .replace(/-jul2026$/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase()),
        method: data?.rerun?.method || data?.publishMeta?.method || '',
        source: data?.preview?.source || '',
        dateFrom: data?.period?.actualDateFrom || data?.period?.dateFrom || DATE_FROM,
        dateTo: data?.period?.actualDateTo || data?.period?.dateTo || DATE_TO,
        capital: Number(summary.initialBalance || data?.controls?.initialBalance || 0),
        finalEquity: Number(summary.finalEquity || 0),
        ret: Number(summary.totalReturnPercent || 0),
        dd: Number(summary.maxDrawdownPercent || 0),
        pf: Number(summary.profitFactor || 0),
        trades: Number(summary.tradesCount || 0),
        books,
        curve: downsample(equity, 240),
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        ok: true,
      };
      // Prefer nicer display labels from DB if present in publishMeta
      results.push(row);
      console.log(`  OK ret=${row.ret}% dd=${row.dd}% trades=${row.trades} pts=${row.curve.length} ${row.elapsedSec}s`);
    } catch (e) {
      console.error(`  FAIL ${setKey}:`, e.message);
      results.push({
        setKey,
        displayLabel: setKey,
        ok: false,
        error: String(e.message || e),
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        curve: [],
      });
    }
  }

  // Enrich display labels from DB
  try {
    const { db } = database;
    for (const r of results) {
      const row = await db.get(
        `SELECT display_label FROM algofund_portfolios WHERE set_key = ? LIMIT 1`,
        [r.setKey],
      );
      if (row?.display_label) r.displayLabel = String(row.display_label);
    }
  } catch {
    // ignore
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    method: 'per_book_OP_then_equity_sum',
    note: 'Independent books (own OP/lot/capital/reinvest), equity curves summed — same as portfolio API rerun.',
    totalElapsedSec: Math.round((Date.now() - started) / 1000),
    portfolios: results,
  };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2));
  fs.writeFileSync(OUT_HTML, buildHtml(payload));
  console.log(`\nWrote ${OUT_JSON}`);
  console.log(`Wrote ${OUT_HTML}`);
  process.exit(results.every((r) => r.ok) ? 0 : 2);
};

const buildHtml = (payload) => {
  const dataJson = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Algofund — 5 portfolios equity (1y API rerun)</title>
<style>
  :root {
    --bg: #0f1419;
    --panel: #1a222c;
    --text: #e8eef4;
    --muted: #8b9aab;
    --line: #2a3644;
    --accent: #3d9cf0;
    --good: #3ecf8e;
    --bad: #f07178;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
    background: radial-gradient(1200px 600px at 10% -10%, #1b2a3a 0%, var(--bg) 55%);
    color: var(--text);
    min-height: 100vh;
  }
  header {
    padding: 28px 24px 8px;
    max-width: 1200px;
    margin: 0 auto;
  }
  header h1 {
    margin: 0 0 8px;
    font-size: 1.55rem;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  header p { margin: 0; color: var(--muted); font-size: 0.95rem; line-height: 1.45; }
  .meta {
    display: flex; flex-wrap: wrap; gap: 8px 14px;
    margin-top: 14px; font-size: 0.82rem; color: var(--muted);
  }
  .meta code { color: #b8c7d9; background: #121820; padding: 2px 6px; border-radius: 4px; }
  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 12px 24px 48px;
    display: grid;
    gap: 18px;
  }
  .card {
    background: linear-gradient(180deg, #1c2530 0%, var(--panel) 100%);
    border: 1px solid var(--line);
    border-radius: 14px;
    padding: 16px 16px 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  }
  .card-head {
    display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between;
    gap: 8px 16px; margin-bottom: 10px;
  }
  .card-head h2 { margin: 0; font-size: 1.15rem; font-weight: 600; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px 16px; font-size: 0.86rem; color: var(--muted); }
  .stats strong { color: var(--text); font-weight: 600; }
  .stats .ret { color: var(--good); }
  .stats .dd { color: var(--bad); }
  .chart-wrap { position: relative; height: 260px; width: 100%; }
  canvas { width: 100% !important; height: 100% !important; }
  .err { color: var(--bad); font-size: 0.9rem; padding: 12px 0; }
  footer { max-width: 1200px; margin: 0 auto; padding: 0 24px 40px; color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>
<header>
  <h1>Algofund portfolios — equity, last year</h1>
  <p>API rerun: independent books (own OP / lot / capital / reinvest) → sum of equity curves. Same model as admin portfolio API rerun.</p>
  <div class="meta">
    <span>Window: <code id="win"></code></span>
    <span>Method: <code id="method"></code></span>
    <span>Generated: <code id="gen"></code></span>
  </div>
</header>
<main id="root"></main>
<footer>Curves downsampled for the page. Full series in <code>portfolio_five_1y_rerun_jul2026.json</code>.</footer>
<script>
const DATA = ${dataJson};
document.getElementById('win').textContent = DATA.dateFrom + ' → ' + DATA.dateTo;
document.getElementById('method').textContent = DATA.method || '';
document.getElementById('gen').textContent = (DATA.generatedAt || '').replace('T', ' ').slice(0, 19) + 'Z';

const root = document.getElementById('root');
const fmt = (n, d=2) => Number.isFinite(n) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: d }) : '—';
const fmtPct = (n) => Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '—';

function drawChart(canvas, series) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 260;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!series.length) return;

  const pad = { l: 54, r: 14, t: 14, b: 28 };
  const w = cssW - pad.l - pad.r;
  const h = cssH - pad.t - pad.b;
  const xs = series.map(p => p.t);
  const ys = series.map(p => p.e);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let ymin = Math.min(...ys), ymax = Math.max(...ys);
  if (ymin === ymax) { ymin *= 0.98; ymax *= 1.02; }
  const yPad = (ymax - ymin) * 0.06;
  ymin -= yPad; ymax += yPad;

  const x = (t) => pad.l + ((t - xmin) / Math.max(1, xmax - xmin)) * w;
  const y = (e) => pad.t + (1 - (e - ymin) / Math.max(1e-9, ymax - ymin)) * h;

  // grid
  ctx.strokeStyle = '#243041';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = pad.t + (h * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + w, gy); ctx.stroke();
    const val = ymax - ((ymax - ymin) * i) / 4;
    ctx.fillStyle = '#7f8fa3';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(fmt(val, 0), pad.l - 6, gy + 3);
  }

  // area
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + h);
  grad.addColorStop(0, 'rgba(61,156,240,0.28)');
  grad.addColorStop(1, 'rgba(61,156,240,0.02)');
  ctx.beginPath();
  series.forEach((p, i) => {
    const px = x(p.t), py = y(p.e);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.lineTo(x(series[series.length - 1].t), pad.t + h);
  ctx.lineTo(x(series[0].t), pad.t + h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  series.forEach((p, i) => {
    const px = x(p.t), py = y(p.e);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = '#3d9cf0';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // x labels
  ctx.fillStyle = '#7f8fa3';
  ctx.font = '11px system-ui';
  ctx.textAlign = 'center';
  const mid = series[Math.floor(series.length / 2)];
  const label = (t) => new Date(t).toISOString().slice(0, 10);
  ctx.fillText(label(series[0].t), x(series[0].t), cssH - 8);
  if (mid) ctx.fillText(label(mid.t), x(mid.t), cssH - 8);
  ctx.fillText(label(series[series.length - 1].t), x(series[series.length - 1].t), cssH - 8);
}

for (const p of (DATA.portfolios || [])) {
  const card = document.createElement('section');
  card.className = 'card';
  if (!p.ok) {
    card.innerHTML = '<div class="card-head"><h2>' + (p.displayLabel || p.setKey) + '</h2></div>'
      + '<div class="err">Rerun failed: ' + (p.error || 'unknown') + '</div>';
    root.appendChild(card);
    continue;
  }
  card.innerHTML =
    '<div class="card-head">'
    + '<h2>' + (p.displayLabel || p.setKey) + '</h2>'
    + '<div class="stats">'
    + '<span>Ret <strong class="ret">' + fmtPct(p.ret) + '</strong></span>'
    + '<span>DD <strong class="dd">' + (Number.isFinite(p.dd) ? p.dd.toFixed(2) + '%' : '—') + '</strong></span>'
    + '<span>PF <strong>' + fmt(p.pf, 2) + '</strong></span>'
    + '<span>Trades <strong>' + fmt(p.trades, 0) + '</strong></span>'
    + '<span>Capital <strong>$' + fmt(p.capital, 0) + '</strong></span>'
    + '<span>Final <strong>$' + fmt(p.finalEquity, 0) + '</strong></span>'
    + '</div></div>'
    + '<div class="chart-wrap"><canvas></canvas></div>'
    + '<div class="stats" style="margin-top:6px">'
    + '<span>' + (p.dateFrom || '') + ' → ' + (p.dateTo || '') + '</span>'
    + '<span>' + (Array.isArray(p.books) ? p.books.map(b => b.role + ' OP' + (b.op||'—') + ' lot' + (b.lotEffective||b.lot||'—')).join(' · ') : '') + '</span>'
    + '</div>';
  root.appendChild(card);
  const canvas = card.querySelector('canvas');
  drawChart(canvas, p.curve || []);
}

window.addEventListener('resize', () => {
  root.querySelectorAll('.card').forEach((card, i) => {
    const p = DATA.portfolios[i];
    if (!p?.ok) return;
    drawChart(card.querySelector('canvas'), p.curve || []);
  });
});
</script>
</body>
</html>`;
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
