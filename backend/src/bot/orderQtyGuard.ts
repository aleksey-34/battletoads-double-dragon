export type QtyRulesLite = {
  symbol: string;
  qtyStep: number;
  minQty: number;
  maxQty: number;
  decimals: number;
};

const SIZING_EPSILON = 1e-9;

export const resolveInstrumentMaxQty = (info: any): number => {
  const fromOrder = Number(info?.lotSizeFilter?.maxOrderQty ?? 0);
  const fromMkt = Number(info?.lotSizeFilter?.maxMktOrderQty ?? 0);
  const candidates = [fromOrder, fromMkt].filter((v) => Number.isFinite(v) && v > 0);
  if (candidates.length === 0) return 0;
  return Math.min(...candidates);
};

/** One step below exchange max — avoids boundary rejections on market orders. */
export const effectiveMaxQty = (rules: Pick<QtyRulesLite, 'qtyStep' | 'minQty' | 'maxQty'>): number => {
  if (!Number.isFinite(rules.maxQty) || rules.maxQty <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const step = Number.isFinite(rules.qtyStep) && rules.qtyStep > 0 ? rules.qtyStep : rules.maxQty * 1e-6;
  const buffered = rules.maxQty - step;
  if (buffered >= rules.minQty) return buffered;
  return rules.maxQty;
};

export const normalizeQtyValue = (value: number, decimals: number): number => {
  const safeDecimals = Math.max(0, Math.min(12, decimals));
  return Number(value.toFixed(safeDecimals));
};

export const formatQty = (qty: number, decimals: number): string => (
  normalizeQtyValue(qty, decimals).toFixed(Math.max(0, decimals)).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
);

export const qtyToUnits = (qty: number, rules: QtyRulesLite): number => {
  const step = rules.qtyStep;
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(step) || step <= 0) return 0;
  return Math.floor((qty + SIZING_EPSILON) / step);
};

export const qtyFromUnits = (units: number, rules: QtyRulesLite): number => {
  if (!Number.isFinite(units) || units <= 0) return 0;
  return normalizeQtyValue(units * rules.qtyStep, Math.max(rules.decimals, 8));
};

export const clampQtyToRules = (qty: number, rules: QtyRulesLite): number => {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  const maxAllowed = effectiveMaxQty(rules);
  const capped = Math.min(qty, maxAllowed);
  const units = qtyToUnits(capped, rules);
  const minUnits = Math.max(1, Math.ceil((rules.minQty - SIZING_EPSILON) / rules.qtyStep));
  const maxUnits = Number.isFinite(maxAllowed)
    ? Math.floor((maxAllowed + SIZING_EPSILON) / rules.qtyStep)
    : units;
  const safeUnits = Math.min(Math.max(units, minUnits), maxUnits);
  return qtyFromUnits(safeUnits, rules);
};

export const clampQtyString = (qty: string, rules: QtyRulesLite): string => {
  const parsed = Number.parseFloat(String(qty || '0'));
  if (!Number.isFinite(parsed) || parsed <= 0) return qty;
  return formatQty(clampQtyToRules(parsed, rules), rules.decimals);
};

export const scaleQtyString = (qty: string, factor: number, rules: QtyRulesLite): string => {
  const parsed = Number.parseFloat(String(qty || '0'));
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isFinite(factor) || factor <= 0) return qty;
  return formatQty(clampQtyToRules(parsed * factor, rules), rules.decimals);
};

export type ParsedOrderLimitError =
  | { type: 'max_qty'; maxQty: number; orderQty?: number }
  | { type: 'risk_tier'; suggestedLeverage: number };

export const parseOrderQtyLimitError = (message: string): ParsedOrderLimitError | null => {
  const text = String(message || '');
  const lower = text.toLowerCase();

  const maxQtyMatch = text.match(/max_qty:([0-9]+)/i);
  const orderQtyMatch = text.match(/order_qty:([0-9]+)/i);
  if (maxQtyMatch) {
    const maxQty = Number(maxQtyMatch[1]);
    const orderQty = orderQtyMatch ? Number(orderQtyMatch[1]) : undefined;
    if (Number.isFinite(maxQty) && maxQty > 0) {
      return { type: 'max_qty', maxQty, orderQty };
    }
  }

  if (
    lower.includes('risk tier')
    || lower.includes('risk limit')
    || lower.includes('reduce-only or close-on-trigger')
  ) {
    const levMatch = text.match(/leverage to ([0-9]+) or below/i);
    const suggestedLeverage = levMatch ? Number(levMatch[1]) : 19;
    return {
      type: 'risk_tier',
      suggestedLeverage: Number.isFinite(suggestedLeverage) && suggestedLeverage > 0
        ? suggestedLeverage
        : 19,
    };
  }

  return null;
};

/** Scale both synthetic legs down if either exceeds exchange max; keeps leg ratio. */
export const capBalancedLegQty = (
  baseQty: string,
  quoteQty: string,
  baseRules: QtyRulesLite,
  quoteRules: QtyRulesLite,
): { baseQty: string; quoteQty: string; scaled: boolean } => {
  const baseNum = Number.parseFloat(baseQty);
  const quoteNum = Number.parseFloat(quoteQty);
  if (!Number.isFinite(baseNum) || baseNum <= 0 || !Number.isFinite(quoteNum) || quoteNum <= 0) {
    return { baseQty, quoteQty, scaled: false };
  }

  const maxBase = effectiveMaxQty(baseRules);
  const maxQuote = effectiveMaxQty(quoteRules);
  const scale = Math.min(
    1,
    maxBase / baseNum,
    maxQuote / quoteNum,
  );

  if (!Number.isFinite(scale) || scale >= 0.9999) {
    return {
      baseQty: clampQtyString(baseQty, baseRules),
      quoteQty: clampQtyString(quoteQty, quoteRules),
      scaled: false,
    };
  }

  return {
    baseQty: formatQty(clampQtyToRules(baseNum * scale, baseRules), baseRules.decimals),
    quoteQty: formatQty(clampQtyToRules(quoteNum * scale, quoteRules), quoteRules.decimals),
    scaled: true,
  };
};

/** Convert Bybit internal integer qty (8dp) to human qty when step is known. */
export const humanQtyFromBybitInteger = (raw: number, rules: QtyRulesLite): number => {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const asHuman = raw / 1e8;
  if (asHuman <= effectiveMaxQty(rules) * 1.5) return asHuman;
  return raw;
};

export const clampQtyToParsedMax = (
  qty: string,
  parsedMaxQty: number,
  rules: QtyRulesLite,
): string => {
  const parsed = Number.parseFloat(qty);
  if (!Number.isFinite(parsed) || parsed <= 0) return qty;

  let maxHuman = parsedMaxQty;
  if (parsedMaxQty > effectiveMaxQty(rules) * 10) {
    maxHuman = humanQtyFromBybitInteger(parsedMaxQty, rules);
  }

  const bufferedMax = Math.max(rules.minQty, maxHuman - rules.qtyStep);
  return formatQty(clampQtyToRules(Math.min(parsed, bufferedMax), {
    ...rules,
    maxQty: bufferedMax,
  }), rules.decimals);
};

export const decimalPlacesFromStep = (value: string): number => {
  const normalized = String(value || '');
  const scientific = normalized.toLowerCase().match(/e-(\d+)$/);
  if (scientific) {
    const parsed = Number.parseInt(scientific[1], 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }
  if (!normalized.includes('.')) return 0;
  return normalized.split('.')[1].replace(/0+$/, '').length;
};

export const qtyRulesFromInstrument = (symbol: string, info: any): QtyRulesLite => {
  const qtyStepRaw = String(info?.lotSizeFilter?.qtyStep || '0.001');
  const minQtyRaw = String(info?.lotSizeFilter?.minOrderQty || '0');
  const qtyStep = Number.parseFloat(qtyStepRaw);
  const minQty = Number.parseFloat(minQtyRaw);
  const maxQty = resolveInstrumentMaxQty(info);
  const safeStep = Number.isFinite(qtyStep) && qtyStep > 0 ? qtyStep : 0.001;
  const safeMin = Number.isFinite(minQty) && minQty > 0 ? minQty : 0;
  const safeMax = Number.isFinite(maxQty) && maxQty > 0 ? maxQty : Number.POSITIVE_INFINITY;
  return {
    symbol,
    qtyStep: safeStep,
    minQty: safeMin,
    maxQty: safeMax,
    decimals: Math.max(0, decimalPlacesFromStep(qtyStepRaw)),
  };
};
