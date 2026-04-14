#!/usr/bin/env node
/**
 * Cloud Resweep v2 — dual-exchange (MEXC + WEEX), more symbols.
 * Fetches 7d 5m data, evaluates synthetic pairs, creates strategies.
 */
'use strict';

const ccxt = require('ccxt');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'backend', 'database.db');
const LOG_PATH = path.join(__dirname, '..', 'backend', 'logs', 'cloud_resweep.log');
const db = new Database(DB_PATH);

const CLOUD_SYSTEM_ID = 72;
const CLOUD_API_KEY_ID = 2; // BTDD_D1

// Symbols split across exchanges for speed
const MEXC_SYMBOLS = ['SUI','LINK','OP','TIA','SOL','AVAX','INJ','WIF','ARB','DOGE','SEI','NEAR'];
const WEEX_SYMBOLS = ['CRV','UNI','ONDO','GRT','PEPE','FET','RENDER','VET','AAVE','APT'];
const ALL_SYMBOLS = [...new Set([...MEXC_SYMBOLS, ...WEEX_SYMBOLS])];

const INTERVAL = '5m';
const FETCH_DAYS = 7;
const FETCH_BARS = Math.ceil(FETCH_DAYS * 24 * 60 / 5);
const COMMISSION = 0.0006;
const SLIPPAGE = 0.0003;
const MIN_CORRELATION = 0.4;
const MIN_PROFIT_FACTOR = 1.3;
const MIN_TRADES = 5;

const PARAM_GRID = [];
for (const w of [60, 90, 120]) {
  for (const ze of [2.0, 2.5]) {
    for (const zx of [0.3, 0.5]) {
      for (const zs of [3.5, 4.0]) {
        PARAM_GRID.push({ window: w, zEntry: ze, zExit: zx, zStop: zs });
      }
    }
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// ===== DATA FETCHING =====
async function fetchFromExchange(exchangeId, symbols) {
  const exchange = new ccxt[exchangeId]({ enableRateLimit: true });
  const data = {};
  const since = Date.now() - FETCH_DAYS * 86400000;

  for (const sym of symbols) {
    const pair = `${sym}/USDT:USDT`;
    try {
      let allBars = [];
      let fetchSince = since;
      while (allBars.length < FETCH_BARS) {
        const batch = await exchange.fetchOHLCV(pair, INTERVAL, fetchSince, 1000);
        if (!batch || batch.length === 0) break;
        allBars = allBars.concat(batch);
        fetchSince = batch[batch.length - 1][0] + 1;
        if (batch.length < 1000) break;
      }
      if (allBars.length >= 100) {
        data[sym] = allBars.map(b => b[4]); // close prices
        log(`  ${sym} (${exchangeId}): ${allBars.length} bars`);
      } else {
        log(`  ${sym} (${exchangeId}): skipped (${allBars.length} bars)`);
      }
    } catch (e) {
      log(`  ${sym} (${exchangeId}): ERROR ${e.message.slice(0, 80)}`);
    }
  }
  return data;
}

// WEEX direct REST API (no ccxt support) — same endpoint as weexClient.ts
const WEEX_API_BASE = 'https://api-contract.weex.com';

async function fetchFromWeex(symbols) {
  const data = {};
  for (const sym of symbols) {
    const weexSymbol = `cmt_${sym.toLowerCase()}usdt`;
    try {
      const url = `${WEEX_API_BASE}/capi/v2/market/candles?symbol=${weexSymbol}&granularity=5m&limit=1000`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      // Response is array of arrays directly: [[ts, o, h, l, c, vol, ...], ...]
      const rows = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
      const bars = rows
        .filter(item => Array.isArray(item) && item.length >= 5)
        .map(item => ({ ts: Number(item[0]), close: Number(item[4]) }))
        .filter(item => Number.isFinite(item.ts) && Number.isFinite(item.close))
        .sort((a, b) => a.ts - b.ts);

      if (bars.length >= 100) {
        data[sym] = bars.map(b => b.close);
        log(`  ${sym} (weex): ${bars.length} bars`);
      } else {
        log(`  ${sym} (weex): skipped (${bars.length} bars)`);
      }
      // Simple rate limit
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      log(`  ${sym} (weex): ERROR ${e.message.slice(0, 80)}`);
    }
  }
  return data;
}

async function fetchData() {
  log('  Fetching from MEXC...');
  const mexcData = await fetchFromExchange('mexc', MEXC_SYMBOLS);
  log('  Fetching from WEEX...');
  const weexData = await fetchFromWeex(WEEX_SYMBOLS);
  
  // Merge — MEXC takes priority for overlap
  const merged = { ...weexData, ...mexcData };
  return merged;
}

// ===== PAIR EVALUATION =====
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 50) return 0;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] - mx, yi = y[i] - my;
    num += xi * yi;
    dx += xi * xi;
    dy += yi * yi;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}

function scoreParams(ratios, p) {
  const n = ratios.length;
  if (n < p.window + 10) return null;
  
  let trades = 0, wins = 0, grossProfit = 0, grossLoss = 0;
  let inPosition = false, entryRatio = 0, side = 0;
  
  for (let i = p.window; i < n; i++) {
    const slice = ratios.slice(i - p.window, i);
    const mean = slice.reduce((s, v) => s + v, 0) / p.window;
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / p.window);
    if (std < 1e-10) continue;
    const z = (ratios[i] - mean) / std;

    if (!inPosition) {
      if (z >= p.zEntry) { inPosition = true; entryRatio = ratios[i]; side = -1; }
      else if (z <= -p.zEntry) { inPosition = true; entryRatio = ratios[i]; side = 1; }
    } else {
      const pnl = side * (ratios[i] - entryRatio) / entryRatio - COMMISSION - SLIPPAGE;
      if ((side === 1 && z >= -p.zExit) || (side === -1 && z <= p.zExit) || Math.abs(z) >= p.zStop) {
        trades++;
        if (pnl > 0) { wins++; grossProfit += pnl; } else { grossLoss += Math.abs(pnl); }
        inPosition = false;
      }
    }
  }

  if (trades < MIN_TRADES) return null;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 10 : 0;
  const wr = trades > 0 ? wins / trades : 0;
  const tpd = trades / FETCH_DAYS;
  return { pf, wr, trades, tpd, ...p };
}

function evaluatePairs(data) {
  const syms = Object.keys(data);
  const results = [];

  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const base = syms[i], quote = syms[j];
      const baseClose = data[base], quoteClose = data[quote];
      const corr = correlation(baseClose, quoteClose);
      if (Math.abs(corr) < MIN_CORRELATION) continue;

      const n = Math.min(baseClose.length, quoteClose.length);
      const ratios = baseClose.slice(-n).map((b, idx) => quoteClose.slice(-n)[idx] > 0 ? b / quoteClose.slice(-n)[idx] : 0).filter(r => r > 0);
      
      let best = null;
      for (const p of PARAM_GRID) {
        const result = scoreParams(ratios, p);
        if (!result) continue;
        if (result.pf < MIN_PROFIT_FACTOR) continue;
        if (!best || result.pf > best.pf) best = result;
      }

      if (best) {
        results.push({
          base: `${base}USDT`,
          quote: `${quote}USDT`,
          baseSym: base,
          quoteSym: quote,
          corr: Math.abs(corr),
          ...best,
        });
      }
    }
  }

  results.sort((a, b) => b.pf - a.pf);
  return results.slice(0, 20);
}

// ===== DB UPDATE — creates strategies in standard path =====
function updateCloud(topPairs) {
  const top8 = topPairs.slice(0, 8);
  
  log(`\nTop 8 pairs for cloud:`);
  top8.forEach((p, i) => log(`  ${i + 1}. ${p.baseSym}/${p.quoteSym} pf=${p.pf.toFixed(2)} wr=${(p.wr*100).toFixed(0)}% trades=${p.trades} w=${p.window} z=${p.zEntry}/${p.zExit}/${p.zStop}`));

  // Step 1: Archive old members
  const oldMembers = db.prepare(`
    SELECT tsm.strategy_id, s.name, s.state
    FROM trading_system_members tsm
    JOIN strategies s ON s.id = tsm.strategy_id
    WHERE tsm.system_id = ?
  `).all(CLOUD_SYSTEM_ID);

  for (const m of oldMembers) {
    db.prepare(`UPDATE strategies SET is_active=0, is_archived=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(m.strategy_id);
    log(`  Archived old strategy ${m.strategy_id} (${m.name})`);
  }
  db.prepare(`DELETE FROM trading_system_members WHERE system_id = ?`).run(CLOUD_SYSTEM_ID);
  log(`  Cleared ${oldMembers.length} old members`);

  // Step 2: Create new strategies
  const insertStmt = db.prepare(`
    INSERT INTO strategies (
      name, api_key_id, strategy_type, is_active, auto_update,
      base_symbol, quote_symbol, interval, market_mode,
      price_channel_length, zscore_entry, zscore_exit, zscore_stop,
      detection_source, take_profit_percent,
      lot_long_percent, lot_short_percent, max_deposit,
      margin_type, leverage, state, origin, is_runtime, display_on_chart
    ) VALUES (
      ?, ?, 'ZScore_StatArb', 1, 1,
      ?, ?, '5m', 'synthetic',
      ?, ?, ?, ?,
      'close', 7.5,
      100.0, 100.0, 1000.0,
      'cross', 1.0, 'flat', 'cloud_resweep', 0, 1
    )
  `);

  const insertMember = db.prepare(`
    INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled)
    VALUES (?, ?, 1.0, ?, 1)
  `);

  const newStrategyIds = [];
  for (let i = 0; i < top8.length; i++) {
    const p = top8[i];
    const name = `${p.baseSym}/${p.quoteSym} 5m cloud-op2`;
    
    const result = insertStmt.run(name, CLOUD_API_KEY_ID, p.base, p.quote, p.window, p.zEntry, p.zExit, p.zStop);
    const stratId = result.lastInsertRowid;
    newStrategyIds.push(Number(stratId));
    log(`  CREATED strategy ${stratId}: ${p.baseSym}/${p.quoteSym} (pf=${p.pf.toFixed(2)} w=${p.window} z=${p.zEntry}/${p.zExit}/${p.zStop})`);
  }

  // Step 3: Assign as members
  for (let i = 0; i < newStrategyIds.length; i++) {
    const role = i < 3 ? 'core' : 'satellite';
    insertMember.run(CLOUD_SYSTEM_ID, newStrategyIds[i], role);
  }
  log(`  Assigned ${newStrategyIds.length} strategies as members`);

  // Step 4: Ensure system is active
  db.prepare(`UPDATE trading_systems SET is_active=1, auto_sync_members=1, max_members=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(Math.max(8, newStrategyIds.length), CLOUD_SYSTEM_ID);
  log(`  System cloud-op2 updated: ${newStrategyIds.length} members, active=1`);
}

// ===== MAIN =====
async function main() {
  log('========== AUTO CLOUD RESWEEP v2 START ==========');
  log(`Symbols: MEXC=${MEXC_SYMBOLS.length}, WEEX=${WEEX_SYMBOLS.length}`);
  
  log('\n1. Fetching data (MEXC + WEEX parallel)...');
  const data = await fetchData();
  const symCount = Object.keys(data).length;
  log(`Fetched ${symCount} symbols total`);
  
  if (symCount < 5) {
    log('ERROR: Too few symbols fetched, aborting');
    process.exit(1);
  }

  log('\n2. Evaluating pairs...');
  const topPairs = evaluatePairs(data);
  log(`Found ${topPairs.length} viable pairs`);

  if (topPairs.length < 4) {
    log('WARNING: Very few viable pairs, skipping update');
    process.exit(0);
  }

  log('\n3. Creating strategies and updating cloud...');
  updateCloud(topPairs);

  log('\n========== AUTO CLOUD RESWEEP v2 COMPLETE ==========');
  db.close();
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  console.error(e);
  process.exit(1);
});
