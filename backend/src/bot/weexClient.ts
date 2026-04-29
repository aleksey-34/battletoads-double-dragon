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

const mapWeexTimeframe = (timeframe: string): string => {
  const normalized = String(timeframe || '').trim();
  const supported = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w']);
  return supported.has(normalized) ? normalized : '1m';
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

    const response = await fetch(url, {
      method,
      headers,
      body: hasBody ? bodyString : undefined,
    });

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
      const pricePrecision = firstPositiveNumber(item?.pricePrecision, item?.pricePlace, 0.1) ?? 0.1;
      // WEEX stepSize may come as explicit field, or as sizeMultiplier, or as
      // contractSize. quantityPrecision is decimal-places count (0 = integer),
      // NOT the step itself.  Derive step from explicit fields first.
      const explicitStep = firstPositiveNumber(item?.stepSize, item?.sizeMultiplier, item?.volumeStep, item?.contractSize);
      const decimalPlacesStep = (() => {
        const dp = Number(item?.quantityPrecision ?? item?.baseAssetPrecision);
        return Number.isFinite(dp) && dp >= 0 ? Math.pow(10, -dp) : null;
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
    const response = await this.request('GET', '/capi/v3/market/klines', {
      query: {
        symbol: toWeexPrivateSymbol(symbol),
        interval: mapWeexTimeframe(timeframe),
        limit: Math.max(1, Math.min(Number(limit) || 100, 1000)),
      },
    });

    const rows = Array.isArray(response) ? response : [];

    return rows
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
  }

  async fetchBalance(): Promise<any> {
    const response = await this.request('GET', '/capi/v3/account/assets', { auth: true });
    const rows = Array.isArray(response) ? response : [];
    const total: Record<string, number> = {};
    const free: Record<string, number> = {};

    for (const item of rows) {
      // v3: { asset, balance, available, frozen }; v2 fallback: { coinName, equity, available }
      const coin = String(item?.asset || item?.coinName || item?.coin || '').toUpperCase();
      if (!coin) {
        continue;
      }
      total[coin] = Number(item?.balance ?? item?.equity ?? 0);
      free[coin] = Number(item?.available ?? item?.free ?? 0);
    }

    return {
      total,
      free,
      info: rows,
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

    const body: Record<string, unknown> = {
      symbol: rawSymbol,
      side: sideUpper,
      positionSide,
      type: typeUpper,
      quantity: String(amount),
      newClientOrderId: String(params?.newClientOrderId || `btdd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      reduceOnly: isReduceOnly || undefined,
    };

    if (typeUpper === 'LIMIT') {
      body.timeInForce = String(params?.timeInForce || 'GTC').toUpperCase();
      if (price !== undefined) {
        body.price = String(price);
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
      amount,
      price,
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

  async fetchMyTrades(symbol?: string, since?: number, limit = 100): Promise<any[]> {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 100));
    const privateSymbol = symbol ? toWeexPrivateSymbol(symbol) : undefined;

    let response: any;
    try {
      response = await this.request('GET', '/capi/v3/userTrades', {
        auth: true,
        query: {
          symbol: privateSymbol,
          startTime: since ? Math.floor(since) : undefined,
          limit: safeLimit,
        },
      });
    } catch (error) {
      // WEEX may reject certain symbol values (-1142); retry without symbol filter
      if (privateSymbol && String((error as Error)?.message || '').includes('-1142')) {
        response = await this.request('GET', '/capi/v3/userTrades', {
          auth: true,
          query: {
            startTime: since ? Math.floor(since) : undefined,
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
      },
    }));
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
