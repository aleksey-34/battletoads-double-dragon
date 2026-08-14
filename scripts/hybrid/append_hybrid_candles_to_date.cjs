#!/usr/bin/env node
/**
 * Roll hybrid candle bundles from last stored bar through DATE_TO (default: yesterday UTC).
 *
 *   node scripts/hybrid/append_hybrid_candles_to_date.cjs
 *   DATE_TO=2026-08-13 node scripts/hybrid/append_hybrid_candles_to_date.cjs --via-vps
 *
 * --via-vps: emit tasks, fetch on VPS with exchange keys, merge locally.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..');
const CRYPTO = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCKS = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026');
const VPS = process.env.BTDD_VPS || 'root@176.57.184.98';
const VPS_BACKEND = '/opt/battletoads-double-dragon/backend';

const yesterdayUtc = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const DATE_TO = process.env.DATE_TO || yesterdayUtc();
const DATE_TO_MS = Date.parse(`${DATE_TO}T23:59:59Z`);
const VIA_VPS = process.argv.includes('--via-vps');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');
const HAMFIVE_SYMBOLS = new Set([
  'APEUSDT', 'BCHUSDT', 'INJUSDT', 'SUIUSDT', 'WLDUSDT', 'ZENUSDT',
  'ADAUSDT', 'BNBUSDT', 'COMPUSDT', 'EIGENUSDT', 'ONDOUSDT', 'ORDIUSDT', 'TIAUSDT', 'XRPUSDT',
  'ARBUSDT', 'DOGEUSDT', 'NEARUSDT', 'SEIUSDT', 'BTCUSDT',
]);
try {
  const rec = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  for (const u of Object.values(rec.universes || {})) {
    for (const s of (u.symbols || u.apiSymbols || [])) HAMFIVE_SYMBOLS.add(String(s).toUpperCase());
  }
} catch { /* optional */ }

const listBundleFiles = (root) => {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const iv of fs.readdirSync(root)) {
    const dir = path.join(root, iv);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'manifest.json')) {
      out.push({ interval: iv, symbol: f.replace(/\.json$/i, ''), file: path.join(dir, f), bundle: root });
    }
  }
  return out;
};

const lastTs = (file) => {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = Array.isArray(doc.candles) ? doc.candles : [];
    if (!c.length) return 0;
    const t = Number(c[c.length - 1][0]);
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
};

const mergeIntoFile = (file, incoming, meta) => {
  let doc = { symbol: '', interval: '', candles: [] };
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* empty */ }
  const byT = new Map();
  for (const row of doc.candles || []) {
    const t = Number(row && row[0]);
    if (Number.isFinite(t)) byT.set(t, row);
  }
  const before = byT.size;
  for (const row of incoming || []) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = Number(row[0]);
    if (!Number.isFinite(t) || t <= 0) continue;
    byT.set(t, row);
  }
  const candles = [...byT.values()].sort((a, b) => Number(a[0]) - Number(b[0]));
  const next = {
    ...doc,
    candles,
    exportedAt: new Date().toISOString(),
    ...(meta || {}),
  };
  fs.writeFileSync(file, JSON.stringify(next));
  return { before, after: candles.length, added: Math.max(0, candles.length - before) };
};

const intervalMs = (iv) => {
  const s = String(iv || '').toLowerCase();
  if (s.endsWith('h')) return parseInt(s, 10) * 3600_000;
  if (s.endsWith('d')) return parseInt(s, 10) * 86400_000;
  if (s.endsWith('m')) return parseInt(s, 10) * 60_000;
  return 4 * 3600_000;
};

const buildTasks = () => {
  const files = [...listBundleFiles(CRYPTO), ...listBundleFiles(STOCKS)];
  const uniq = new Map();
  for (const row of files) {
    const key = `${row.interval}|${row.symbol}`;
    const ts = lastTs(row.file);
    const prev = uniq.get(key);
    if (!prev || ts > prev.lastMs) {
      uniq.set(key, { interval: row.interval, symbol: row.symbol, lastMs: ts, files: [row.file] });
    } else {
      prev.files.push(row.file);
    }
  }
  return [...uniq.values()].filter((t) =>
    HAMFIVE_SYMBOLS.has(String(t.symbol).toUpperCase())
    && t.lastMs + intervalMs(t.interval) < DATE_TO_MS
  );
};

const fetchOnVps = (tasks) => {
  const tmpLocal = path.join('/tmp', `btdd_candle_tasks_${Date.now()}.json`);
  fs.writeFileSync(tmpLocal, JSON.stringify({ dateTo: DATE_TO, dateToMs: DATE_TO_MS, tasks }, null, 2));
  const remoteTasks = '/tmp/btdd_candle_tasks.json';
  const remoteOut = '/tmp/btdd_candle_append';
  const cp = spawnSync('scp', ['-q', tmpLocal, `${VPS}:${remoteTasks}`], { encoding: 'utf8' });
  if (cp.status !== 0) throw new Error(cp.stderr || 'scp tasks failed');

  const nodeSrc = `
const fs = require('fs');
const path = require('path');
const database = require('${VPS_BACKEND}/dist/utils/database.js');
const exchange = require('${VPS_BACKEND}/dist/bot/exchange.js');
const payload = JSON.parse(fs.readFileSync('${remoteTasks}', 'utf8'));
const OUT = '${remoteOut}';
const KEYS = (process.env.APPEND_KEYS || 'Copy_Alex1,BTDD_D1').split(',').map((s) => s.trim()).filter(Boolean);
const intervalMs = (iv) => {
  const s = String(iv || '').toLowerCase();
  if (s.endsWith('h')) return parseInt(s, 10) * 3600_000;
  if (s.endsWith('d')) return parseInt(s, 10) * 86400_000;
  if (s.endsWith('m')) return parseInt(s, 10) * 60_000;
  return 4 * 3600_000;
};
(async () => {
  await database.initDB();
  fs.mkdirSync(OUT, { recursive: true });
  const summary = [];
  const tasks = payload.tasks.slice();
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const task = tasks[idx++];
      if (!task) break;
      const startMs = Number(task.lastMs || 0) + 1;
      const need = Math.min(20000, Math.max(50, Math.ceil((payload.dateToMs - startMs) / intervalMs(task.interval)) + 5));
      let best = [];
      let via = '';
      for (const key of KEYS) {
        try {
          await exchange.ensureExchangeClientInitialized(key);
          const candles = await exchange.getMarketData(key, task.symbol, task.interval, need, {
            startMs,
            endMs: payload.dateToMs,
          });
          const list = Array.isArray(candles) ? candles : [];
          if (list.length > best.length) { best = list; via = key; }
          if (list.length >= Math.max(10, need * 0.5)) break;
        } catch (e) { /* try next key */ }
      }
      const dir = path.join(OUT, task.interval);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, task.symbol + '.json'), JSON.stringify({
        symbol: task.symbol, interval: task.interval, via, candles: best,
      }));
      summary.push({ interval: task.interval, symbol: task.symbol, n: best.length, via });
      console.log((best.length ? 'OK' : 'FAIL') + ' ' + task.interval + ' ' + task.symbol + ' n=' + best.length + ' via=' + via);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`;
  const remoteJs = '/tmp/btdd_append_candles.js';
  const localJs = '/tmp/btdd_append_candles.js';
  fs.writeFileSync(localJs, nodeSrc);
  const cp2 = spawnSync('scp', ['-q', localJs, `${VPS}:${remoteJs}`], { encoding: 'utf8' });
  if (cp2.status !== 0) throw new Error(cp2.stderr || 'scp js failed');
  console.log(`[append] fetching ${tasks.length} series on VPS through ${DATE_TO}...`);
  const run = spawnSync('ssh', [VPS, `cd ${VPS_BACKEND} && unset HYBRID_CANDLE_DIR && HYBRID_QUIET=1 LOG_CONSOLE_LEVEL=error node ${remoteJs}`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  process.stdout.write(run.stdout || '');
  if (run.status !== 0) {
    throw new Error(run.stderr || run.stdout || 'vps fetch failed');
  }
  const localOut = path.join('/tmp', 'btdd_candle_append');
  spawnSync('rm', ['-rf', localOut]);
  const pull = spawnSync('scp', ['-q', '-r', `${VPS}:${remoteOut}`, localOut], { encoding: 'utf8' });
  if (pull.status !== 0) throw new Error(pull.stderr || 'scp pull failed');
  return localOut;
};

const refreshMerged = () => {
  fs.mkdirSync(MERGED, { recursive: true });
  for (const src of [CRYPTO, STOCKS]) {
    if (!fs.existsSync(src)) continue;
    for (const iv of fs.readdirSync(src)) {
      const d = path.join(src, iv);
      if (!fs.statSync(d).isDirectory()) continue;
      const outIv = path.join(MERGED, iv);
      fs.mkdirSync(outIv, { recursive: true });
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
        const dst = path.join(outIv, f);
        try { fs.unlinkSync(dst); } catch { /* missing */ }
        try { fs.symlinkSync(path.join(d, f), dst); }
        catch { fs.copyFileSync(path.join(d, f), dst); }
      }
    }
  }
};

(async () => {
  const tasks = buildTasks();
  console.log(`[append] dateTo=${DATE_TO} stale_series=${tasks.length}`);
  if (!tasks.length) {
    refreshMerged();
    console.log('[append] nothing to fetch');
    process.exit(0);
  }
  if (!VIA_VPS) {
    console.error('Pass --via-vps (local Binance is geo-blocked; VPS has WEEX/Bybit keys).');
    process.exit(2);
  }
  const incomingDir = fetchOnVps(tasks);
  const byKey = new Map(tasks.map((t) => [`${t.interval}|${t.symbol}`, t]));
  let added = 0;
  let ok = 0;
  let fail = 0;
  for (const iv of fs.readdirSync(incomingDir)) {
    const dir = path.join(incomingDir, iv);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const sym = String(doc.symbol || f.replace(/\.json$/i, '')).toUpperCase();
      const task = byKey.get(`${doc.interval || iv}|${sym}`);
      const candles = doc.candles || [];
      if (!task) continue;
      if (!candles.length) { fail += 1; continue; }
      ok += 1;
      for (const file of task.files) {
        const r = mergeIntoFile(file, candles, { appendedTo: DATE_TO, via: doc.via });
        added += r.added;
      }
    }
  }
  refreshMerged();
  console.log(`[append] merged ok=${ok} fail=${fail} added_rows~=${added} merged=${MERGED}`);
  process.exit(fail && !ok ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
