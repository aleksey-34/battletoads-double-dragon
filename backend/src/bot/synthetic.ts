import { getMarketData } from './exchange';

type ParsedCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type SyntheticCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  quoteVolume: number;
};

type SyntheticQueryOptions = {
  startMs?: number;
  endMs?: number;
};

const intervalToMinutes = (interval: string): number => {
  const normalized = interval.trim();

  if (normalized.endsWith('m')) {
    return Number.parseInt(normalized.replace('m', ''), 10);
  }
  if (normalized.endsWith('h')) {
    return Number.parseInt(normalized.replace('h', ''), 10) * 60;
  }
  if (normalized === '1d') {
    return 1440;
  }
  if (normalized === '1w') {
    return 10080;
  }
  if (normalized === '1M') {
    return 43200;
  }

  return 60;
};

const chooseSourceInterval = (targetInterval: string): string => {
  return String(targetInterval || '1h').trim() || '1h';
};

const getBucketStartMs = (timeMs: number, interval: string): number => {
  const offsetMinutesRaw = Number(process.env.SYNTHETIC_BUCKET_OFFSET_MINUTES || 0);
  const offsetMinutes = Number.isFinite(offsetMinutesRaw) ? Math.floor(offsetMinutesRaw) : 0;
  const offsetMs = offsetMinutes * 60 * 1000;

  if (interval === '1M') {
    const date = new Date(timeMs - offsetMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
  }

  const intervalMs = intervalToMinutes(interval) * 60 * 1000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return timeMs;
  }

  return Math.floor((timeMs - offsetMs) / intervalMs) * intervalMs + offsetMs;
};

const parseCandle = (raw: any): ParsedCandle | null => {
  if (!Array.isArray(raw) || raw.length < 6) {
    return null;
  }

  const timeMs = Number(raw[0]);
  const open = Number(raw[1]);
  const high = Number(raw[2]);
  const low = Number(raw[3]);
  const close = Number(raw[4]);
  const volume = Number(raw[5]);

  if (
    !Number.isFinite(timeMs) ||
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close) ||
    !Number.isFinite(volume)
  ) {
    return null;
  }

  return { timeMs, open, high, low, close, volume };
};

const buildSyntheticSubCandle = (
  baseCandle: ParsedCandle,
  quoteCandle: ParsedCandle,
  baseCoef: number,
  quoteCoef: number
): SyntheticCandle | null => {
  const quoteOpen = quoteCoef * quoteCandle.open;
  const quoteClose = quoteCoef * quoteCandle.close;
  const quoteHigh = quoteCoef * quoteCandle.high;
  const quoteLow = quoteCoef * quoteCandle.low;

  if (quoteOpen <= 0 || quoteClose <= 0 || quoteHigh <= 0 || quoteLow <= 0) {
    return null;
  }

  const open = (baseCoef * baseCandle.open) / quoteOpen;
  const close = (baseCoef * baseCandle.close) / quoteClose;
  const ratioHighLow = (baseCoef * baseCandle.high) / quoteLow;
  const ratioLowHigh = (baseCoef * baseCandle.low) / quoteHigh;

  // We only know bar-level OHLC for each leg, so enforce valid synthetic candle geometry.
  const high = Math.max(open, close, ratioHighLow, ratioLowHigh);
  const low = Math.min(open, close, ratioHighLow, ratioLowHigh);

  return {
    timeMs: baseCandle.timeMs,
    open,
    high,
    low,
    close,
    baseVolume: baseCandle.volume,
    quoteVolume: quoteCandle.volume,
  };
};

// Синтетический OHLC: (baseCoef * base) / (quoteCoef * quote)
export async function calculateSyntheticOHLC(
  apiKeyName: string,
  base: string,
  quote: string,
  baseCoef: number,
  quoteCoef: number,
  interval: string,
  limit: number,
  options?: SyntheticQueryOptions
) {
  const safeBaseCoef = Number.isFinite(baseCoef) && baseCoef > 0 ? baseCoef : 1;
  const safeQuoteCoef = Number.isFinite(quoteCoef) && quoteCoef > 0 ? quoteCoef : 1;
  const safeInterval = interval || '1h';
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
  const sourceInterval = chooseSourceInterval(safeInterval);

  const targetMinutes = intervalToMinutes(safeInterval);
  const sourceMinutes = intervalToMinutes(sourceInterval);
  const ratio = Math.max(1, Math.round(targetMinutes / sourceMinutes));
  const hasRange = Number.isFinite(Number(options?.startMs)) || Number.isFinite(Number(options?.endMs));
  const sourceLimit = hasRange
    ? Math.max(safeLimit * ratio + 5, safeLimit)
    : Math.min(1000, Math.max(safeLimit * ratio + 5, safeLimit));

  const baseData = await getMarketData(apiKeyName, base, sourceInterval, sourceLimit, options);
  const quoteData = await getMarketData(apiKeyName, quote, sourceInterval, sourceLimit, options);

  if (!baseData || !Array.isArray(baseData) || baseData.length === 0) {
    throw new Error(`Нет данных по базовой паре: ${base}`);
  }
  if (!quoteData || !Array.isArray(quoteData) || quoteData.length === 0) {
    throw new Error(`Нет данных по котируемой паре: ${quote}`);
  }

  const parsedBase = baseData.map(parseCandle).filter((item): item is ParsedCandle => !!item);
  const parsedQuote = quoteData.map(parseCandle).filter((item): item is ParsedCandle => !!item);

  if (parsedBase.length === 0 || parsedQuote.length === 0) {
    throw new Error('Пустые данные после парсинга свечей');
  }

  const quoteByTime = new Map<number, ParsedCandle>();
  parsedQuote.forEach((candle) => {
    quoteByTime.set(candle.timeMs, candle);
  });

  const buckets = new Map<number, SyntheticCandle>();
  const sortedBase = [...parsedBase].sort((a, b) => a.timeMs - b.timeMs);

  for (const baseCandle of sortedBase) {
    const quoteCandle = quoteByTime.get(baseCandle.timeMs);
    if (!quoteCandle) {
      continue;
    }

    const subSynthetic = buildSyntheticSubCandle(baseCandle, quoteCandle, safeBaseCoef, safeQuoteCoef);
    if (!subSynthetic) {
      continue;
    }

    const bucketTimeMs = getBucketStartMs(subSynthetic.timeMs, safeInterval);
    const existing = buckets.get(bucketTimeMs);

    if (!existing) {
      buckets.set(bucketTimeMs, {
        ...subSynthetic,
        timeMs: bucketTimeMs,
      });
      continue;
    }

    existing.high = Math.max(existing.high, subSynthetic.high);
    existing.low = Math.min(existing.low, subSynthetic.low);
    existing.close = subSynthetic.close;
    existing.baseVolume += subSynthetic.baseVolume;
    existing.quoteVolume += subSynthetic.quoteVolume;
  }

  const aggregatedAsc = Array.from(buckets.values())
    .sort((a, b) => a.timeMs - b.timeMs);

  const aggregated = aggregatedAsc
    .slice(-safeLimit)
    .map((candle) => ({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      time: String(candle.timeMs),
      baseVolume: candle.baseVolume,
      quoteVolume: candle.quoteVolume,
    }));

  if (aggregated.length === 0) {
    throw new Error('Не удалось рассчитать синтетические свечи: нет общих временных точек');
  }

  return aggregated;
}