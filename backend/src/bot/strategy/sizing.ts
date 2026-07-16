import { getInstrumentInfo } from '../exchange';
import { effectiveMaxQty, resolveInstrumentMaxQty } from '../orderQtyGuard';

export type QtyRules = {
  symbol: string;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  decimals: number;
};

type QtyCandidate = {
  qty: number;
  notional: number;
  text: string;
};

export type BalancedQtyPlan = {
  baseQty: string;
  quoteQty: string;
  baseNotional: number;
  quoteNotional: number;
  totalNotional: number;
  shareError: number;
  totalDeviation: number;
  oversize: number;
  baseTargetNotional: number;
  quoteTargetNotional: number;
  baseLegDeviation?: number;
  quoteLegDeviation?: number;
  hasWarning?: boolean;
  warningReason?: string;
};

export type SingleQtyPlan = {
  qty: string;
  notional: number;
  targetNotional: number;
  totalDeviation: number;
  oversize: number;
  hasWarning?: boolean;
  warningReason?: string;
};

export type LiveLegBalanceSnapshot = {
  baseNotional: number;
  quoteNotional: number;
  expectedBaseShare: number;
  actualBaseShare: number;
  shareError: number;
};

const SIZING_EPSILON = 1e-9;
const MAX_SHARE_ERROR = 0.5;
const MAX_LEG_DEVIATION = 0.3;
const MAX_OVERSIZE_DEVIATION = 0.2;
const MAX_TOTAL_DEVIATION = 0.3;
export const MAX_POST_OPEN_SHARE_ERROR = 0.08;

/**
 * Hard position-size ceiling: entry is BLOCKED (not just warned) when the best
 * achievable exchange lot (after qty-step/minQty rounding) would exceed this
 * fraction above the calculated target notional. E.g. 0.5 == reject any entry
 * that would open more than 1.5x the intended target size for the instrument.
 * `oversize` on SingleQtyPlan/BalancedQtyPlan is already the fraction above
 * target ((actual - target) / target), so this is compared directly against it.
 */
export const MAX_ENTRY_OVERSIZE_FRACTION = 0.5;

const decimalPlaces = (value: string): number => {
  const normalized = String(value || '');
  const scientific = normalized.toLowerCase().match(/e-(\d+)$/);
  if (scientific) {
    const parsed = Number.parseInt(scientific[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  if (!normalized.includes('.')) {
    return 0;
  }
  return normalized.split('.')[1].replace(/0+$/, '').length;
};

const normalizeQtyValue = (value: number, decimals: number): number => {
  const safeDecimals = Math.max(0, Math.min(12, decimals));
  return Number(value.toFixed(safeDecimals));
};

const formatQty = (qty: number, decimals: number): string => {
  return normalizeQtyValue(qty, decimals).toFixed(Math.max(0, decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};

export const loadQtyRules = async (apiKeyName: string, symbol: string): Promise<QtyRules> => {
  const info = await getInstrumentInfo(apiKeyName, symbol);

  const qtyStepRaw = String(info?.lotSizeFilter?.qtyStep || '0.001');
  const minQtyRaw = String(info?.lotSizeFilter?.minOrderQty || '0');
  const maxQtyRaw = String(resolveInstrumentMaxQty(info) || info?.lotSizeFilter?.maxOrderQty || '0');

  const qtyStep = Number.parseFloat(qtyStepRaw);
  const minQty = Number.parseFloat(minQtyRaw);
  const maxQty = Number.parseFloat(maxQtyRaw);

  const safeStep = Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : 0.001;
  const safeMin = Number.isFinite(minQty) && minQty > 0 ? minQty : 0;
  const safeMax = Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.POSITIVE_INFINITY;

  return {
    symbol,
    qtyStep: safeStep,
    minQty: safeMin,
    maxQty: safeMax,
    decimals: Math.max(0, decimalPlaces(qtyStepRaw)),
  };
};

const qtyFromUnits = (units: number, rules: QtyRules): number => {
  if (!Number.isFinite(units) || units <= 0) {
    return 0;
  }

  return normalizeQtyValue(units * rules.qtyStep, Math.max(rules.decimals, 8));
};

const buildQtyCandidates = (rawQty: number, price: number, rules: QtyRules): QtyCandidate[] => {
  if (!Number.isFinite(rawQty) || rawQty <= 0) {
    throw new Error(`Invalid raw qty for ${rules.symbol}`);
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid market price for ${rules.symbol}`);
  }

  const step = rules.qtyStep;
  const maxCap = effectiveMaxQty(rules);
  const maxUnits = Number.isFinite(maxCap)
    ? Math.floor((maxCap + SIZING_EPSILON) / step)
    : Number.POSITIVE_INFINITY;
  const minUnitsByFilter = Math.max(1, Math.ceil((rules.minQty - SIZING_EPSILON) / step));
  const centerUnits = rawQty / step;
  const floorUnits = Math.floor(centerUnits + SIZING_EPSILON);
  const ceilUnits = Math.ceil(centerUnits - SIZING_EPSILON);

  const rawStart = Math.max(minUnitsByFilter, floorUnits - 3);
  const rawEnd = Math.max(rawStart, ceilUnits + 3);

  const unitSet = new Set<number>();
  for (let units = rawStart; units <= rawEnd; units += 1) {
    if (units >= minUnitsByFilter && units > 0 && units <= maxUnits) {
      unitSet.add(units);
    }
  }

  if (minUnitsByFilter <= maxUnits) {
    unitSet.add(minUnitsByFilter);
  }
  if (floorUnits >= minUnitsByFilter && floorUnits <= maxUnits) {
    unitSet.add(floorUnits);
  }
  if (ceilUnits >= minUnitsByFilter && ceilUnits <= maxUnits) {
    unitSet.add(ceilUnits);
  }

  const candidates = Array.from(unitSet)
    .map((units) => qtyFromUnits(units, rules))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .filter((qty) => qty + SIZING_EPSILON >= rules.minQty)
    .filter((qty) => qty <= maxCap + SIZING_EPSILON)
    .map((qty) => ({
      qty,
      notional: qty * price,
      text: formatQty(qty, rules.decimals),
    }))
    .sort((left, right) => left.qty - right.qty);

  if (candidates.length === 0) {
    throw new Error(`Unable to build qty candidates for ${rules.symbol}`);
  }

  return candidates;
};

export const buildBalancedQtyPlan = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  basePrice: number,
  quotePrice: number,
  totalNotional: number,
  baseWeight: number,
  quoteWeight: number
): Promise<BalancedQtyPlan> => {
  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  if (!Number.isFinite(baseWeight) || !Number.isFinite(quoteWeight) || baseWeight <= 0 || quoteWeight <= 0) {
    throw new Error('Both synthetic leg coefficients must be non-zero for balanced execution');
  }

  const totalWeight = baseWeight + quoteWeight;
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error('Synthetic coefficient weights are invalid');
  }

  const baseTargetNotional = totalNotional * (baseWeight / totalWeight);
  const quoteTargetNotional = totalNotional * (quoteWeight / totalWeight);
  const rawBaseQty = baseTargetNotional / basePrice;
  const rawQuoteQty = quoteTargetNotional / quotePrice;

  const [baseRules, quoteRules] = await Promise.all([
    loadQtyRules(apiKeyName, baseSymbol),
    loadQtyRules(apiKeyName, quoteSymbol),
  ]);

  const baseCandidates = buildQtyCandidates(rawBaseQty, basePrice, baseRules);
  const quoteCandidates = buildQtyCandidates(rawQuoteQty, quotePrice, quoteRules);

  const targetBaseShare = baseWeight / totalWeight;

  let best: {
    base: QtyCandidate;
    quote: QtyCandidate;
    totalActual: number;
    baseShare: number;
    shareError: number;
    totalDeviation: number;
    oversize: number;
    baseLegDeviation: number;
    quoteLegDeviation: number;
    score: number;
  } | null = null;

  for (const baseCandidate of baseCandidates) {
    for (const quoteCandidate of quoteCandidates) {
      const totalActual = baseCandidate.notional + quoteCandidate.notional;
      if (!Number.isFinite(totalActual) || totalActual <= 0) {
        continue;
      }

      const baseShare = baseCandidate.notional / totalActual;
      const shareError = Math.abs(baseShare - targetBaseShare);
      const totalDeviation = Math.abs(totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON);
      const oversize = Math.max(0, (totalActual - totalNotional) / Math.max(totalNotional, SIZING_EPSILON));
      const baseLegDeviation = Math.abs(baseCandidate.notional - baseTargetNotional) / Math.max(baseTargetNotional, SIZING_EPSILON);
      const quoteLegDeviation = Math.abs(quoteCandidate.notional - quoteTargetNotional) / Math.max(quoteTargetNotional, SIZING_EPSILON);

      const score = shareError * 1000 + oversize * 200 + totalDeviation * 10;

      if (!best || score < best.score) {
        best = {
          base: baseCandidate,
          quote: quoteCandidate,
          totalActual,
          baseShare,
          shareError,
          totalDeviation,
          oversize,
          baseLegDeviation,
          quoteLegDeviation,
          score,
        };
      }
    }
  }

  if (!best) {
    throw new Error('Unable to find a valid balanced quantity plan');
  }

  const hasWarnings = best.shareError > MAX_SHARE_ERROR
    || best.baseLegDeviation > MAX_LEG_DEVIATION
    || best.quoteLegDeviation > MAX_LEG_DEVIATION
    || best.totalDeviation > MAX_TOTAL_DEVIATION
    || best.oversize > MAX_OVERSIZE_DEVIATION;

  let warningReason: string | undefined;
  if (hasWarnings) {
    const issues: string[] = [];
    if (best.shareError > MAX_SHARE_ERROR) {
      issues.push(`shareError=${(best.shareError * 100).toFixed(2)}% (limit ${(MAX_SHARE_ERROR * 100).toFixed(0)}%)`);
    }
    if (best.baseLegDeviation > MAX_LEG_DEVIATION) {
      issues.push(`baseDev=${(best.baseLegDeviation * 100).toFixed(2)}%`);
    }
    if (best.quoteLegDeviation > MAX_LEG_DEVIATION) {
      issues.push(`quoteDev=${(best.quoteLegDeviation * 100).toFixed(2)}%`);
    }
    if (best.totalDeviation > MAX_TOTAL_DEVIATION) {
      issues.push(`totalDev=${(best.totalDeviation * 100).toFixed(2)}%`);
    }
    if (best.oversize > MAX_OVERSIZE_DEVIATION) {
      issues.push(`oversize=${(best.oversize * 100).toFixed(2)}%`);
    }
    warningReason = issues.join('; ');
  }

  return {
    baseQty: best.base.text,
    quoteQty: best.quote.text,
    baseNotional: best.base.notional,
    quoteNotional: best.quote.notional,
    totalNotional: best.totalActual,
    shareError: best.shareError,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
    baseTargetNotional,
    quoteTargetNotional,
    baseLegDeviation: best.baseLegDeviation,
    quoteLegDeviation: best.quoteLegDeviation,
    hasWarning: hasWarnings,
    warningReason,
  };
};

export const buildSingleQtyPlan = async (
  apiKeyName: string,
  symbol: string,
  price: number,
  targetNotional: number
): Promise<SingleQtyPlan> => {
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    throw new Error('Trade notional must be positive');
  }

  const rules = await loadQtyRules(apiKeyName, symbol);
  const rawQty = targetNotional / price;
  const candidates = buildQtyCandidates(rawQty, price, rules);

  let best: {
    candidate: QtyCandidate;
    totalDeviation: number;
    oversize: number;
    score: number;
  } | null = null;

  for (const candidate of candidates) {
    const totalDeviation = Math.abs(candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON);
    const oversize = Math.max(0, (candidate.notional - targetNotional) / Math.max(targetNotional, SIZING_EPSILON));
    const score = oversize * 200 + totalDeviation * 10;

    if (!best || score < best.score) {
      best = {
        candidate,
        totalDeviation,
        oversize,
        score,
      };
    }
  }

  if (!best) {
    throw new Error(`Unable to find a valid quantity plan for ${symbol}`);
  }

  const hasWarning = best.totalDeviation > MAX_TOTAL_DEVIATION || best.oversize > MAX_OVERSIZE_DEVIATION;
  let warningReason: string | undefined;
  if (hasWarning) {
    warningReason = (
      `Order size too small for mono execution: targetNotional=${targetNotional.toFixed(2)} USDT, `
      + `actualNotional=${best.candidate.notional.toFixed(2)} USDT, `
      + `totalDeviation=${(best.totalDeviation * 100).toFixed(2)}%, `
      + `oversize=${(best.oversize * 100).toFixed(2)}%. Using min lot.`
    );
  }

  return {
    qty: best.candidate.text,
    notional: best.candidate.notional,
    targetNotional,
    totalDeviation: best.totalDeviation,
    oversize: best.oversize,
    hasWarning,
    warningReason,
  };
};

const extractPositionNotional = (position: any): number => {
  const explicit = Number(position?.positionValue);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.abs(explicit);
  }

  const size = Number(position?.size);
  const markPrice = Number(position?.markPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(markPrice) && markPrice > 0) {
    return Math.abs(size * markPrice);
  }

  const entryPrice = Number(position?.avgPrice ?? position?.entryPrice);
  if (Number.isFinite(size) && size > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
    return Math.abs(size * entryPrice);
  }

  return 0;
};

export const validateLiveLegBalance = (
  basePosition: any,
  quotePosition: any,
  baseWeight: number,
  quoteWeight: number,
  maxShareError: number
): { ok: boolean; snapshot: LiveLegBalanceSnapshot } => {
  const safeBaseWeight = Math.abs(baseWeight);
  const safeQuoteWeight = Math.abs(quoteWeight);
  const totalWeight = safeBaseWeight + safeQuoteWeight;

  const baseNotional = extractPositionNotional(basePosition);
  const quoteNotional = extractPositionNotional(quotePosition);
  const totalNotional = baseNotional + quoteNotional;

  const expectedBaseShare = totalWeight > SIZING_EPSILON
    ? safeBaseWeight / totalWeight
    : 0.5;
  const actualBaseShare = totalNotional > SIZING_EPSILON
    ? baseNotional / totalNotional
    : 0;
  const shareError = Math.abs(actualBaseShare - expectedBaseShare);

  return {
    ok: totalNotional > SIZING_EPSILON && shareError <= Math.max(0, maxShareError),
    snapshot: {
      baseNotional,
      quoteNotional,
      expectedBaseShare,
      actualBaseShare,
      shareError,
    },
  };
};
