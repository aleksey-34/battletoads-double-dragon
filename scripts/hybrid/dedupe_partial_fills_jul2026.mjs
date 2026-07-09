#!/usr/bin/env node
/**
 * One-off: merge duplicate exchange_fill entries sharing source_order_id (partial fills).
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(backendRoot, 'dist/utils/database.js'));

await database.initDB();
const { db } = database;

const APPLY = process.env.APPLY === '1';
const groups = await db.all(`
  SELECT strategy_id, source_order_id, trade_type, COUNT(*) AS n
  FROM live_trade_events
  WHERE COALESCE(event_origin, 'exchange_fill') = 'exchange_fill'
    AND COALESCE(source_order_id, '') != ''
  GROUP BY strategy_id, source_order_id, trade_type
  HAVING n > 1
`);

let merged = 0;
for (const g of groups || []) {
  const rows = await db.all(
    `SELECT id, position_size, actual_price, actual_fee, actual_time
     FROM live_trade_events
     WHERE strategy_id = ? AND source_order_id = ? AND trade_type = ?
     ORDER BY id ASC`,
    [g.strategy_id, g.source_order_id, g.trade_type],
  );
  if (!rows || rows.length < 2) continue;
  const keep = rows[0];
  let qty = Number(keep.position_size) || 0;
  let fee = Number(keep.actual_fee) || 0;
  let wPrice = Number(keep.actual_price) || 0;
  for (const r of rows.slice(1)) {
    const addQ = Number(r.position_size) || 0;
    const p = Number(r.actual_price) || wPrice;
    const newQty = qty + addQ;
    wPrice = newQty > 0 ? (qty * wPrice + addQ * p) / newQty : p;
    qty = newQty;
    fee += Number(r.actual_fee) || 0;
  }
  if (APPLY) {
    await db.run(
      `UPDATE live_trade_events SET position_size=?, actual_price=?, entry_price=?, actual_fee=? WHERE id=?`,
      [qty, wPrice, wPrice, fee, keep.id],
    );
    const dropIds = rows.slice(1).map((r) => r.id);
    await db.run(`DELETE FROM live_trade_events WHERE id IN (${dropIds.map(() => '?').join(',')})`, dropIds);
  }
  merged += rows.length - 1;
}

console.log(JSON.stringify({ groups: (groups || []).length, mergedRows: merged, apply: APPLY }, null, 2));
