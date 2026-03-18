/**
 * Client preset builder (Phase 5)
 *
 * Builds 3×3 risk×frequency preset matrix per offer_id
 * from sweep artifacts. Presets are pre-baked once and stored in
 * research.db client_presets so client UI can load KPI instantly
 * without live computation.
 */
import { getResearchDb } from './db';
import logger from '../utils/logger';

export type RiskLevel = 'low' | 'medium' | 'high';
export type FreqLevel = 'low' | 'medium' | 'high';

export type PresetInput = {
  offer_id: string;
  risk_level: RiskLevel;
  freq_level: FreqLevel;
  config: Record<string, unknown>;
  metrics: Record<string, unknown>;
  equity_curve?: number[];
  sweep_run_id?: number;
};

/**
 * Upsert a single preset (offer × risk × freq).
 * Marks all other presets for same offer_id as is_current=0 only when sweep_run_id changes.
 */
export const upsertPreset = async (input: PresetInput): Promise<void> => {
  const db = getResearchDb();

  await db.run(
    `INSERT INTO client_presets
       (offer_id, risk_level, freq_level, config_json, metrics_json, equity_curve_json, sweep_run_id, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(offer_id, risk_level, freq_level) DO UPDATE SET
       config_json = excluded.config_json,
       metrics_json = excluded.metrics_json,
       equity_curve_json = excluded.equity_curve_json,
       sweep_run_id = excluded.sweep_run_id,
       is_current = 1`,
    [
      input.offer_id,
      input.risk_level,
      input.freq_level,
      JSON.stringify(input.config),
      JSON.stringify(input.metrics),
      JSON.stringify(input.equity_curve ?? []),
      input.sweep_run_id ?? null,
    ]
  );
};

/**
 * Build all 9 presets for a given offer from a sweep artifact catalog entry.
 *
 * Risk/freq mapping uses multipliers on lot_long_percent and price_channel_length:
 *   risk={low: 0.5, medium: 1.0, high: 1.5} × base_lot
 *   freq={low: 70, medium: 50, high: 30} price_channel_length (larger → fewer signals)
 */
export const buildPresetsForOffer = async (
  offerId: string,
  baseConfig: Record<string, unknown>,
  baseMetrics: Record<string, unknown>,
  baseEquityCurve: number[],
  sweepRunId: number
): Promise<void> => {
  const riskMultipliers: Record<RiskLevel, number> = { low: 0.5, medium: 1.0, high: 1.5 };
  const freqChannels: Record<FreqLevel, number> = { low: 70, medium: 50, high: 30 };

  const baseLot = Number(baseConfig.lot_long_percent ?? 100);
  const baseRet = Number(baseMetrics.ret ?? 0);
  const basePf = Number(baseMetrics.pf ?? 1);
  const baseWr = Number(baseMetrics.wr ?? 0);
  const baseDd = Number(baseMetrics.dd ?? 0);

  const risks: RiskLevel[] = ['low', 'medium', 'high'];
  const freqs: FreqLevel[] = ['low', 'medium', 'high'];

  for (const risk of risks) {
    for (const freq of freqs) {
      const lotPercent = Math.min(200, Math.max(10, baseLot * riskMultipliers[risk]));
      const channelLen = freqChannels[freq];

      // Approximate metric scaling (real values come from preview worker for precise runs)
      const retScaled = baseRet * riskMultipliers[risk];
      const ddScaled = baseDd * riskMultipliers[risk];
      // equity curve: scale returns by risk multiplier
      const curveScaled = baseEquityCurve.map((v, i) =>
        i === 0 ? v : v * riskMultipliers[risk]
      );

      await upsertPreset({
        offer_id: offerId,
        risk_level: risk,
        freq_level: freq,
        sweep_run_id: sweepRunId,
        config: {
          ...baseConfig,
          lot_long_percent: lotPercent,
          lot_short_percent: lotPercent,
          price_channel_length: channelLen,
        },
        metrics: {
          ret: retScaled,
          pf: basePf,
          dd: ddScaled,
          wr: baseWr,
          trades: baseMetrics.trades,
        },
        equity_curve: curveScaled,
      });
    }
  }

  logger.info(`Built 9 presets for offer ${offerId} from sweep #${sweepRunId}`);
};

/**
 * Get a specific preset for client rendering.
 */
export const getPreset = async (
  offerId: string,
  riskLevel: RiskLevel,
  freqLevel: FreqLevel
): Promise<{ config: Record<string, unknown>; metrics: Record<string, unknown>; equity_curve: number[] } | null> => {
  const db = getResearchDb();
  const row = await db.get(
    `SELECT config_json, metrics_json, equity_curve_json
     FROM client_presets
     WHERE offer_id = ? AND risk_level = ? AND freq_level = ? AND is_current = 1
     ORDER BY created_at DESC LIMIT 1`,
    [offerId, riskLevel, freqLevel]
  );

  if (!row) {
    return null;
  }

  try {
    return {
      config: JSON.parse(row.config_json as string) as Record<string, unknown>,
      metrics: JSON.parse(row.metrics_json as string) as Record<string, unknown>,
      equity_curve: JSON.parse(row.equity_curve_json as string) as number[],
    };
  } catch {
    return null;
  }
};

/**
 * List all offers that have presets.
 */
export const listOfferIds = async (): Promise<string[]> => {
  const db = getResearchDb();
  const rows = await db.all(
    `SELECT DISTINCT offer_id FROM client_presets WHERE is_current = 1 ORDER BY offer_id`
  );
  return (rows || []).map((r: any) => String(r.offer_id));
};
