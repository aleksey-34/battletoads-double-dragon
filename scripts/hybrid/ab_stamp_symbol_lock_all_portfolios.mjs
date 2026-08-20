#!/usr/bin/env node
/**
 * A/B stamp all hamfive portfolios: pair-lock vs symbol-lock (full DATE_FROM..DATE_TO),
 * then apply AFTER (symbol-lock) snaps to algofund_portfolios for the storefront.
 *
 *   SKIP_CANDLE_APPEND=1 DATE_FROM=2024-03-17 DATE_TO=2026-08-19 \
 *     node scripts/hybrid/ab_stamp_symbol_lock_all_portfolios.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const backend = path.join(root, 'backend');
const require = createRequire(import.meta.url);

process.chdir(backend);

const { initDB } = require(path.join(backend, 'dist/utils/database.js'));
const {
  stampStorefrontPortfolios,
  applyStorefrontSnapshots,
  getStorefrontRollPaths,
} = require(path.join(backend, 'dist/research/nightlyStorefrontRoll.js'));
const { ensureExchangeClientInitialized } = require(path.join(backend, 'dist/bot/exchange.js'));

const dateTo = process.env.DATE_TO || '2026-08-19';
const dateFrom = process.env.DATE_FROM || '2024-03-17';
const liveFrom = process.env.LIVE_FROM || '2026-07-30';
const apiKeyName = process.env.STOREFRONT_BT_KEY || 'BTDD_D1';
const outJson = process.env.OUT_JSON
  || path.join(root, 'tmp', 'ab_stamp_symbol_lock_all_portfolios.json');

const packCards = (cards) => {
  const byId = {};
  for (const c of cards || []) byId[String(c.id)] = c;
  return byId;
};

try {
  await initDB();
  await ensureExchangeClientInitialized(apiKeyName);
  const paths = getStorefrontRollPaths();
  const snapsBefore = path.join(path.dirname(paths.snaps), 'snapshots_hamfive_aug2026.PAIR_LOCK.json');
  const snapsAfter = paths.snaps;

  const common = {
    dateTo,
    liveFrom,
    dateFrom,
    recipePath: paths.recipe,
    fearPath: paths.fear,
    mergedBundle: paths.mergedBundle,
    apiKeyName,
  };

  console.error('BEFORE pair-lock stamp', dateFrom, '..', dateTo);
  process.env.PAIR_LOCK_SCOPE = 'pair';
  const beforeStamp = await stampStorefrontPortfolios({ ...common, snapsPath: snapsBefore });

  console.error('AFTER symbol-lock stamp', dateFrom, '..', dateTo);
  delete process.env.PAIR_LOCK_SCOPE;
  const afterStamp = await stampStorefrontPortfolios({ ...common, snapsPath: snapsAfter });

  console.error('apply AFTER snaps to DB', snapsAfter);
  const applied = await applyStorefrontSnapshots(snapsAfter, paths.recipe);

  const b = packCards(beforeStamp.cards);
  const a = packCards(afterStamp.cards);
  const ids = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const rows = ids.map((id) => {
    const bb = b[id] || {};
    const aa = a[id] || {};
    return {
      id,
      before: { ret: bb.ret, dd: bb.dd, liveWin: bb.liveWin },
      after: { ret: aa.ret, dd: aa.dd, liveWin: aa.liveWin },
      delta: {
        ret_pp: Number.isFinite(aa.ret) && Number.isFinite(bb.ret) ? +(aa.ret - bb.ret).toFixed(2) : null,
        dd_pp: Number.isFinite(aa.dd) && Number.isFinite(bb.dd) ? +(aa.dd - bb.dd).toFixed(2) : null,
      },
    };
  });

  const out = {
    window: `${dateFrom}..${dateTo}`,
    liveFrom,
    stampedBefore: beforeStamp.stamped,
    stampedAfter: afterStamp.stamped,
    portfoliosUpdated: applied,
    snapsBefore,
    snapsAfter,
    rows,
  };
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(e);
  process.exit(1);
}
