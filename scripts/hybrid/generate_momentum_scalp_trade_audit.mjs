#!/usr/bin/env node
/**
 * Real trade audit HTML — momentum_scalp_tv mono 15m (SUI/DOGE/SOL/CRV).
 * Candles + EMA/ADX + entry/exit/SL/TP markers from engine backtest.
 *
 *   cd backend && npm run build && node ../scripts/hybrid/generate_momentum_scalp_trade_audit.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);

const database = require(path.join(backendRoot, 'dist/utils/database.js'));
const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine.js'));
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const {
  buildMomentumScalpIndicatorSeries,
  extractMomentumScalpParams,
  momentumScalpTpSlPrices,
} = require(path.join(backendRoot, 'dist/bot/momentumScalpSignal.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

const API_KEY = process.env.API_KEY || 'BTDD_D1';
const DATE_FROM = process.env.AUDIT_FROM || '2026-05-01';
const DATE_TO = process.env.AUDIT_TO || '2026-07-04';
const OUT_HTML = process.env.OUT_HTML || path.join(root, 'docs', 'MOMENTUM_SCALP_TV_TRADE_AUDIT.html');
const INITIAL = 10000;
const LOT = Number(process.env.AUDIT_LOT || '22');

const SYMBOLS = [
  { sym: 'SUIUSDT', sid: Number(process.env.SID_SUI || 253636) },
  { sym: 'DOGEUSDT', sid: Number(process.env.SID_DOGE || 253637) },
  { sym: 'SOLUSDT', sid: Number(process.env.SID_SOL || 253638) },
  { sym: 'CRVUSDT', sid: Number(process.env.SID_CRV || 254019) },
];

const msToIso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const fmt = (n, d = 4) => (Number.isFinite(n) ? Number(n).toFixed(d) : '—');

await database.initDB();
const { db } = database;
await ensureExchangeClientInitialized(API_KEY);

const markets = [];

for (const { sym, sid } of SYMBOLS) {
  const strat = await db.get('SELECT * FROM strategies WHERE id=?', [sid]);
  if (!strat) {
    console.warn('skip', sym, 'no strategy', sid);
    continue;
  }
  const params = extractMomentumScalpParams(strat);
  console.log(`Backtest ${sym} id=${sid} ${DATE_FROM}..${DATE_TO}`);
  const result = await runBacktest({
    apiKeyName: API_KEY,
    mode: 'single',
    strategyId: sid,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    bars: 900,
    warmupBars: 120,
    initialBalance: INITIAL,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    lotPercentOverride: LOT,
    reinvestPercentOverride: 0,
    enablePairLock: true,
  });
  const rawCandles = await wickData.fetchMonoCandles(API_KEY, sym, '15m', {
    startMs: Date.parse(`${DATE_FROM}T00:00:00Z`),
    endMs: Date.parse(`${DATE_TO}T23:59:59Z`),
    limit: 8000,
  });
  const candles = rawCandles.map((c) => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    timeMs: c.timeMs,
  }));
  const ind = buildMomentumScalpIndicatorSeries(candles, params);
  const normMs = (t) => {
    const v = Number(t || 0);
    return v > 0 && v < 1_000_000_000_000 ? v * 1000 : v;
  };
  const timeToIdx = new Map(candles.map((b, i) => [b.timeMs, i]));
  const idxFor = (t) => {
    const ms = normMs(t);
    if (timeToIdx.has(ms)) return timeToIdx.get(ms);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < candles.length; i += 1) {
      const d = Math.abs(candles[i].timeMs - ms);
      if (d < bestD) { bestD = d; best = i; }
    }
    return bestD < 16 * 60 * 1000 ? best : -1;
  };

  const trades = (result.trades || []).map((t) => {
    const entryIdx = idxFor(t.entryTime);
    const exitIdx = idxFor(t.exitTime);
    const side = t.side;
    const { tp, sl } = momentumScalpTpSlPrices(side, t.entryPrice, params);
    const ei = entryIdx >= 0 ? entryIdx : 0;
    return {
      side,
      entryTime: t.entryTime,
      exitTime: t.exitTime,
      entryTimeIso: msToIso(t.entryTime),
      exitTimeIso: msToIso(t.exitTime),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      tp,
      sl,
      netPnl: t.netPnl,
      pnlPercent: t.pnlPercent,
      reason: t.reason,
      fees: t.fees,
      entry: {
        emaFast: ind.emaFast[ei],
        emaSlow: ind.emaSlow[ei],
        adx: ind.adx[ei],
        plusDi: ind.plusDi[ei],
        minusDi: ind.minusDi[ei],
        close: candles[ei]?.close,
      },
      exit: exitIdx >= 0 ? {
        emaFast: ind.emaFast[exitIdx],
        emaSlow: ind.emaSlow[exitIdx],
        adx: ind.adx[exitIdx],
        plusDi: ind.plusDi[exitIdx],
        minusDi: ind.minusDi[exitIdx],
        close: candles[exitIdx]?.close,
      } : null,
    };
  });

  const wins = trades.filter((t) => t.netPnl >= 0).length;
  const summary = result.summary || {};
  markets.push({
    symbol: sym,
    strategyId: sid,
    params,
    summary: {
      ret: summary.totalReturnPercent,
      dd: summary.maxDrawdownPercent,
      trades: summary.tradesCount,
      pf: summary.profitFactor,
      winRate: summary.winRatePercent,
    },
    stats: {
      wins,
      losses: trades.length - wins,
      netPnl: trades.reduce((s, t) => s + t.netPnl, 0),
    },
    candles: candles.map((b) => ({
      time: Math.floor(b.timeMs / 1000),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    })),
    emaFast: candles.map((b, i) => ({ time: Math.floor(b.timeMs / 1000), value: ind.emaFast[i] })).filter((p) => Number.isFinite(p.value)),
    emaSlow: candles.map((b, i) => ({ time: Math.floor(b.timeMs / 1000), value: ind.emaSlow[i] })).filter((p) => Number.isFinite(p.value)),
    trades,
  });
  console.log(`  ${sym}: ${trades.length} trades ret=${fmt(summary.totalReturnPercent, 1)}%`);
}

const payload = {
  generatedAt: new Date().toISOString(),
  dateFrom: DATE_FROM,
  dateTo: DATE_TO,
  engine: 'runBacktest single momentum_scalp_tv',
  lotPercent: LOT,
  preset: { emaFast: 8, emaSlow: 21, adxMin: 20, tp: 2, sl: 1.2 },
  markets,
};

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <title>TV Momentum Scalp — аудит сделок ${DATE_FROM} → ${DATE_TO}</title>
  <script src="https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    :root { --bg:#0d1117; --card:#161b22; --text:#e6edf3; --muted:#8b949e; --green:#3fb950; --red:#f85149; --blue:#58a6ff; }
    * { box-sizing:border-box; }
    body { font-family: system-ui, sans-serif; background:var(--bg); color:var(--text); margin:0; padding:16px 20px 40px; line-height:1.45; }
    h1 { font-size:1.35rem; margin:0 0 8px; }
    h2 { font-size:1.1rem; margin:24px 0 8px; color:var(--blue); }
    .meta { color:var(--muted); font-size:0.9rem; margin-bottom:20px; }
    .explain { background:var(--card); border:1px solid #30363d; border-radius:8px; padding:14px 16px; margin-bottom:20px; max-width:960px; }
    .explain li { margin:6px 0; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; margin:12px 0; }
    .stat { background:var(--card); border:1px solid #30363d; border-radius:8px; padding:10px 12px; }
    .stat b { display:block; font-size:1.2rem; }
    .stat span { color:var(--muted); font-size:0.8rem; }
    .chart-wrap { background:var(--card); border:1px solid #30363d; border-radius:8px; padding:8px; margin:12px 0 8px; }
    .chart { height:380px; width:100%; }
    table { width:100%; border-collapse:collapse; font-size:0.78rem; margin-top:8px; }
    th,td { border:1px solid #30363d; padding:5px 6px; text-align:left; }
    th { background:#21262d; position:sticky; top:0; }
    tr.win td { color:var(--green); }
    tr.loss td { color:var(--red); }
    .reason { font-family:monospace; font-size:0.72rem; }
    .tabs { display:flex; gap:8px; flex-wrap:wrap; margin:16px 0 8px; }
    .tab { padding:8px 14px; background:var(--card); border:1px solid #30363d; border-radius:6px; cursor:pointer; }
    .tab.active { border-color:var(--blue); color:var(--blue); }
    .panel { display:none; }
    .panel.active { display:block; }
    code { background:#21262d; padding:1px 5px; border-radius:4px; }
  </style>
</head>
<body>
  <h1>TV Momentum Scalp (<code>momentum_scalp_tv</code>) — реальный аудит</h1>
  <p class="meta">Период: <b>${DATE_FROM}</b> → <b>${DATE_TO}</b> · 15m · движок <code>runBacktest()</code> · lot ${LOT}% · депозит ${INITIAL} USDT · сгенерировано ${payload.generatedAt}</p>

  <div class="explain">
    <strong>Почему стратегия работает (логика движка, не Pine):</strong>
    <ul>
      <li><b>Вход long:</b> EMA8 пересекает EMA21 снизу вверх + ADX≥20 + +DI &gt; −DI (тренд вверх подтверждён).</li>
      <li><b>Вход short:</b> обратный кросс + ADX≥20 + −DI &gt; +DI.</li>
      <li><b>Выход:</b> TP +2% / SL −1.2% от цены входа, либо обратный кросс EMA (<code>ms_cross_*</code>).</li>
      <li><b>Короткие сделки</b> на liquid alts → много циклов, PF&gt;1, низкая DD при фиксированном SL.</li>
      <li>На графике: ▲/▼ = вход, ● = выход, пунктир = уровни SL/TP на момент входа.</li>
    </ul>
  </div>

  <div class="tabs" id="tabs"></div>
  <div id="panels"></div>

  <script>
    const DATA = ${JSON.stringify(payload)};
    const tabsEl = document.getElementById('tabs');
    const panelsEl = document.getElementById('panels');

    function reasonRu(r) {
      if (r.includes('ms_tp')) return 'TP +2%';
      if (r.includes('ms_sl')) return 'SL −1.2%';
      if (r.includes('ms_cross')) return 'EMA cross';
      return r;
    }

    DATA.markets.forEach((m, idx) => {
      const tab = document.createElement('button');
      tab.className = 'tab' + (idx === 0 ? ' active' : '');
      tab.textContent = m.symbol;
      tab.onclick = () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + idx).classList.add('active');
      };
      tabsEl.appendChild(tab);

      const panel = document.createElement('div');
      panel.className = 'panel' + (idx === 0 ? ' active' : '');
      panel.id = 'panel-' + idx;
      panel.innerHTML = \`
        <h2>\${m.symbol} · strategy #\${m.strategyId}</h2>
        <div class="grid">
          <div class="stat"><b>\${(m.summary.ret||0).toFixed(1)}%</b><span>Ret (изолированно)</span></div>
          <div class="stat"><b>\${(m.summary.dd||0).toFixed(1)}%</b><span>Max DD</span></div>
          <div class="stat"><b>\${m.summary.trades||0}</b><span>Сделок</span></div>
          <div class="stat"><b>\${(m.summary.pf||0).toFixed(2)}</b><span>PF</span></div>
          <div class="stat"><b>\${m.stats.wins}/\${m.stats.losses}</b><span>W/L</span></div>
          <div class="stat"><b>\${m.stats.netPnl.toFixed(2)}</b><span>Net PnL USDT</span></div>
        </div>
        <div class="chart-wrap"><div class="chart" id="chart-\${idx}"></div></div>
        <details open><summary>Сделки (\${m.trades.length}) — индикаторы на входе</summary>
        <div style="max-height:320px;overflow:auto">
        <table><thead><tr>
          <th>#</th><th>Сторона</th><th>Вход</th><th>Выход</th><th>PnL</th><th>Причина</th>
          <th>EMA8</th><th>EMA21</th><th>ADX</th><th>+DI</th><th>−DI</th><th>TP</th><th>SL</th>
        </tr></thead><tbody id="tbody-\${idx}"></tbody></table></div></details>
      \`;
      panelsEl.appendChild(panel);

      const tbody = panel.querySelector('#tbody-' + idx);
      m.trades.forEach((t, i) => {
        const tr = document.createElement('tr');
        tr.className = t.netPnl >= 0 ? 'win' : 'loss';
        tr.innerHTML = \`
          <td>\${i+1}</td><td>\${t.side}</td>
          <td>\${t.entryTimeIso}<br/><small>\${t.entryPrice.toFixed(5)}</small></td>
          <td>\${t.exitTimeIso}<br/><small>\${t.exitPrice.toFixed(5)}</small></td>
          <td>\${t.netPnl.toFixed(2)} (\${t.pnlPercent.toFixed(2)}%)</td>
          <td class="reason">\${reasonRu(t.reason)}</td>
          <td>\${t.entry.emaFast?.toFixed(4)||'—'}</td>
          <td>\${t.entry.emaSlow?.toFixed(4)||'—'}</td>
          <td>\${t.entry.adx?.toFixed(1)||'—'}</td>
          <td>\${t.entry.plusDi?.toFixed(1)||'—'}</td>
          <td>\${t.entry.minusDi?.toFixed(1)||'—'}</td>
          <td>\${t.tp.toFixed(5)}</td>
          <td>\${t.sl.toFixed(5)}</td>
        \`;
        tbody.appendChild(tr);
      });

      const el = document.getElementById('chart-' + idx);
      const chart = LightweightCharts.createChart(el, {
        layout: { background: { color: '#161b22' }, textColor: '#8b949e' },
        grid: { vertLines: { color: '#21262d' }, horzLines: { color: '#21262d' } },
        timeScale: { timeVisible: true, secondsVisible: false },
        rightPriceScale: { borderColor: '#30363d' },
      });
      const cs = chart.addCandlestickSeries({
        upColor: '#3fb950', downColor: '#f85149', borderVisible: false,
        wickUpColor: '#3fb950', wickDownColor: '#f85149',
      });
      cs.setData(m.candles);
      const ema8 = chart.addLineSeries({ color: '#58a6ff', lineWidth: 1, title: 'EMA8' });
      ema8.setData(m.emaFast);
      const ema21 = chart.addLineSeries({ color: '#d2a8ff', lineWidth: 1, title: 'EMA21' });
      ema21.setData(m.emaSlow);

      const markers = [];
      m.trades.forEach(t => {
        const et = Math.floor(t.entryTime / 1000);
        const xt = Math.floor(t.exitTime / 1000);
        markers.push({
          time: et,
          position: t.side === 'long' ? 'belowBar' : 'aboveBar',
          color: t.side === 'long' ? '#3fb950' : '#f85149',
          shape: t.side === 'long' ? 'arrowUp' : 'arrowDown',
          text: t.side[0].toUpperCase(),
        });
        markers.push({
          time: xt,
          position: 'inBar',
          color: t.netPnl >= 0 ? '#3fb950' : '#f85149',
          shape: 'circle',
          text: reasonRu(t.reason).slice(0, 3),
        });
      });
      markers.sort((a, b) => a.time - b.time);
      cs.setMarkers(markers);
      chart.timeScale().fitContent();
    });
  </script>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true });
fs.writeFileSync(OUT_HTML, html);
console.log(`wrote ${OUT_HTML} (${markets.length} markets)`);
