#!/usr/bin/env node
/**
 * Auto Cloud Resweep — periodic re-evaluation of the cloud pair composition.
 * 
 * Runs weekly via cron. Steps:
 *   1. Fetch 14d 5m MEXC data for universe of symbols
 *   2. Score all synthetic pairs (correlation + zscore backtest)
 *   3. Select top-8 pairs with best profit factor
 *   4. Compare with current cloud — identify pairs to replace
 *   5. Replace only FLAT strategies (never touch open positions)
 *   6. Log all changes
 * 
 * Usage: node /opt/battletoads-double-dragon/scripts/auto_cloud_resweep.js
 * Cron:  0 3 * * 0  (every Sunday 3:00 AM UTC)
 */
'use strict';

const ccxt = require('ccxt');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'backend', 'database.db');
const LOG_PATH = path.join(__dirname, '..', 'backend', 'logs', 'cloud_resweep.log');

function sqliteExec(sql) {
  execSync(`sqlite3 "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function sqliteQuery(sql) {
  try {
    const out = execSync(`sqlite3 -json "${DB_PATH}" "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
  } catch { return []; }
}

// ===== CONFIG =====
const SYMBOLS = [
  'SUI','LINK','SEI','OP','TIA','CRV','SOL','AVAX','DOGE',
  'UNI','ONDO','ARB','NEAR','INJ','GRT','PEPE','WIF','FET','RENDER','VET'
];
const INTERVAL = '5m';
const INTERVAL_MS = 5 * 60 * 1000;
const FETCH_DAYS = 14;
const FETCH_BARS = Math.ceil(FETCH_DAYS * 24 * 60 / 5);
const COMMISSION = 0.0006;
const SLIPPAGE = 0.0003;
const MIN_CORRELATION = 0.4;
const MIN_PROFIT_FACTOR = 1.5;
const MIN_TRADES = 10;

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

// Cloud systems to update (system_id -> api_key_id)
const CLOUD_SYSTEMS = [
  { systemId: 67, apiKeyId: 13, name: 'CloudMEXC_OP2' },
  { systemId: 68, apiKeyId: 17, name: 'CloudWEEX_OP2' },
  { systemId: 71, apiKeyId: 2,  name: 'CloudBybit_OP2' },
];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// ===== DATA FETCHING =====
async function fetchData() {
  const exchange = new ccxt.mexc({ enableRateLimit: true });
  const data = {};
  const since = Date.now() - FETCH_DAYS * 86400000;

  for (const sym of SYMBOLS) {
    const pair = `${sym}/USDT:USDT`;
    try {
      let allBars = [];
      let fetchSince = since;
      while (allBars.length < FETCH_BARS) {
        const batch = await exchange.fetchOHLCV(pair, INTERVAL, fetchSince, 1000);
        if (!batch || batch.length === 0) break;
        allBars = allBars.concat(batch);
        fetchSince = batch[batch.length - 1][0] + INTERVAL_MS;
        if (batch.length < 1000) break;
      }
      if (allBars.length >= 200) {
        data[sym] = allBars.map(b => ({ timeMs: b[0], close: b[4] }));
        log(`  ${sym}: ${data[sym].length} bars`);
      }
    } catch (e) {
      log(`  ${sym}: ERROR ${e.message}`);
    }
  }
  return data;
}

// ===== PAIR SCORING =====
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 100) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    sx += a[i]; sy += b[i]; sxy += a[i] * b[i];
    sx2 += a[i] * a[i]; sy2 += b[i] * b[i];
  }
  const denom = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function scoreParams(ratios, params) {
  const { window, zEntry, zExit, zStop } = params;
  if (ratios.length < window + 10) return null;

  let trades = 0, wins = 0, totalPnl = 0, grossProfit = 0, grossLoss = 0;
  let position = null; // { side, entryRatio, entryIdx }

  for (let i = window; i < ratios.length; i++) {
    // Moving average + stddev
    let sum = 0, sum2 = 0;
    for (let j = i - window; j < i; j++) {
      sum += ratios[j];
      sum2 += ratios[j] * ratios[j];
    }
    const mean = sum / window;
    const std = Math.sqrt(sum2 / window - mean * mean);
    if (std < 1e-10) continue;
    const z = (ratios[i] - mean) / std;

    if (!position) {
      if (z >= zEntry) position = { side: 'short', entryRatio: ratios[i], entryIdx: i };
      else if (z <= -zEntry) position = { side: 'long', entryRatio: ratios[i], entryIdx: i };
    } else {
      const isExit = (position.side === 'long' && z >= -zExit) || (position.side === 'short' && z <= zExit);
      const isStop = (position.side === 'long' && z <= -zStop) || (position.side === 'short' && z >= zStop);

      if (isExit || isStop) {
        const rawPnl = position.side === 'long'
          ? (ratios[i] - position.entryRatio) / position.entryRatio
          : (position.entryRatio - ratios[i]) / position.entryRatio;
        const netPnl = rawPnl - (COMMISSION + SLIPPAGE) * 2;
        
        trades++;
        totalPnl += netPnl;
        if (netPnl > 0) { wins++; grossProfit += netPnl; }
        else { grossLoss += Math.abs(netPnl); }
        position = null;
      }
    }
  }

  if (trades < MIN_TRADES) return null;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const wr = wins / trades;
  const tpd = trades / FETCH_DAYS;

  return { pf, wr, trades, tpd, totalPnl, ...params };
}

function evaluatePairs(data) {
  const symbols = Object.keys(data);
  const results = [];

  for (let i = 0; i < symbols.length; i++) {
    for (let j = i + 1; j < symbols.length; j++) {
      const base = symbols[i], quote = symbols[j];
      const baseData = data[base], quoteData = data[quote];
      
      // Align by timestamp
      const n = Math.min(baseData.length, quoteData.length);
      const baseClose = baseData.slice(-n).map(d => d.close);
      const quoteClose = quoteData.slice(-n).map(d => d.close);
      
      const corr = correlation(baseClose, quoteClose);
      if (Math.abs(corr) < MIN_CORRELATION) continue;

      // Build ratio
      const ratios = baseClose.map((b, idx) => quoteClose[idx] > 0 ? b / quoteClose[idx] : 0).filter(r => r > 0);
      
      // Find best params
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
          corr: Math.abs(corr),
          ...best,
        });
      }
    }
  }

  results.sort((a, b) => b.pf - a.pf);
  return results.slice(0, 20); // top 20 candidates
}

// ===== DB UPDATE =====
function updateCloud(topPairs) {
  const top8 = topPairs.slice(0, 8);
  
  log(`\nTop 8 pairs for cloud:`);
  top8.forEach((p, i) => log(`  ${i + 1}. ${p.base}/${p.quote} pf=${p.pf.toFixed(2)} wr=${(p.wr*100).toFixed(0)}% tpd=${p.tpd.toFixed(1)} w=${p.window} z=${p.zEntry}/${p.zExit}/${p.zStop}`));

  for (const sys of CLOUD_SYSTEMS) {
    log(`\n--- Updating system ${sys.name} (id=${sys.systemId}) ---`);

    // Get current strategies
    const current = sqliteQuery(`
      SELECT s.id, s.base_symbol, s.quote_symbol, s.state, s.price_channel_length, s.zscore_entry, s.zscore_exit, s.zscore_stop
      FROM strategies s
      JOIN trading_system_members tsm ON tsm.strategy_id = s.id
      WHERE tsm.system_id = ${sys.systemId} AND tsm.is_enabled = 1 AND s.is_active = 1
      ORDER BY s.id
    `);

    const currentPairs = current.map(c => `${c.base_symbol}/${c.quote_symbol}`);
    const newPairs = top8.map(p => `${p.base}/${p.quote}`);

    let replaced = 0;
    const availableSlots = [];

    for (const c of current) {
      const pairKey = `${c.base_symbol}/${c.quote_symbol}`;
      if (newPairs.includes(pairKey)) {
        const newP = top8.find(p => `${p.base}/${p.quote}` === pairKey);
        if (newP && (c.price_channel_length !== newP.window || c.zscore_entry !== newP.zEntry)) {
          if (c.state === 'flat') {
            sqliteExec(`UPDATE strategies SET price_channel_length=${newP.window}, zscore_entry=${newP.zEntry}, zscore_exit=${newP.zExit}, zscore_stop=${newP.zStop}, updated_at=CURRENT_TIMESTAMP WHERE id=${c.id}`);
            log(`  Updated params for ${pairKey} (strategy ${c.id})`);
          } else {
            log(`  ${pairKey} (strategy ${c.id}) has open position, params update deferred`);
          }
        } else {
          log(`  ${pairKey} (strategy ${c.id}) unchanged`);
        }
      } else {
        if (c.state === 'flat') {
          availableSlots.push(c);
          log(`  ${pairKey} (strategy ${c.id}) marked for replacement (flat)`);
        } else {
          log(`  ${pairKey} (strategy ${c.id}) dropped from top-8 but has OPEN position — keeping until flat`);
        }
      }
    }

    const pairsToAdd = top8.filter(p => !currentPairs.includes(`${p.base}/${p.quote}`));
    
    for (let k = 0; k < Math.min(pairsToAdd.length, availableSlots.length); k++) {
      const slot = availableSlots[k];
      const newP = pairsToAdd[k];
      const name = `${newP.base.replace('USDT','')}/${newP.quote.replace('USDT','')} 5m cloud`;
      
      sqliteExec(`UPDATE strategies SET name='${name}', base_symbol='${newP.base}', quote_symbol='${newP.quote}', price_channel_length=${newP.window}, zscore_entry=${newP.zEntry}, zscore_exit=${newP.zExit}, zscore_stop=${newP.zStop}, state='flat', entry_ratio=NULL, tp_anchor_ratio=NULL, last_action='resweep_replaced', last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=${slot.id}`);
      replaced++;
      log(`  REPLACED strategy ${slot.id}: ${slot.base_symbol}/${slot.quote_symbol} -> ${newP.base}/${newP.quote} (w=${newP.window} z=${newP.zEntry}/${newP.zExit}/${newP.zStop})`);
    }

    log(`  System ${sys.name}: ${replaced} replacements made`);
  }
}

// ===== MAIN =====
async function main() {
  log('========== AUTO CLOUD RESWEEP START ==========');
  
  log('\n1. Fetching 14d MEXC data...');
  const data = await fetchData();
  const symCount = Object.keys(data).length;
  log(`Fetched ${symCount} symbols`);
  
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

  log('\n3. Updating cloud strategies...');
  updateCloud(topPairs);

  log('\n========== AUTO CLOUD RESWEEP COMPLETE ==========');
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(1);
});
