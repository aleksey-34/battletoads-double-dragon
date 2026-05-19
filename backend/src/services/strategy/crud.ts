// Strategy CRUD Operations — extracted from bot/strategy.ts
// Handles create, update, archive, delete for strategies.

import db from '../../db';
import { safeNumber } from '../../utils/safeNumber';

// ── Types ────────────────────────────────────────────────────────────────────

export interface StrategyRow {
  id: number;
  name: string;
  mode: string;
  market: string;
  lot_long_percent: number;
  lot_short_percent: number;
  max_deposit: number;
  fixed_lot: number;
  reinvest_percent: number;
  sl_percent: number;
  tp_percent: number;
  partial_tp_pct: number;
  max_open_positions: number;
  enabled: number;
  archived: number;
  created_at: string;
  updated_at: string;
  [key: string]: any;
}

// ── Create Strategy ──────────────────────────────────────────────────────────

export async function createStrategy(data: Partial<StrategyRow>): Promise<StrategyRow> {
  const now = new Date().toISOString();
  const result = await db.run(
    `INSERT INTO strategies (
      name, mode, market,
      lot_long_percent, lot_short_percent, max_deposit,
      fixed_lot, reinvest_percent,
      sl_percent, tp_percent, partial_tp_pct,
      max_open_positions, enabled, archived,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    [
      data.name || 'Untitled',
      data.mode || 'default',
      data.market || '',
      data.lot_long_percent ?? 1,
      data.lot_short_percent ?? 1,
      data.max_deposit ?? 0,
      data.fixed_lot ?? 0,
      data.reinvest_percent ?? 0,
      data.sl_percent ?? 0,
      data.tp_percent ?? 0,
      data.partial_tp_pct ?? 0,
      data.max_open_positions ?? 1,
      now,
      now,
    ],
  );

  const row = await db.get('SELECT * FROM strategies WHERE id = ?', [result.lastID]);
  return row as StrategyRow;
}

// ── Update Strategy ──────────────────────────────────────────────────────────

export async function updateStrategy(id: number, data: Partial<StrategyRow>): Promise<StrategyRow | null> {
  const existing = await db.get('SELECT * FROM strategies WHERE id = ?', [id]);
  if (!existing) return null;

  const now = new Date().toISOString();
  const merged = { ...existing, ...data, updated_at: now };

  await db.run(
    `UPDATE strategies SET
      name = ?, mode = ?, market = ?,
      lot_long_percent = ?, lot_short_percent = ?, max_deposit = ?,
      fixed_lot = ?, reinvest_percent = ?,
      sl_percent = ?, tp_percent = ?, partial_tp_pct = ?,
      max_open_positions = ?, enabled = ?, archived = ?,
      updated_at = ?
    WHERE id = ?`,
    [
      merged.name,
      merged.mode,
      merged.market,
      merged.lot_long_percent,
      merged.lot_short_percent,
      merged.max_deposit,
      merged.fixed_lot,
      merged.reinvest_percent,
      merged.sl_percent,
      merged.tp_percent,
      merged.partial_tp_pct,
      merged.max_open_positions,
      merged.enabled,
      merged.archived,
      merged.updated_at,
      id,
    ],
  );

  return (await db.get('SELECT * FROM strategies WHERE id = ?', [id])) as StrategyRow;
}

// ── Archive Strategy ─────────────────────────────────────────────────────────

export async function archiveStrategy(id: number): Promise<void> {
  await db.run('UPDATE strategies SET archived = 1, updated_at = ? WHERE id = ?', [
    new Date().toISOString(),
    id,
  ]);
}

// ── Delete Strategy ──────────────────────────────────────────────────────────

export async function deleteStrategy(id: number): Promise<void> {
  await db.run('DELETE FROM strategies WHERE id = ?', [id]);
}
"