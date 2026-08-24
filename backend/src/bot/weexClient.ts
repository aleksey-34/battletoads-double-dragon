import '../utils/preferIpv4';
import { createHmac } from 'crypto';
import { ApiKey } from '../config/settings';

type WeexQueryValue = string | number | boolean | null | undefined;

type WeexRequestOptions = {
  auth?: boolean;
  query?: Record<string, WeexQueryValue>;
  body?: Record<string, unknown>;
};

const WEEX_API_BASE = 'https://api-contract.weex.com';
const WEEX_TICKER_CACHE_TTL_MS = 5_000;

const normalizeSymbolKey = (value: unknown): string => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const firstPositiveNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
  }
  return null;
};

/** WEEX may return tick as 0.0001 or as decimal-places count (4 → 0.0001). */
const stepFromPrecisionField = (raw: unknown, fallback: number): number => {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (Number.isInteger(n) && n >= 1 && n <= 16) {
    return Math.pow(10, -n);
  }
  return n;
};

const countStepDecimals = (step: number): number => {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const normalized = step.toFixed(16).replace(/0+$/, '');
  const dot = normalized.indexOf('.');
  return dot >= 0 ? Math.min(16, normalized.length - dot - 1) : 0;
};

const formatToStep = (value: number, step: number): string => {
  if (!Number.isFinite(value)) return '0';
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.0001;
  const rounded = Math.round(value / safeStep) * safeStep;
  return rounded.toFixed(countStepDecimals(safeStep));
};

const toWeexPrivateSymbol = (value: unknown): string => {
  const normalized = normalizeSymbolKey(value).replace(/^CMT/, '');
  // CCXT swap symbols (e.g. SUI/USDT:USDT) normalize to SUIUSDTUSDT; collapse duplicate settle suffix.
  return normalized.replace(/(USDT|USDC)\1$/, '$1');
};

const toWeexPublicSymbol = (value: unknown): string => `cmt_${toWeexPrivateSymbol(value).toLowerCase()}`;

const toWeexCcxtSymbol = (value: unknown): string => {
  const raw = toWeexPrivateSymbol(value);
  if (raw.endsWith('USDT') && raw.length > 4) {
    return `${raw.slice(0, -4)}/USDT:USDT`;
  }
  return raw;
};

// WEEX v3 only natively accepts: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, 1w.
// Unsupported intervals (2h, 3m, 6h, 8h, 3d) get an aggregation source so
// fetchOHLCV can still build them locally from a smaller bucket.
const WEEX_NATIVE_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w']);
const WEEX_AGGREGATION_MAP: Record<string, { source: string; factor: number }> = {
  '2h': { source: '1h', factor: 2 },
  '6h': { source: '1h', factor: 6 },
  '8h': { source: '1h', factor: 8 },
  '3d': { source: '1d', factor: 3 },
  '3m': { source: '1m', factor: 3 },
};
const mapWeexTimeframe = (timeframe: string): string => {
  const normalized = String(timeframe || '').trim();
  if (WEEX_NATIVE_INTERVALS.has(normalized)) return normalized;
  if (WEEX_AGGREGATION_MAP[normalized]) return WEEX_AGGREGATION_MAP[normalized].source;
  return '1m';
};
const aggregateOhlcv = (rows: number[][], factor: number): number[][] => {
  if (factor <= 1 || !Array.isArray(rows) || rows.length === 0) return rows;
  const sorted = [...rows].sort((a, b) => Number(a[0]) - Number(b[0]));
  const bucketMs = (Number(sorted[1]?.[0] ?? sorted[0][0]) - Number(sorted[0][0])) * factor;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return sorted;
  const out: number[][] = [];
  let bucketStart: number | null = null;
  let o = 0, h = 0, l = 0, c = 0, v = 0;
  for (const row of sorted) {
    const ts = Number(row[0]);
    if (!Number.isFinite(ts)) continue;
    const aligned = ts - (ts % bucketMs);
    if (bucketStart === null) {
      bucketStart = aligned;
      o = Number(row[1]); h = Number(row[2]); l = Number(row[3]); c = Number(row[4]); v = Number(row[5] ?? 0);
      continue;
    }
    if (aligned !== bucketStart) {
      out.push([bucketStart, o, h, l, c, v]);
      bucketStart = aligned;
      o = Number(row[1]); h = Number(row[2]); l = Number(row[3]); c = Number(row[4]); v = Number(row[5] ?? 0);
    } else {
      h = Math.max(h, Number(row[2]));
      l = Math.min(l, Number(row[3]));
      c = Number(row[4]);
      v += Number(row[5] ?? 0);
    }
  }
  if (bucketStart !== null) out.push([bucketStart, o, h, l, c, v]);
  return out;
};

const buildQueryString = (query?: Record<string, WeexQueryValue>): string => {
  const params = new URLSearchParams();

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    params.append(key, String(value));
  });

  return params.toString();
};

class WeexRestClient {
  public options: Record<string, unknown> = {
    defaultType: 'swap',
  };

  private readonly apiKey: string;
  private readonly secret: string;
  private readonly passphrase: string;
  private marketsCache: Record<string, any> | null = null;
  private tickerCache: { data: Record<string, any>; timestamp: number } | null = null;

  constructor(config: { apiKey: string; secret: string; passphrase?: string }) {
    this.apiKey = String(config.apiKey || '').trim();
    this.secret = String(config.secret || '').trim();
    this.passphrase = String(config.passphrase || '').trim();
  }

  setSandboxMode(): void {
    // WEEX futures public docs do not expose a sandbox environment; keep the interface no-op.
  }

  async fetchTime(): Promise<number> {
    return Date.now();
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    requestPath: string,
    options: WeexRequestOptions = {}
  ): Promise<any> {
    const queryString = buildQueryString(options.query);
    const url = `${WEEX_API_BASE}${requestPath}${queryString ? `?${queryString}` : ''}`;
    const hasBody = Boolean(options.body && Object.keys(options.body).length > 0);
    const bodyString = hasBody ? JSON.stringify(options.body) : '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (options.auth) {
      if (!this.apiKey || !this.secret) {
        throw new Error('WEEX API key and secret are required');
      }
      if (!this.passphrase) {
        throw new Error('WEEX passphrase is required');
      }

      const timestamp = String(Date.now());
      const message = `${timestamp}${method.toUpperCase()}${requestPath}${queryString ? `?${queryString}` : ''}${bodyString}`;
      headers['ACCESS-KEY'] = this.apiKey;
      headers['ACCESS-SIGN'] = createHmac('sha256', this.secret).update(message).digest('base64');
      headers['ACCESS-TIMESTAMP'] = timestamp;
      headers['ACCESS-PASSPHRASE'] = this.passphrase;
    }

    // Hard timeout to prevent monitoring/runtime cycles from hanging if WEEX is unresponsive.
    const controller = new AbortController();
    const timeoutMs = 15_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? bodyString : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new Error(`WEEX ${method} ${requestPath} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    let payload: any = null;

    if (responseText) {
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = responseText;
      }
    }

    if (!response.ok) {
      const details = typeof payload === 'string'
        ? payload
        : JSON.stringify(payload || {});
      throw new Error(`WEEX ${method} ${requestPath} failed (${response.status}): ${details}`);
    }

    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const code = payload.code ?? payload.retCode ?? payload.status;
      const success = payload.success;
      const isCodeOk = code === undefined
        || code === 0
        || code === '0'
        || code === 200
        || code === '200'
        || code === '00000'
        || code === 'success';

      if (success === false || !isCodeOk) {
        const errorMessage = payload.errorMessage || payload.msg || payload.message || payload.retMsg || JSON.stringify(payload);
        throw new Error(`WEEX ${method} ${requestPath} error: ${errorMessage}`);
      }
    }

    return payload?.data !== undefined ? payload.data : payload;
  }

  private mapOrder(order: any) {
    const rawSymbol = toWeexPrivateSymbol(order?.symbol);
    const amount = Number(order?.origQty ?? order?.quantity ?? order?.qty ?? 0);
    const price = Number(order?.price ?? order?.avgPrice ?? 0);
    const filled = Number(order?.executedQty ?? order?.filledQty ?? 0);

    return {
      id: String(order?.orderId || ''),
      clientOrderId: String(order?.clientOrderId || order?.newClientOrderId || ''),
      symbol: toWeexCcxtSymbol(rawSymbol),
      side: String(order?.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
      type: String(order?.type || 'MARKET').toLowerCase(),
      status: String(order?.status || 'open').toLowerCase(),
      amount: Number.isFinite(amount) ? Math.abs(amount) : 0,
      filled: Number.isFinite(filled) ? Math.abs(filled) : 0,
      remaining: Math.max(0, (Number.isFinite(amount) ? Math.abs(amount) : 0) - (Number.isFinite(filled) ? Math.abs(filled) : 0)),
      price: Number.isFinite(price) ? price : 0,
      reduceOnly: Boolean(order?.reduceOnly),
      timestamp: Number(order?.time ?? order?.createTime ?? Date.now()),
      info: {
        ...order,
        symbol: rawSymbol,
      },
    };
  }

  async loadMarkets(): Promise<Record<string, any>> {
    if (this.marketsCache) {
      return this.marketsCache;
    }

    const response = await this.request('GET', '/capi/v3/market/exchangeInfo');
    const symbols = Array.isArray(response?.symbols)
      ? response.symbols
      : Array.isArray(response?.data?.symbols)
        ? response.data.symbols
        : [];

    const markets: Record<string, any> = {};

    for (const item of symbols) {
      const rawSymbol = toWeexPrivateSymbol(item?.symbol);
      if (!rawSymbol) {
        continue;
      }

      const ccxtSymbol = toWeexCcxtSymbol(rawSymbol);
      const minAmount = firstPositiveNumber(item?.minOrderSize);
      const maxAmount = firstPositiveNumber(item?.marketOpenLimitSize, item?.maxOrderSize, item?.maxPositionSize);
      const pricePrecision = stepFromPrecisionField(
        firstPositiveNumber(item?.pricePrecision, item?.pricePlace, item?.tickSize, item?.priceStep),
        0.0001,
      );
      // WEEX stepSize may come as explicit field, or as sizeMultiplier, or as
      // contractSize. quantityPrecision is decimal-places count (0 = integer),
      // NOT the step itself.  Derive step from explicit fields first.
      const explicitStep = firstPositiveNumber(item?.stepSize, item?.sizeMultiplier, item?.volumeStep, item?.contractSize);
      const decimalPlacesStep = (() => {
        const dp = Number(item?.quantityPrecision ?? item?.baseAssetPrecision);
        // WEEX: negative quantityPrecision means lot in powers of 10 (e.g. -2 → step 100).
        // Math.pow(10, -dp) covers both: 1 → 0.1, -2 → 100.
        if (!Number.isFinite(dp) || dp > 16 || dp < -8) return null;
        return Math.pow(10, -dp);
      })();
      const amountPrecision = explicitStep ?? decimalPlacesStep ?? firstPositiveNumber(item?.size_increment, minAmount) ?? 0.001;
      const maxLeverage = firstPositiveNumber(item?.maxLeverage);
      const minLeverage = firstPositiveNumber(item?.minLeverage);

      markets[ccxtSymbol] = {
        id: rawSymbol,
        symbol: ccxtSymbol,
        contract: true,
        swap: true,
        future: false,
        active: item?.status !== 'offline' && item?.status !== 'suspend',
        base: String(item?.baseAsset || rawSymbol.slice(0, -4) || '').toUpperCase(),
        quote: String(item?.quoteAsset || 'USDT').toUpperCase(),
        settle: String(item?.marginAsset || 'USDT').toUpperCase(),
        precision: {
          amount: amountPrecision,
          price: pricePrecision,
        },
        limits: {
          leverage: {
            min: minLeverage ?? undefined,
            max: maxLeverage ?? undefined,
          },
          amount: {
            min: minAmount ?? undefined,
            max: maxAmount ?? undefined,
          },
          price: {},
          cost: {},
        },
        info: {
          ...item,
          symbol: rawSymbol,
          maxLeverage: maxLeverage ?? undefined,
          lotSizeFilter: {
            qtyStep: String(amountPrecision),
            minOrderQty: String(minAmount ?? 0),
            maxOrderQty: String(maxAmount ?? 0),
          },
        },
      };
    }

    this.marketsCache = markets;
    return markets;
  }

  private async getTickerMap(): Promise<Record<string, any>> {
    if (this.tickerCache && Date.now() - this.tickerCache.timestamp < WEEX_TICKER_CACHE_TTL_MS) {
      return this.tickerCache.data;
    }

    const response = await this.request('GET', '/capi/v3/market/ticker/24hr');
    const rows = Array.isArray(response) ? response : [];
    const mapped: Record<string, any> = {};

    for (const item of rows) {
      const rawSymbol = toWeexPrivateSymbol(item?.symbol);
      if (!rawSymbol) {
        continue;
      }

      const ccxtSymbol = toWeexCcxtSymbol(rawSymbol);
      mapped[ccxtSymbol] = {
        symbol: ccxtSymbol,
        last: Number(item?.lastPrice ?? item?.last ?? 0),
        close: Number(item?.lastPrice ?? item?.last ?? 0),
        baseVolume: Number(item?.volume ?? item?.base_volume ?? 0),
        quoteVolume: Number(item?.quoteVolume ?? item?.volume_24h ?? 0),
        percentage: Number(item?.priceChangePercent ?? 0) * 100,
        info: {
          ...item,
          symbol: rawSymbol,
        },
      };
    }

    this.tickerCache = {
      data: mapped,
      timestamp: Date.now(),
    };

    return mapped;
  }

  async fetchTickers(): Promise<Record<string, any>> {
    return this.getTickerMap();
  }

  async fetchTicker(symbol: string): Promise<any> {
    const tickers = await this.getTickerMap();
    const target = tickers[toWeexCcxtSymbol(symbol)];

    if (!target) {
      throw new Error(`WEEX ticker not found for ${symbol}`);
    }

    return target;
  }

  async fetchOHLCV(symbol: string, timeframe = '1m', _since?: number, limit = 100): Promise<any[]> {
    const requestedTf = String(timeframe || '').trim();
    const aggregation = WEEX_AGGREGATION_MAP[requestedTf];
    const fetchInterval = mapWeexTimeframe(requestedTf);
    const fetchLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const adjustedLimit = aggregation
      ? Math.max(1, Math.min(fetchLimit * aggregation.factor, 1000))
      : fetchLimit;
    const response = await this.request('GET', '/capi/v3/market/klines', {
      query: {
        symbol: toWeexPrivateSymbol(symbol),
        interval: fetchInterval,
        limit: adjustedLimit,
      },
    });

    const rows = Array.isArray(response) ? response : [];

    const parsed = rows
      .map((item: any) => Array.isArray(item?.value) ? item.value : item)
      .filter((item: any) => Array.isArray(item) && item.length >= 6)
      .map((item: any[]) => [
        Number(item[0]),
        Number(item[1]),
        Number(item[2]),
        Number(item[3]),
        Number(item[4]),
        Number(item[5] ?? 0),
      ])
      .filter((item: number[]) => Number.isFinite(item[0]))
      .sort((left: number[], right: number[]) => left[0] - right[0]);

    return aggregation ? aggregateOhlcv(parsed, aggregation.factor) : parsed;
  }

  async fetchBalance(): Promise<any> {
    // Elite/Copy Trading keys expose funds on v3 /account/balance (~full wallet).
    // Regular Futures keys often still answer on v2 /account/assets (can be a tiny residual).
    // Prefer v3 so Copy/Elite lead accounts are sized correctly; fall back to v2.
    let rows: any[] = [];
    let source: 'v3_balance' | 'v2_assets' = 'v3_balance';
    try {
      const response = await this.request('GET', '/capi/v3/account/balance', { auth: true });
      rows = Array.isArray(response) ? response
        : Array.isArray(response?.list) ? response.list
        : Array.isArray(response?.data) ? response.data
        : [];
    } catch {
      source = 'v2_assets';
      const response = await this.request('GET', '/capi/v2/account/assets', { auth: true });
      rows = Array.isArray(response) ? response
        : Array.isArray(response?.list) ? response.list
        : Array.isArray(response?.assets) ? response.assets
        : [];
    }

    const total: Record<string, number> = {};
    const free: Record<string, number> = {};
    const used: Record<string, number> = {};

    for (const item of rows) {
      // v3 balance: { asset, balance, availableBalance, frozen, unrealizePnl }
      // v2 assets:   { coinName, equity, available, frozen }
      const coin = String(item?.asset || item?.coinName || item?.coin || '').toUpperCase();
      if (!coin) {
        continue;
      }
      const wallet = Number(item?.balance ?? item?.equity ?? 0);
      const available = Number(
        item?.availableBalance ?? item?.available ?? item?.free ?? wallet,
      );
      const frozen = Number(item?.frozen ?? item?.used ?? 0);
      total[coin] = Number.isFinite(wallet) ? wallet : 0;
      free[coin] = Number.isFinite(available) ? available : total[coin];
      if (Number.isFinite(frozen) && frozen > 0) {
        used[coin] = frozen;
      }
    }

    return {
      total,
      free,
      used,
      info: { source, rows },
    };
  }

  async fetchPositions(symbols?: string[]): Promise<any[]> {
    const response = await this.request('GET', '/capi/v3/account/position/allPosition', { auth: true });
    const rows = Array.isArray(response) ? response : [];
    const requestedSymbols = new Set((Array.isArray(symbols) ? symbols : []).map((item) => toWeexPrivateSymbol(item)));
    const tickerMap = await this.getTickerMap().catch(() => ({} as Record<string, any>));

    return rows
      .map((item: any) => {
        const rawSymbol = toWeexPrivateSymbol(item?.symbol);
        if (!rawSymbol) {
          return null;
        }

        if (requestedSymbols.size > 0 && !requestedSymbols.has(rawSymbol)) {
          return null;
        }

        const size = Number(item?.size ?? 0);
        if (!Number.isFinite(size) || Math.abs(size) <= 0) {
          return null;
        }

        const ticker = tickerMap[toWeexCcxtSymbol(rawSymbol)];
        const entryPrice = firstPositiveNumber(
          item?.openPrice,
          item?.open_avg_price,
          item?.avgOpenPrice,
          // WEEX v3 uses camelCase openValue / cumOpenValue (not snake_case)
          Number(item?.openValue ?? 0) / Math.abs(size),
          Number(item?.cumOpenValue ?? 0) / Math.abs(size),
          Number(item?.open_value ?? 0) / Math.abs(size)
        ) ?? 0;
        const markPrice = firstPositiveNumber(
          item?.markPrice,
          item?.mark_price,
          item?.markPx,
          ticker?.last,
          entryPrice
        ) ?? entryPrice;
        const notional = firstPositiveNumber(
          item?.positionValue,
          item?.openValue,
          item?.cumOpenValue,
          item?.open_value,
          Math.abs(size) * markPrice
        ) ?? 0;

        return {
          symbol: toWeexCcxtSymbol(rawSymbol),
          side: String(item?.side || '').toUpperCase() === 'LONG' ? 'long' : 'short',
          contracts: Math.abs(size),
          entryPrice,
          markPrice,
          notional,
          leverage: firstPositiveNumber(item?.leverage) ?? 1,
          liquidationPrice: firstPositiveNumber(item?.liquidatePrice, item?.liquidationPrice) ?? undefined,
          unrealizedPnl: Number(item?.unrealizePnl ?? item?.unrealizedPnl ?? 0),
          info: {
            ...item,
            symbol: rawSymbol,
            markPrice,
          },
        };
      })
      .filter((item): item is any => Boolean(item));
  }

  async createOrder(symbol: string, type: string, side: string, amount: number, price?: number, params: any = {}): Promise<any> {
    const rawSymbol = toWeexPrivateSymbol(symbol);
    const sideUpper = String(side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const typeUpper = String(type || '').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
    const isReduceOnly = Boolean(params?.reduceOnly);
    const providedPositionSide = String(params?.positionSide || '').toUpperCase();
    const positionSide = providedPositionSide === 'LONG' || providedPositionSide === 'SHORT'
      ? providedPositionSide
      : sideUpper === 'BUY'
        ? (isReduceOnly ? 'SHORT' : 'LONG')
        : (isReduceOnly ? 'LONG' : 'SHORT');

    const markets = await this.loadMarkets().catch(() => ({} as Record<string, any>));
    const market = markets[toWeexCcxtSymbol(rawSymbol)] || markets[toWeexCcxtSymbol(symbol)];
    const amountStep = stepFromPrecisionField(market?.precision?.amount, 0.001);
    const priceStep = stepFromPrecisionField(market?.precision?.price, 0.0001);
    const minAmount = firstPositiveNumber(market?.limits?.amount?.min) ?? amountStep;
    let qty = Number(amount);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new Error(`WEEX invalid order quantity for ${rawSymbol}: ${amount}`);
    }
    qty = Number(formatToStep(qty, amountStep));
    if (qty < minAmount) {
      throw new Error(
        `WEEX order size ${qty} < min limit ${minAmount} for contract ${rawSymbol}`
      );
    }

    const body: Record<string, unknown> = {
      symbol: rawSymbol,
      side: sideUpper,
      positionSide,
      type: typeUpper,
      quantity: formatToStep(qty, amountStep),
      newClientOrderId: String(params?.newClientOrderId || `btdd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      reduceOnly: isReduceOnly || undefined,
    };

    let roundedPrice = price;
    if (typeUpper === 'LIMIT') {
      body.timeInForce = String(params?.timeInForce || 'GTC').toUpperCase();
      if (price !== undefined) {
        if (!Number.isFinite(price) || price <= 0) {
          throw new Error(`WEEX invalid limit price for ${rawSymbol}: ${price}`);
        }
        const priceStr = formatToStep(price, priceStep);
        roundedPrice = Number(priceStr);
        body.price = priceStr;
      }
    }

    const response = await this.request('POST', '/capi/v3/order', {
      auth: true,
      body,
    });

    if (response?.success === false || (response?.errorCode && String(response.errorCode) !== '0')) {
      throw new Error(`WEEX order rejected: ${response?.errorMessage || response?.errorCode || 'unknown error'}`);
    }

    return {
      id: String(response?.orderId || ''),
      clientOrderId: String(response?.clientOrderId || body.newClientOrderId || ''),
      symbol: toWeexCcxtSymbol(rawSymbol),
      side: sideUpper.toLowerCase(),
      type: typeUpper.toLowerCase(),
      amount: qty,
      price: roundedPrice,
      status: response?.success === false ? 'rejected' : 'open',
      reduceOnly: isReduceOnly,
      info: {
        ...response,
        symbol: rawSymbol,
        positionSide,
      },
    };
  }

  async fetchOrder(orderId: string): Promise<any> {
    const response = await this.request('GET', '/capi/v3/order', {
      auth: true,
      query: {
        orderId,
      },
    });

    return this.mapOrder(response);
  }

  async fetchOpenOrders(symbol?: string): Promise<any[]> {
    const response = await this.request('GET', '/capi/v3/openOrders', {
      auth: true,
      query: {
        symbol: symbol ? toWeexPrivateSymbol(symbol) : undefined,
        limit: 100,
        page: 0,
      },
    });

    const rows = Array.isArray(response) ? response : [];
    return rows.map((item: any) => this.mapOrder(item));
  }

  async cancelAllOrders(symbol?: string): Promise<any> {
    return this.request('DELETE', '/capi/v3/allOpenOrders', {
      auth: true,
      query: {
        symbol: symbol ? toWeexPrivateSymbol(symbol) : undefined,
      },
    });
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<any> {
    return this.request('DELETE', '/capi/v3/order', {
      auth: true,
      query: {
        orderId,
        symbol: symbol ? toWeexPrivateSymbol(symbol) : undefined,
      },
    });
  }

  async fetchMyTrades(
    symbol?: string,
    since?: number,
    limit = 100,
    params: { until?: number } = {},
  ): Promise<any[]> {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const privateSymbol = symbol ? toWeexPrivateSymbol(symbol) : undefined;
    const until = Number(params?.until);
    const queryBase: Record<string, WeexQueryValue> = {
      symbol: privateSymbol,
      startTime: since ? Math.floor(since) : undefined,
      endTime: Number.isFinite(until) && until > 0 ? Math.floor(until) : undefined,
      limit: safeLimit,
    };

    let response: any;
    try {
      response = await this.request('GET', '/capi/v3/userTrades', {
        auth: true,
        query: queryBase,
      });
    } catch (error) {
      // WEEX may reject certain symbol values (-1142); retry without symbol filter
      if (privateSymbol && String((error as Error)?.message || '').includes('-1142')) {
        response = await this.request('GET', '/capi/v3/userTrades', {
          auth: true,
          query: {
            startTime: queryBase.startTime,
            endTime: queryBase.endTime,
            limit: safeLimit,
          },
        });
      } else {
        throw error;
      }
    }

    const rows = Array.isArray(response) ? response : [];
    return rows.map((item: any) => ({
      id: String(item?.id || ''),
      order: String(item?.orderId || ''),
      symbol: toWeexCcxtSymbol(item?.symbol),
      side: String(item?.side || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
      amount: Number(item?.qty ?? 0),
      price: Number(item?.price ?? 0),
      cost: Number(item?.quoteQty ?? 0),
      fee: {
        cost: Number(item?.commission ?? 0),
        currency: String(item?.commissionAsset || 'USDT').toUpperCase(),
      },
      takerOrMaker: item?.maker ? 'maker' : 'taker',
      timestamp: Number(item?.time ?? 0),
      info: {
        ...item,
        symbol: toWeexPrivateSymbol(item?.symbol),
        realizedPnl: item?.realizedPnl ?? item?.realizedProfit ?? item?.closedPnl,
      },
    }));
  }

  /**
   * Contract account income / bills. Response items include running `balance`
   * (wallet after event) — suitable for equity backfill like Bybit tx log.
   * Windows up to ~100 days; paginate via nextKey when hasNextPage.
   */
  async fetchAccountIncome(options: {
    startTime?: number;
    endTime?: number;
    limit?: number;
    nextKeyId?: number | string;
    nextKeyTime?: number | string;
    incomeType?: string;
  } = {}): Promise<{
    items: Array<Record<string, unknown>>;
    hasNextPage: boolean;
    nextKeyId?: string;
    nextKeyTime?: string;
  }> {
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 100));
    const body: Record<string, unknown> = { limit };
    if (Number.isFinite(Number(options.startTime)) && Number(options.startTime) > 0) {
      body.startTime = Math.floor(Number(options.startTime));
    }
    if (Number.isFinite(Number(options.endTime)) && Number(options.endTime) > 0) {
      body.endTime = Math.floor(Number(options.endTime));
    }
    if (options.incomeType) {
      body.incomeType = String(options.incomeType);
    }
    if (options.nextKeyId != null && options.nextKeyTime != null) {
      body.nextKeyId = options.nextKeyId;
      body.nextKeyTime = options.nextKeyTime;
    }

    const response = await this.request('POST', '/capi/v3/account/income', {
      auth: true,
      body,
    });

    const items = Array.isArray(response?.items)
      ? response.items
      : Array.isArray(response)
        ? response
        : [];
    const nextKey = response?.nextKey || {};
    return {
      items,
      hasNextPage: Boolean(response?.hasNextPage),
      nextKeyId: nextKey?.nextKeyId != null ? String(nextKey.nextKeyId) : undefined,
      nextKeyTime: nextKey?.nextKeyTime != null ? String(nextKey.nextKeyTime) : undefined,
    };
  }

  async setLeverage(leverage: number, symbol?: string, params: any = {}): Promise<any> {
    const rawSymbol = symbol ? toWeexPrivateSymbol(symbol) : undefined;
    const leverageStr = String(Math.max(1, Math.round(leverage)));
    const marginMode = String(params?.marginMode || params?.holdSide || '').toLowerCase();
    const body: Record<string, unknown> = { symbol: rawSymbol };

    if (marginMode === 'isolated') {
      body.marginType = 'ISOLATED';
      body.isolatedLongLeverage = leverageStr;
      body.isolatedShortLeverage = leverageStr;
    } else {
      body.marginType = 'CROSSED';
      body.crossLeverage = leverageStr;
    }

    const response = await this.request('POST', '/capi/v3/account/leverage', {
      auth: true,
      body,
    });

    return response;
  }

  async setMarginMode(marginMode: string, symbol?: string): Promise<any> {
    const rawSymbol = symbol ? toWeexPrivateSymbol(symbol) : undefined;
    const marginType = String(marginMode || '').toLowerCase() === 'isolated' ? 'ISOLATED' : 'CROSSED';
    const response = await this.request('POST', '/capi/v3/account/marginType', {
      auth: true,
      body: {
        symbol: rawSymbol,
        marginType,
      },
    });

    return response;
  }
}

export const createWeexClient = (apiKey: ApiKey): any => {
  return new WeexRestClient({
    apiKey: apiKey.api_key,
    secret: apiKey.secret,
    passphrase: apiKey.passphrase,
  });
};

/** Public allowlist of symbols WEEX accepts for API orders (~337). Distinct from exchangeInfo listing. */
const WEEX_API_TRADING_TTL_MS = 30 * 60 * 1000;
let weexApiTradingCache: { symbols: Set<string>; fetchedAt: number } | null = null;
let weexApiTradingInflight: Promise<Set<string>> | null = null;

const collectWeexSymbolKeys = (payload: unknown): Set<string> => {
  const out = new Set<string>();
  const walk = (value: unknown, depth = 0): void => {
    if (value == null || depth > 6) return;
    if (typeof value === 'string') {
      const key = toWeexPrivateSymbol(value);
      if (key.endsWith('USDT') && key.length >= 6 && key.length <= 24) {
        out.add(key);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      const row = value as Record<string, unknown>;
      const base = row.baseCoin ?? row.baseAsset;
      const quote = row.quoteCoin ?? row.quoteAsset;
      if (base && quote) {
        const key = toWeexPrivateSymbol(`${base}${quote}`);
        if (key) out.add(key);
      }
      if (row.symbol != null) walk(String(row.symbol), depth + 1);
      for (const nested of Object.values(row)) walk(nested, depth + 1);
    }
  };
  walk(payload);
  return out;
};

/**
 * Fetch WEEX `/capi/v3/market/apiTradingSymbols` (public).
 * This is the real order allowlist; `exchangeInfo` / ccxt loadMarkets is much wider and causes -1058.
 */
export const getWeexApiTradingSymbols = async (forceRefresh = false): Promise<Set<string>> => {
  const now = Date.now();
  if (
    !forceRefresh
    && weexApiTradingCache
    && now - weexApiTradingCache.fetchedAt < WEEX_API_TRADING_TTL_MS
    && weexApiTradingCache.symbols.size > 0
  ) {
    return weexApiTradingCache.symbols;
  }
  if (!forceRefresh && weexApiTradingInflight) {
    return weexApiTradingInflight;
  }

  weexApiTradingInflight = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(`${WEEX_API_BASE}/capi/v3/market/apiTradingSymbols`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'btdd' },
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok) {
        throw new Error(`WEEX apiTradingSymbols failed (${response.status}): ${text.slice(0, 200)}`);
      }
      // Endpoint may return a bare string[] or { data: ... }.
      const data = payload && typeof payload === 'object' && !Array.isArray(payload) && 'data' in (payload as any)
        ? (payload as any).data
        : payload;
      const symbols = collectWeexSymbolKeys(data);
      if (symbols.size === 0) {
        throw new Error('WEEX apiTradingSymbols returned empty set');
      }
      weexApiTradingCache = { symbols, fetchedAt: Date.now() };
      return symbols;
    } finally {
      clearTimeout(timeoutId);
      weexApiTradingInflight = null;
    }
  })();

  return weexApiTradingInflight;
};

export const isWeexApiTradableSymbol = async (symbol: string): Promise<boolean> => {
  const key = toWeexPrivateSymbol(symbol);
  if (!key) return false;
  try {
    const allow = await getWeexApiTradingSymbols();
    return allow.has(key);
  } catch {
    // Fail-open only when the public endpoint is down — avoid blocking all WEEX trading.
    return true;
  }
};

export type WeexAllowlistSnapshot =
  | { ok: true; symbols: Set<string> }
  | { ok: false; error: string };

/** For delist watchdog — never fail-open; reject undersized/truncated lists. */
export const getWeexApiTradingSymbolsStrict = async (
  forceRefresh = true,
  minSize = 50,
): Promise<WeexAllowlistSnapshot> => {
  try {
    const symbols = await getWeexApiTradingSymbols(forceRefresh);
    if (symbols.size < minSize) {
      return { ok: false, error: `allowlist too small (${symbols.size} < ${minSize})` };
    }
    return { ok: true, symbols };
  } catch (error) {
    return { ok: false, error: (error as Error).message || String(error) };
  }
};

export const toWeexOrderSymbol = toWeexPrivateSymbol;
