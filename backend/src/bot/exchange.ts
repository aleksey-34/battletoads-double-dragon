import { RestClientV5 } from 'bybit-api';
import Bottleneck from 'bottleneck';
import logger from '../utils/logger';
import { ApiKey } from '../config/settings';
import { db } from '../utils/database';

type ExchangeClientEntry = {
  client: RestClientV5;
  demoClient?: RestClientV5;
  limiter: Bottleneck;
  preferDemo: boolean;
};

type CcxtClientEntry = {
  exchange: 'bitget' | 'bingx';
  client: any;
  limiter: Bottleneck;
  symbolMap: Map<string, string>;
};

type NormalizedBalance = {
  coin: string;
  walletBalance: string;
  availableBalance: string;
  usdValue: string;
  accountType: string;
};

type OrderOptions = {
  reduceOnly?: boolean;
};

type MarketDataOptions = {
  startMs?: number;
  endMs?: number;
};

type NormalizedTrade = {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: string;
  price: string;
  notional: string;
  fee: string;
  feeCurrency: string;
  realizedPnl: string;
  isMaker: boolean;
  timestamp: string;
};

const clients: { [key: string]: ExchangeClientEntry } = {};
const ccxtClients: { [key: string]: CcxtClientEntry } = {};
const cache = new Map<string, { data: any; timestamp: number }>();
const bingxOneWayAttempted = new Set<string>();
const CACHE_TTL = 5 * 60 * 1000; // 5 min

const normalizeSymbolKey = (value: any): string => {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
};

const toUiSymbol = (value: any): string => {
  const raw = String(value || '').toUpperCase();
  const beforeColon = raw.split(':')[0];
  const withoutSlash = beforeColon.replace('/', '');
  return withoutSlash.replace(/[^A-Z0-9]/g, '');
};

const detectExchange = (exchange: string): 'bybit' | 'bitget' | 'bingx' => {
  const normalized = String(exchange || '').trim().toLowerCase();

  if (normalized.includes('bitget')) {
    return 'bitget';
  }

  if (normalized.includes('bingx') || normalized.includes('bing x')) {
    return 'bingx';
  }

  return 'bybit';
};

const intervalToMs = (interval: string): number => {
  const value = String(interval || '').trim();

  if (value.endsWith('m')) {
    const minutes = Number.parseInt(value.replace('m', ''), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  }

  if (value.endsWith('h')) {
    const hours = Number.parseInt(value.replace('h', ''), 10);
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  if (value === '1d') {
    return 24 * 60 * 60 * 1000;
  }

  if (value === '1w') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (value === '1M') {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
};

const loadCcxtModule = (): any => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('ccxt');
};

export const ensureExchangeClientInitialized = async (apiKeyName: string): Promise<void> => {
  const name = String(apiKeyName || '').trim();
  if (!name) {
    return;
  }

  if (clients[name]?.client || ccxtClients[name]?.client) {
    return;
  }

  const row = await db.get('SELECT * FROM api_keys WHERE name = ?', [name]);
  if (!row) {
    return;
  }

  initExchangeClient(row as ApiKey);
  logger.info(`Lazy-initialized exchange client for key: ${name}`);
};

const getCcxtClientEntry = (apiKeyName: string): CcxtClientEntry => {
  const entry = ccxtClients[apiKeyName];
  if (!entry?.client) {
    throw new Error(`CCXT client not initialized for key: ${apiKeyName}`);
  }
  return entry;
};

const ensureCcxtSymbolMap = async (entry: CcxtClientEntry): Promise<Map<string, string>> => {
  if (entry.symbolMap.size > 0) {
    return entry.symbolMap;
  }

  const markets = await entry.limiter.schedule(() => entry.client.loadMarkets());
  const values = Object.values(markets || {}) as any[];

  for (const market of values) {
    const symbol = String(market?.symbol || '');
    const id = String(market?.id || '');

    const normalizedSymbol = normalizeSymbolKey(symbol);
    const normalizedId = normalizeSymbolKey(id);

    if (normalizedSymbol) {
      entry.symbolMap.set(normalizedSymbol, symbol);
    }

    if (normalizedId) {
      entry.symbolMap.set(normalizedId, symbol);
    }
  }

  return entry.symbolMap;
};

const resolveCcxtSymbol = async (entry: CcxtClientEntry, symbol: string): Promise<string> => {
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized) {
    return symbol;
  }

  const symbolMap = await ensureCcxtSymbolMap(entry);
  return symbolMap.get(normalized) || symbol;
};

const getBingxPositionSide = (side: 'Buy' | 'Sell'): 'LONG' | 'SHORT' => {
  return side === 'Buy' ? 'LONG' : 'SHORT';
};

const getBingxPositionSideCandidates = (
  side: 'Buy' | 'Sell',
  reduceOnly?: boolean
): Array<'BOTH' | 'LONG' | 'SHORT' | undefined> => {
  const directional = getBingxPositionSide(side);

  if (reduceOnly) {
    // In one-way mode BingX requires BOTH. In hedge mode LONG/SHORT can be required.
    return ['BOTH', undefined, directional];
  }

  return [directional, 'BOTH', undefined];
};

const isBingxPositionSideError = (error: unknown): boolean => {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return message.includes('positionside') || message.includes('position side') || message.includes('109400') || message.includes('both');
};

const tryEnsureBingxOneWayMode = async (
  apiKeyName: string,
  entry: CcxtClientEntry,
  ccxtSymbol: string
): Promise<void> => {
  if (entry.exchange !== 'bingx') {
    return;
  }

  const lockKey = `${apiKeyName}:${ccxtSymbol}`;
  if (bingxOneWayAttempted.has(lockKey)) {
    return;
  }
  bingxOneWayAttempted.add(lockKey);

  try {
    if (typeof entry.client.fetchPositions !== 'function') {
      return;
    }

    const positionsRaw = await entry.limiter.schedule(() => entry.client.fetchPositions([ccxtSymbol]));
    const hasOpenPosition = Array.isArray(positionsRaw) && positionsRaw.some((position: any) => {
      const size = Number(position?.contracts ?? position?.info?.positionAmt ?? position?.info?.size ?? 0);
      return Number.isFinite(size) && Math.abs(size) > 0;
    });

    if (hasOpenPosition) {
      return;
    }

    if (typeof entry.client.setPositionMode === 'function') {
      await entry.limiter.schedule(() => entry.client.setPositionMode(false, ccxtSymbol));
      logger.info(`BingX one-way mode enabled for ${apiKeyName} ${ccxtSymbol}`);
    }
  } catch (error) {
    const err = error as Error;
    logger.warn(`BingX one-way mode switch skipped for ${apiKeyName} ${ccxtSymbol}: ${err.message}`);
  }
};

const isBybitSuccess = (response: any): boolean => {
  return response?.retCode === 0 || response?.retCode === undefined;
};

const formatBybitError = (response: any, context: string): Error => {
  if (response?.retCode !== undefined) {
    return new Error(`Bybit error (${context}): ${response.retMsg || `code ${response.retCode}`}`);
  }
  return new Error(`Bybit error (${context}): unknown response`);
};

const shouldFallbackToDemo = (value: any): boolean => {
  const retCode = Number(value?.retCode);
  const message = String(value?.retMsg ?? value?.message ?? '');
  return retCode === 10003 || /api key is invalid/i.test(message);
};

const callPrivateWithDemoFallback = async <T>(
  apiKeyName: string,
  operation: string,
  requestFn: (client: RestClientV5) => Promise<T>
): Promise<T> => {
  const entry = getClientEntry(apiKeyName);
  const execute = async (client: RestClientV5) => entry.limiter.schedule(() => requestFn(client));

  const primaryClient = entry.preferDemo && entry.demoClient ? entry.demoClient : entry.client;

  try {
    const primaryResponse: any = await execute(primaryClient);
    if (isBybitSuccess(primaryResponse)) {
      return primaryResponse;
    }

    if (!entry.preferDemo && entry.demoClient && shouldFallbackToDemo(primaryResponse)) {
      const demoResponse: any = await execute(entry.demoClient);
      if (isBybitSuccess(demoResponse)) {
        entry.preferDemo = true;
        logger.warn(`Switched ${apiKeyName} to demo trading endpoint for ${operation}`);
      }
      return demoResponse;
    }

    return primaryResponse;
  } catch (error) {
    if (!entry.preferDemo && entry.demoClient && shouldFallbackToDemo(error)) {
      const demoResponse: any = await execute(entry.demoClient);
      if (isBybitSuccess(demoResponse)) {
        entry.preferDemo = true;
        logger.warn(`Switched ${apiKeyName} to demo trading endpoint for ${operation} after exception`);
        return demoResponse;
      }
      throw formatBybitError(demoResponse, operation);
    }
    throw error;
  }
};

const getClientEntry = (apiKeyName: string): ExchangeClientEntry => {
  const entry = clients[apiKeyName];
  if (!entry?.client) {
    throw new Error(`Client not initialized for key: ${apiKeyName}`);
  }
  return entry;
};

export const initExchangeClient = (apiKey: ApiKey) => {
  logger.info(`Initializing client for key: ${apiKey.name}`);
  const speedLimit = Math.max(1, Number(apiKey.speed_limit) || 10);
  const limiter = new Bottleneck({
    minTime: 1000 / speedLimit, // requests per second
  });

  const exchange = detectExchange(apiKey.exchange);

  if (exchange !== 'bybit') {
    const ccxt = loadCcxtModule();
    const ExchangeClass = exchange === 'bitget' ? ccxt.bitget : ccxt.bingx;

    if (!ExchangeClass) {
      throw new Error(`Exchange ${exchange} is not available in ccxt`);
    }

    const client = new ExchangeClass({
      apiKey: apiKey.api_key,
      secret: apiKey.secret,
      password: apiKey.passphrase || undefined,
      enableRateLimit: true,
      options: {
        defaultType: 'swap',
      },
    });

    if (apiKey.testnet && typeof client.setSandboxMode === 'function') {
      client.setSandboxMode(true);
    }

    ccxtClients[apiKey.name] = {
      exchange,
      client,
      limiter,
      symbolMap: new Map<string, string>(),
    };

    delete clients[apiKey.name];

    logger.info(`Client initialized for key: ${apiKey.name}, exchange=${exchange}`);
    return;
  }

  const testnet = Boolean(apiKey.testnet);
  const demo = Boolean(apiKey.demo);

  const client = new RestClientV5({
    key: apiKey.api_key,
    secret: apiKey.secret,
    testnet,
    demoTrading: demo,
  });

  const demoClient = !testnet && !demo
    ? new RestClientV5({
      key: apiKey.api_key,
      secret: apiKey.secret,
      testnet: false,
      demoTrading: true,
    })
    : undefined;

  clients[apiKey.name] = {
    client,
    demoClient,
    limiter,
    preferDemo: demo,
  };

  delete ccxtClients[apiKey.name];

  logger.info(`Client initialized for key: ${apiKey.name}, testnet=${testnet}, demo=${demo}`);
};

export const removeExchangeClient = (apiKeyName: string) => {
  if (clients[apiKeyName]) {
    delete clients[apiKeyName];
    logger.info(`Client removed for key: ${apiKeyName}`);
  }

  if (ccxtClients[apiKeyName]) {
    delete ccxtClients[apiKeyName];
    logger.info(`CCXT client removed for key: ${apiKeyName}`);
  }
};

// Получить все доступные торговые пары (symbols) с Bybit
export const getAllSymbols = async (apiKeyName: string) => {
  const cacheKey = `symbols_${apiKeyName}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const markets = await entry.limiter.schedule(() => entry.client.loadMarkets());
      const list = Object.values(markets || {}) as any[];

      const symbols = list
        .filter((market) => {
          const isContract = market?.contract === true || market?.swap === true || market?.future === true;
          const isActive = market?.active !== false;
          return isContract && isActive;
        })
        .map((market) => toUiSymbol(market?.id || market?.symbol))
        .filter((symbol) => Boolean(symbol));

      const sorted = Array.from(new Set(symbols)).sort();
      cache.set(cacheKey, { data: sorted, timestamp: Date.now() });
      return sorted;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error fetching all symbols for ${apiKeyName} (ccxt): ${err.message}`);
      throw error;
    }
  }

  const { client, limiter } = getClientEntry(apiKeyName);
  const symbols = new Set<string>();
  let cursor: string | undefined;

  try {
    // Bybit returns paginated symbols list; pull all pages to populate selector fully.
    for (let page = 0; page < 20; page++) {
      const data = await limiter.schedule(() =>
        client.getInstrumentsInfo({
          category: 'linear',
          limit: 1000,
          cursor,
        } as any)
      );

      if (data?.retCode && data.retCode !== 0) {
        throw new Error(data.retMsg || `Bybit symbols error code: ${data.retCode}`);
      }

      const list = Array.isArray(data?.result?.list) ? data.result.list : [];
      list.forEach((item: any) => {
        if (item?.symbol) {
          symbols.add(String(item.symbol).toUpperCase());
        }
      });

      const nextCursor = data?.result?.nextPageCursor;
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }

    const sorted = Array.from(symbols).sort();
    cache.set(cacheKey, { data: sorted, timestamp: Date.now() });
    return sorted;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching all symbols for ${apiKeyName}: ${err.message}`);
    throw error;
  }
};

export const getMarketData = async (
  apiKeyName: string,
  symbol: string,
  interval: string,
  limit: number = 100,
  options?: MarketDataOptions
) => {
  logger.info(`Fetching market data for ${apiKeyName}, symbol: ${symbol}, interval: ${interval}, limit: ${limit}`);
  if (!apiKeyName || !symbol || !interval) {
    throw new Error('Missing required parameters: apiKeyName, symbol, interval');
  }

  const intervalMs = intervalToMs(interval);
  const startMs = Number.isFinite(Number(options?.startMs)) ? Number(options?.startMs) : undefined;
  const endMs = Number.isFinite(Number(options?.endMs)) ? Number(options?.endMs) : undefined;
  const hasRange = startMs !== undefined || endMs !== undefined;

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);
    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const safeLimit = Math.max(1, Math.min(hasRange ? 50000 : 1000, requestedLimit));

    try {
      if (!hasRange) {
        const candles = await entry.limiter.schedule(() =>
          entry.client.fetchOHLCV(ccxtSymbol, interval, undefined, safeLimit)
        );

        const normalized = Array.isArray(candles)
          ? candles
            .filter((candle: any) => Array.isArray(candle) && candle.length >= 5)
            .map((candle: any[]) => [
              candle[0],
              candle[1],
              candle[2],
              candle[3],
              candle[4],
              candle[5] || 0,
            ])
          : [];

        logger.info(`Fetched market data for ${symbol} via ccxt, received ${normalized.length} candles`);
        return normalized;
      }

      const effectiveEnd = endMs !== undefined ? endMs : Date.now();
      const effectiveStart = startMs !== undefined
        ? startMs
        : Math.max(0, effectiveEnd - intervalMs * safeLimit);

      const byTime = new Map<number, any[]>();
      const pageLimit = 1000;
      const maxPages = Math.max(1, Math.ceil((effectiveEnd - effectiveStart) / Math.max(intervalMs, 1) / pageLimit) + 5);
      let since = effectiveStart;

      for (let page = 0; page < maxPages; page += 1) {
        const candles = await entry.limiter.schedule(() =>
          entry.client.fetchOHLCV(ccxtSymbol, interval, since, pageLimit)
        );

        const list = Array.isArray(candles) ? candles : [];
        if (list.length === 0) {
          break;
        }

        let lastTs = -1;
        for (const candle of list) {
          if (!Array.isArray(candle) || candle.length < 5) {
            continue;
          }

          const ts = Number(candle[0]);
          if (!Number.isFinite(ts)) {
            continue;
          }

          lastTs = Math.max(lastTs, ts);

          if (ts < effectiveStart || ts > effectiveEnd) {
            continue;
          }

          if (!byTime.has(ts)) {
            byTime.set(ts, [
              candle[0],
              candle[1],
              candle[2],
              candle[3],
              candle[4],
              candle[5] || 0,
            ]);
          }
        }

        if (!Number.isFinite(lastTs) || lastTs < 0) {
          break;
        }

        const nextSince = lastTs + intervalMs;
        if (nextSince <= since) {
          break;
        }

        since = nextSince;
        if (since > effectiveEnd) {
          break;
        }
      }

      const normalized = Array.from(byTime.entries())
        .sort((left, right) => left[0] - right[0])
        .map((entryItem) => entryItem[1]);

      logger.info(`Fetched ranged market data for ${symbol} via ccxt, received ${normalized.length} candles`);
      return normalized;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error fetching market data for ${symbol} via ccxt: ${err.message}`);
      throw error;
    }
  }

  const { client, limiter } = getClientEntry(apiKeyName);
  // Convert interval to Bybit format
  const bybitInterval = interval.replace('m', '').replace('h', '').replace('d', 'D').replace('w', 'W').replace('M', 'M');
  // For hours, multiply by 60
  let finalInterval = bybitInterval;
  if (interval.endsWith('h')) {
    finalInterval = (parseInt(bybitInterval, 10) * 60).toString();
  }
  logger.info(`Converted interval ${interval} to ${finalInterval}`);
  try {
    if (!hasRange) {
      const data = await limiter.schedule(() =>
        client.getKline({
          category: 'linear',
          symbol: symbol.toUpperCase(),
          interval: finalInterval as any, // Bybit API accepts string
          limit,
        })
      );

      if (!isBybitSuccess(data)) {
        throw formatBybitError(data, `market data ${symbol}`);
      }

      const candles = Array.isArray(data?.result?.list) ? data.result.list : [];
      logger.info(`Fetched market data for ${symbol}, received ${candles.length} candles`);
      return candles;
    }

    const requestedLimit = Number.isFinite(limit) ? Math.floor(limit) : 100;
    const safeLimit = Math.max(1, Math.min(50000, requestedLimit));
    const effectiveEnd = endMs !== undefined ? endMs : Date.now();
    const effectiveStart = startMs !== undefined
      ? startMs
      : Math.max(0, effectiveEnd - intervalMs * safeLimit);

    const byTime = new Map<number, any[]>();
    let windowEnd = effectiveEnd;

    for (let page = 0; page < 400; page += 1) {
      const data = await limiter.schedule(() =>
        client.getKline({
          category: 'linear',
          symbol: symbol.toUpperCase(),
          interval: finalInterval as any,
          limit: 1000,
          start: effectiveStart,
          end: windowEnd,
        } as any)
      );

      if (!isBybitSuccess(data)) {
        throw formatBybitError(data, `market data ${symbol}`);
      }

      const list = Array.isArray(data?.result?.list) ? data.result.list : [];
      if (list.length === 0) {
        break;
      }

      let oldestTs = Number.POSITIVE_INFINITY;

      for (const candle of list) {
        if (!Array.isArray(candle) || candle.length < 5) {
          continue;
        }

        const ts = Number(candle[0]);
        if (!Number.isFinite(ts)) {
          continue;
        }

        oldestTs = Math.min(oldestTs, ts);

        if (ts < effectiveStart || ts > effectiveEnd) {
          continue;
        }

        if (!byTime.has(ts)) {
          byTime.set(ts, candle);
        }
      }

      if (!Number.isFinite(oldestTs) || oldestTs <= effectiveStart) {
        break;
      }

      if (oldestTs >= windowEnd) {
        break;
      }

      windowEnd = oldestTs - 1;
      if (windowEnd < effectiveStart) {
        break;
      }
    }

    const candles = Array.from(byTime.entries())
      .sort((left, right) => right[0] - left[0])
      .map((entryItem) => entryItem[1]);

    logger.info(`Fetched ranged market data for ${symbol}, received ${candles.length} candles`);
    return candles;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching market data for ${symbol}: ${err.message}`);
    throw error;
  }
};

export const placeOrder = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price?: string,
  options?: OrderOptions
) => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);
    const amount = Number.parseFloat(String(qty || '0'));
    const numericPrice = price !== undefined ? Number.parseFloat(String(price)) : undefined;

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid qty for order: ${qty}`);
    }

    const orderType = numericPrice && numericPrice > 0 ? 'limit' : 'market';

    try {
      await tryEnsureBingxOneWayMode(apiKeyName, entry, ccxtSymbol);

      const submitOrderAttempt = async (positionSide?: 'BOTH' | 'LONG' | 'SHORT') => {
        const params: any = {};
        if (entry.exchange === 'bingx' && positionSide) {
          params.positionSide = positionSide;
        }
        if (options?.reduceOnly) {
          params.reduceOnly = true;
          params.closePosition = true;
        }

        return entry.limiter.schedule(() =>
          entry.client.createOrder(
            ccxtSymbol,
            orderType,
            side === 'Buy' ? 'buy' : 'sell',
            amount,
            orderType === 'limit' ? numericPrice : undefined,
            params
          )
        );
      };

      if (entry.exchange !== 'bingx') {
        const order = await submitOrderAttempt();
        logger.info(`Placed ccxt order: ${side} ${qty} ${symbol}`);
        return order;
      }

      let lastError: Error | null = null;
      for (const candidateSide of getBingxPositionSideCandidates(side, options?.reduceOnly)) {
        try {
          const order = await submitOrderAttempt(candidateSide);
          logger.info(
            `Placed BingX ccxt order: ${side} ${qty} ${symbol} (positionSide=${candidateSide || 'omitted'})`
          );
          return order;
        } catch (error) {
          lastError = error as Error;
          if (!isBingxPositionSideError(error)) {
            throw error;
          }
          logger.warn(
            `BingX order retry for ${apiKeyName} ${symbol}: positionSide=${candidateSide || 'omitted'} failed (${lastError.message})`
          );
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error(`Failed to place BingX order for ${symbol}`);

    } catch (error) {
      const err = error as Error;
      logger.error(`Error placing ccxt order: ${err.message}`);
      throw error;
    }
  }

  try {
    const order: any = await callPrivateWithDemoFallback(apiKeyName, 'submitOrder', (client) =>
      client.submitOrder({
        category: 'linear',
        symbol: symbol.toUpperCase(),
        side,
        orderType: price ? 'Limit' : 'Market',
        qty,
        price,
        reduceOnly: options?.reduceOnly ? true : undefined,
      })
    );

    if (!isBybitSuccess(order)) {
      throw formatBybitError(order, 'submitOrder');
    }

    logger.info(`Placed order: ${side} ${qty} ${symbol}`);
    return order.result;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error placing order: ${err.message}`);
    throw error;
  }
};

export const getOrderStatus = async (apiKeyName: string, orderId: string) => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      if (typeof entry.client.fetchOrder === 'function') {
        return await entry.limiter.schedule(() => entry.client.fetchOrder(orderId));
      }

      const openOrders = await entry.limiter.schedule(() => entry.client.fetchOpenOrders());
      const matched = (Array.isArray(openOrders) ? openOrders : []).find((order: any) => String(order?.id || '') === String(orderId));
      if (matched) {
        return matched;
      }

      throw new Error(`Order not found: ${orderId}`);
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting ccxt order status: ${err.message}`);
      throw error;
    }
  }

  try {
    const status: any = await callPrivateWithDemoFallback(apiKeyName, 'getOrderHistory', (client) =>
      (client as any).getOrderHistory({
        category: 'linear',
        orderId,
      })
    );

    if (!isBybitSuccess(status)) {
      throw formatBybitError(status, 'getOrderHistory');
    }

    return status.result.list[0];
  } catch (error) {
    const err = error as Error;
    logger.error(`Error getting order status: ${err.message}`);
    throw error;
  }
};

export const getBalances = async (apiKeyName: string) => {
  logger.info(`Fetching balances for ${apiKeyName}`);

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const payload: any = await entry.limiter.schedule(() => entry.client.fetchBalance());
      const total = payload?.total || {};
      const free = payload?.free || {};

      const balances: NormalizedBalance[] = Object.keys(total)
        .map((coin) => {
          const walletValue = Number(total[coin] ?? 0);
          const freeValue = Number(free[coin] ?? walletValue ?? 0);

          if (!Number.isFinite(walletValue) || walletValue <= 0) {
            return null;
          }

          const stable = ['USDT', 'USDC', 'USD'].includes(String(coin).toUpperCase());

          return {
            coin: String(coin).toUpperCase(),
            walletBalance: String(walletValue),
            availableBalance: String(Number.isFinite(freeValue) ? freeValue : walletValue),
            usdValue: stable ? String(walletValue) : '0',
            accountType: 'swap',
          };
        })
        .filter((item): item is NormalizedBalance => !!item);

      return balances;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting balances via ccxt for ${apiKeyName}: ${err.message}`);
      throw error;
    }
  }

  const accountTypes = ['UNIFIED', 'SPOT', 'CONTRACT', 'FUND', 'OPTION'];
  let hadSuccessfulResponse = false;
  let firstApiError: Error | null = null;
  let lastTransportError: Error | null = null;

  const normalizeBalances = (response: any, accountType: string): NormalizedBalance[] => {
    const accountList = Array.isArray(response?.result?.list) ? response.result.list : [];
    const flattened: NormalizedBalance[] = [];

    for (const account of accountList) {
      const coins = Array.isArray(account?.coin) ? account.coin : [];
      for (const coin of coins) {
        const walletBalanceRaw = String(coin?.walletBalance ?? '0');
        const availableBalanceRaw = String(
          coin?.availableToWithdraw || coin?.availableBalance || coin?.free || coin?.walletBalance || '0'
        );
        const usdValueRaw = String(coin?.usdValue ?? coin?.equity ?? '0');

        const walletBalance = Number.parseFloat(walletBalanceRaw);
        const availableBalance = Number.parseFloat(availableBalanceRaw);
        const usdValue = Number.parseFloat(usdValueRaw);

        if (
          Number.isFinite(walletBalance) &&
          Number.isFinite(availableBalance) &&
          Number.isFinite(usdValue) &&
          walletBalance <= 0 &&
          availableBalance <= 0 &&
          usdValue <= 0
        ) {
          continue;
        }

        if (!coin?.coin) {
          continue;
        }

        flattened.push({
          coin: String(coin.coin),
          walletBalance: walletBalanceRaw,
          availableBalance: availableBalanceRaw,
          usdValue: usdValueRaw,
          accountType,
        });
      }
    }

    return flattened;
  };

  for (const type of accountTypes) {
    try {
      logger.info(`Trying getWalletBalance with accountType: ${type}`);
      const balancesResponse: any = await callPrivateWithDemoFallback(apiKeyName, `getWalletBalance:${type}`, (client) =>
        client.getWalletBalance({
          accountType: type as any,
        })
      );

      if (balancesResponse?.retCode && balancesResponse.retCode !== 0) {
        const apiError = new Error(
          `Bybit error (${type}): ${balancesResponse.retMsg || `code ${balancesResponse.retCode}`}`
        );
        logger.warn(`Balances API warning for ${apiKeyName} (${type}): ${apiError.message}`);
        if (!firstApiError) {
          firstApiError = apiError;
        }
        continue;
      }

      hadSuccessfulResponse = true;
      const normalized = normalizeBalances(balancesResponse, type);
      logger.info(`Fetched balances for ${apiKeyName} (${type}), count: ${normalized.length}`);
      if (normalized.length > 0) {
        return normalized;
      }
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting balances for ${apiKeyName} (${type}): ${err.message}`);
      lastTransportError = err;
    }
  }

  if (hadSuccessfulResponse) {
    logger.info(`Fetched balances for ${apiKeyName}, count: 0`);
    return [];
  }

  throw firstApiError || lastTransportError || new Error('Не удалось получить балансы ни по одному типу аккаунта');
};

export const getPositions = async (apiKeyName: string, symbol?: string) => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const resolvedSymbol = symbol ? await resolveCcxtSymbol(entry, symbol) : undefined;

      let positions: any[] = [];
      if (typeof entry.client.fetchPositions === 'function') {
        const raw = await entry.limiter.schedule(() =>
          entry.client.fetchPositions(resolvedSymbol ? [resolvedSymbol] : undefined)
        );
        positions = Array.isArray(raw) ? raw : [];
      } else if (resolvedSymbol && typeof entry.client.fetchPosition === 'function') {
        const single = await entry.limiter.schedule(() => entry.client.fetchPosition(resolvedSymbol));
        positions = single ? [single] : [];
      }

      const normalized = positions
        .map((position: any) => {
          const sizeRaw = Number(
            position?.contracts ??
            position?.info?.size ??
            position?.info?.positionAmt ??
            position?.info?.positionSize ??
            0
          );

          if (!Number.isFinite(sizeRaw) || Math.abs(sizeRaw) <= 0) {
            return null;
          }

          const sideRaw = String(position?.side || position?.info?.holdSide || '').toLowerCase();
          const side = sideRaw.includes('long') || sideRaw === 'buy' ? 'Buy' : 'Sell';

          const entryPrice = Number(position?.entryPrice ?? position?.info?.entryPrice ?? position?.info?.openPrice ?? 0);
          const markPrice = Number(position?.markPrice ?? position?.info?.markPrice ?? position?.info?.markPx ?? entryPrice);
          const explicitNotional = Number(position?.notional);
          const derivedNotional = Number(sizeRaw) * (Number.isFinite(markPrice) ? markPrice : 0);
          const notional = Number.isFinite(explicitNotional) ? explicitNotional : Math.abs(derivedNotional);
          const leverage = Number(position?.leverage ?? position?.info?.leverage ?? 1);
          const liquidation = Number(position?.liquidationPrice ?? position?.info?.liquidationPrice ?? position?.info?.liqPx ?? 0);
          const upnl = Number(position?.unrealizedPnl ?? position?.info?.unrealizedPnl ?? position?.info?.upl ?? 0);

          return {
            symbol: toUiSymbol(position?.info?.symbol || position?.symbol || resolvedSymbol || symbol),
            side,
            size: String(Math.abs(sizeRaw)),
            avgPrice: String(Number.isFinite(entryPrice) ? entryPrice : 0),
            markPrice: String(Number.isFinite(markPrice) ? markPrice : 0),
            liqPrice: Number.isFinite(liquidation) && liquidation > 0 ? String(liquidation) : '',
            unrealisedPnl: String(Number.isFinite(upnl) ? upnl : 0),
            leverage: String(Number.isFinite(leverage) && leverage > 0 ? leverage : 1),
            positionValue: String(Number.isFinite(notional) ? Math.abs(notional) : 0),
          };
        })
        .filter((item): item is any => !!item);

      const deduped = Array.from(
        new Map(
          normalized.map((position: any) => [
            `${position.symbol}_${position.side}`,
            position,
          ])
        ).values()
      );

      if (symbol) {
        const symbolKey = normalizeSymbolKey(symbol);
        return deduped.filter((position: any) => normalizeSymbolKey(position.symbol) === symbolKey);
      }

      return deduped;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting positions via ccxt for ${apiKeyName}: ${err.message}`);
      throw error;
    }
  }

  const requests = symbol
    ? [
      {
        category: 'linear',
        symbol: symbol.toUpperCase(),
        limit: 200,
      },
    ]
    : [
      {
        category: 'linear',
        settleCoin: 'USDT',
        limit: 200,
      },
      {
        category: 'linear',
        settleCoin: 'USDC',
        limit: 200,
      },
      {
        category: 'inverse',
        limit: 200,
      },
    ];

  const collected: any[] = [];
  let firstApiError: Error | null = null;

  for (const request of requests) {
    try {
      const response: any = await callPrivateWithDemoFallback(apiKeyName, `getPositionInfo:${JSON.stringify(request)}`, (client) =>
        client.getPositionInfo(request as any)
      );

      if (!isBybitSuccess(response)) {
        const apiError = formatBybitError(response, 'getPositionInfo');
        if (!firstApiError) {
          firstApiError = apiError;
        }
        continue;
      }

      const list = Array.isArray(response?.result?.list) ? response.result.list : [];
      collected.push(...list);
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting positions for ${apiKeyName}: ${err.message}`);
      if (!firstApiError) {
        firstApiError = err;
      }
    }
  }

  if (collected.length === 0 && firstApiError) {
    throw firstApiError;
  }

  const nonZero = collected.filter((position: any) => {
    const size = Number.parseFloat(String(position?.size ?? '0'));
    return Number.isFinite(size) && size > 0;
  });

  const deduped = Array.from(
    new Map(
      nonZero.map((position: any) => [
        `${position?.symbol || ''}_${position?.positionIdx || ''}_${position?.side || ''}`,
        position,
      ])
    ).values()
  );

  return deduped;
};

export const get24hVolume = async (apiKeyName: string, symbol: string) => {
  const key = `volume_${apiKeyName}_${symbol}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);

    try {
      const ticker: any = await entry.limiter.schedule(() => entry.client.fetchTicker(ccxtSymbol));
      const volume = ticker?.quoteVolume ?? ticker?.baseVolume ?? 0;
      cache.set(key, { data: volume, timestamp: Date.now() });
      return volume;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting 24h volume via ccxt: ${err.message}`);
      throw error;
    }
  }

  const { client, limiter } = getClientEntry(apiKeyName);
  try {
    const data = await limiter.schedule(() =>
      client.getTickers({
        category: 'linear',
        symbol: symbol.toUpperCase(),
      })
    );

    if (!isBybitSuccess(data)) {
      throw formatBybitError(data, 'getTickers');
    }

    const volume = data.result.list[0]?.volume24h;
    cache.set(key, { data: volume, timestamp: Date.now() });
    return volume;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error getting 24h volume: ${err.message}`);
    throw error;
  }
};

export const getTickersSnapshot = async (apiKeyName: string) => {
  type TickerSnapshotItem = {
    symbol: string;
    volume24h: number;
    turnover24h: number;
    lastPrice: number;
    change24hPercent: number;
  };

  const cacheKey = `tickers_snapshot_${apiKeyName}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const payload: any = await entry.limiter.schedule(() => entry.client.fetchTickers());
      const sourceRows: unknown[] = Object.values(payload || {});
      const mapped: Array<TickerSnapshotItem | null> = sourceRows
        .map((ticker: any): TickerSnapshotItem | null => {
          const symbol = toUiSymbol(ticker?.info?.symbol || ticker?.symbol || '');
          const volume24h = Number(ticker?.baseVolume ?? 0);
          const turnover24h = Number(ticker?.quoteVolume ?? 0);
          const lastPrice = Number(ticker?.last ?? ticker?.close ?? 0);
          const change24hPercent = Number(ticker?.percentage ?? 0);

          if (!symbol) {
            return null;
          }

          return {
            symbol,
            volume24h: Number.isFinite(volume24h) ? volume24h : 0,
            turnover24h: Number.isFinite(turnover24h) ? turnover24h : 0,
            lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
            change24hPercent: Number.isFinite(change24hPercent) ? change24hPercent : 0,
          };
        });

      const result = mapped
        .filter((item): item is TickerSnapshotItem => item !== null);

      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error loading tickers snapshot via ccxt: ${err.message}`);
      throw error;
    }
  }

  const { client, limiter } = getClientEntry(apiKeyName);

  try {
    const response: any = await limiter.schedule(() =>
      client.getTickers({
        category: 'linear',
      })
    );

    if (!isBybitSuccess(response)) {
      throw formatBybitError(response, 'getTickers');
    }

    const list: any[] = Array.isArray(response?.result?.list) ? response.result.list : [];
    const mapped: Array<TickerSnapshotItem | null> = list
      .map((item: any): TickerSnapshotItem | null => {
        const symbol = toUiSymbol(item?.symbol || '');
        const volume24h = Number(item?.volume24h ?? 0);
        const turnover24h = Number(item?.turnover24h ?? 0);
        const lastPrice = Number(item?.lastPrice ?? 0);
        const change24hPercent = Number(item?.price24hPcnt ?? 0) * 100;

        if (!symbol) {
          return null;
        }

        return {
          symbol,
          volume24h: Number.isFinite(volume24h) ? volume24h : 0,
          turnover24h: Number.isFinite(turnover24h) ? turnover24h : 0,
          lastPrice: Number.isFinite(lastPrice) ? lastPrice : 0,
          change24hPercent: Number.isFinite(change24hPercent) ? change24hPercent : 0,
        };
      });

    const result = mapped
      .filter((item): item is TickerSnapshotItem => item !== null);

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading tickers snapshot for ${apiKeyName}: ${err.message}`);
    throw error;
  }
};

export const getInstrumentInfo = async (apiKeyName: string, symbol: string) => {
  const key = `info_${apiKeyName}_${symbol}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);

    try {
      const markets: any = await entry.limiter.schedule(() => entry.client.loadMarkets());
      const market = markets?.[ccxtSymbol] || null;

      if (!market) {
        throw new Error(`Instrument not found: ${symbol}`);
      }

      const precisionAmount = Number(market?.precision?.amount);
      const derivedStep = Number.isFinite(precisionAmount)
        ? Math.pow(10, -Math.max(0, precisionAmount))
        : NaN;
      const minOrderQty = Number(market?.limits?.amount?.min ?? 0);
      const maxOrderQty = Number(market?.limits?.amount?.max ?? 0);
      const maxLeverage = Number(
        market?.limits?.leverage?.max
        ?? market?.info?.maxLeverage
        ?? market?.info?.leverageMax
        ?? market?.info?.leverage_filter?.max_leverage
        ?? 0
      );
      const qtyStep = Number.isFinite(derivedStep) && derivedStep > 0
        ? derivedStep
        : Number.isFinite(minOrderQty) && minOrderQty > 0
          ? minOrderQty
          : 0.001;

      const info = {
        symbol: toUiSymbol(market?.id || market?.symbol),
        lotSizeFilter: {
          qtyStep: String(qtyStep),
          minOrderQty: String(Number.isFinite(minOrderQty) ? minOrderQty : 0),
          maxOrderQty: String(Number.isFinite(maxOrderQty) ? maxOrderQty : 0),
        },
        leverageFilter: {
          maxLeverage: String(Number.isFinite(maxLeverage) && maxLeverage > 0 ? maxLeverage : 0),
        },
      };

      cache.set(key, { data: info, timestamp: Date.now() });
      return info;
    } catch (error) {
      const err = error as Error;
      logger.error(`Error getting instrument info via ccxt: ${err.message}`);
      throw error;
    }
  }

  const { client, limiter } = getClientEntry(apiKeyName);
  try {
    const data = await limiter.schedule(() =>
      client.getInstrumentsInfo({
        category: 'linear',
        symbol: symbol.toUpperCase(),
      })
    );

    if (!isBybitSuccess(data)) {
      throw formatBybitError(data, 'getInstrumentsInfo');
    }

    const info = data.result.list[0];
    cache.set(key, { data: info, timestamp: Date.now() });
    return info;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error getting instrument info: ${err.message}`);
    throw error;
  }
};

export const closePosition = async (apiKeyName: string, symbol: string, qty: string, currentSide: 'Buy' | 'Sell' = 'Buy') => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);
    const amount = Number.parseFloat(String(qty || '0'));

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid close qty for ${symbol}`);
    }

    const closeSide = currentSide === 'Buy' ? 'sell' : 'buy';

    try {
      await tryEnsureBingxOneWayMode(apiKeyName, entry, ccxtSymbol);

      const submitCloseOrder = async (
        positionSide?: 'BOTH' | 'LONG' | 'SHORT',
        withClosePosition = true
      ) => {
        const params: any = {
          reduceOnly: true,
        };
        if (withClosePosition) {
          params.closePosition = true;
        }
        if (entry.exchange === 'bingx' && positionSide) {
          params.positionSide = positionSide;
        }

        return entry.limiter.schedule(() =>
          entry.client.createOrder(
            ccxtSymbol,
            'market',
            closeSide,
            amount,
            undefined,
            params
          )
        );
      };

      if (entry.exchange !== 'bingx') {
        const order = await submitCloseOrder();
        logger.info(`Closed position via ccxt: ${qty} ${symbol}`);
        return order;
      }

      const fallbackCandidates: Array<{ side?: 'BOTH' | 'LONG' | 'SHORT'; withClosePosition: boolean }> = [
        { side: 'BOTH', withClosePosition: false },
        { side: 'BOTH', withClosePosition: true },
        { side: undefined, withClosePosition: false },
        { side: currentSide === 'Buy' ? 'LONG' : 'SHORT', withClosePosition: false },
        { side: currentSide === 'Buy' ? 'LONG' : 'SHORT', withClosePosition: true },
      ];

      let lastError: Error | null = null;
      for (const candidate of fallbackCandidates) {
        try {
          const order = await submitCloseOrder(candidate.side, candidate.withClosePosition);
          logger.info(
            `Closed BingX position via ccxt: ${qty} ${symbol} (positionSide=${candidate.side || 'omitted'}, closePosition=${candidate.withClosePosition})`
          );
          return order;
        } catch (error) {
          lastError = error as Error;
          if (!isBingxPositionSideError(error)) {
            throw error;
          }
          logger.warn(
            `BingX close retry for ${apiKeyName} ${symbol}: positionSide=${candidate.side || 'omitted'}, closePosition=${candidate.withClosePosition} failed (${lastError.message})`
          );
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error(`Failed to close BingX position for ${symbol}`);
    } catch (error) {
      const err = error as Error;
      logger.error(`Error closing position via ccxt: ${err.message}`);
      throw error;
    }
  }

  try {
    const closeSide: 'Buy' | 'Sell' = currentSide === 'Buy' ? 'Sell' : 'Buy';
    const close: any = await callPrivateWithDemoFallback(apiKeyName, 'closePosition', (client) =>
      client.submitOrder({
        category: 'linear',
        symbol: symbol.toUpperCase(),
        side: closeSide,
        orderType: 'Market',
        qty,
        reduceOnly: true,
      })
    );

    if (!isBybitSuccess(close)) {
      throw formatBybitError(close, 'closePosition');
    }

    logger.info(`Closed position: ${qty} ${symbol}`);
    return close.result;
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing position: ${err.message}`);
    throw error;
  }
};

const parseMaxLeverage = (info: any): number | null => {
  const fromFilter = Number(info?.leverageFilter?.maxLeverage);
  const fromNestedFilter = Number(info?.lotSizeFilter?.maxLeverage);
  const fromAlt = Number(info?.maxLeverage);

  const values = [fromFilter, fromNestedFilter, fromAlt];
  const found = values.find((value) => Number.isFinite(value) && value > 0);

  return found !== undefined ? found : null;
};

const resolveSafeLeverage = async (apiKeyName: string, symbol: string, requestedLeverage: number): Promise<number> => {
  const safeRequested = Math.max(1, Number.isFinite(requestedLeverage) ? requestedLeverage : 1);

  try {
    const info = await getInstrumentInfo(apiKeyName, symbol);
    const maxLeverage = parseMaxLeverage(info);

    if (maxLeverage !== null && safeRequested > maxLeverage) {
      logger.warn(
        `Leverage capped for ${apiKeyName} ${symbol}: requested=${safeRequested}, maxAllowed=${maxLeverage}`
      );
      return maxLeverage;
    }
  } catch (error) {
    logger.warn(`Could not load leverage limits for ${symbol}: ${(error as Error).message}`);
  }

  return safeRequested;
};

export const getRecentTrades = async (apiKeyName: string, symbol?: string, limit: number = 200): Promise<NormalizedTrade[]> => {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 500) : 200;

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const resolvedSymbol = symbol ? await resolveCcxtSymbol(entry, symbol) : undefined;
      const trades = await entry.limiter.schedule(() => entry.client.fetchMyTrades(resolvedSymbol, undefined, safeLimit));
      const list = Array.isArray(trades) ? trades : [];

      return list
        .map((trade: any) => {
          const sideRaw = String(trade?.side || trade?.info?.side || '').toLowerCase();
          const side: 'Buy' | 'Sell' = sideRaw === 'buy' ? 'Buy' : 'Sell';
          const qty = Number(trade?.amount ?? trade?.info?.amount ?? trade?.info?.qty ?? trade?.info?.execQty ?? 0);
          const price = Number(trade?.price ?? trade?.info?.price ?? trade?.info?.execPrice ?? 0);
          const notionalRaw = Number(trade?.cost ?? trade?.info?.notional ?? trade?.info?.execValue ?? 0);
          const fee = Number(trade?.fee?.cost ?? trade?.info?.fee ?? trade?.info?.execFee ?? 0);
          const realizedPnl = Number(trade?.info?.closedPnl ?? trade?.info?.realizedPnl ?? trade?.info?.realizedProfit ?? 0);
          const timestamp = Number(trade?.timestamp ?? trade?.info?.execTime ?? trade?.info?.tradeTime ?? 0);
          const tradeId = String(trade?.id || trade?.info?.execId || trade?.info?.tradeId || '');
          const orderId = String(trade?.order || trade?.info?.orderId || '');
          const normalizedSymbol = toUiSymbol(trade?.info?.symbol || trade?.symbol || resolvedSymbol || symbol || '');
          const feeCurrency = String(trade?.fee?.currency || trade?.info?.feeCurrency || trade?.info?.feeCoin || '');
          const isMakerRaw = String(trade?.takerOrMaker || trade?.info?.isMaker || '').toLowerCase();
          const isMaker = isMakerRaw === 'maker' || isMakerRaw === 'true';

          const notional = Number.isFinite(notionalRaw) && notionalRaw > 0
            ? Math.abs(notionalRaw)
            : (Number.isFinite(price) && Number.isFinite(qty) ? Math.abs(price * qty) : 0);

          return {
            tradeId,
            orderId,
            symbol: normalizedSymbol,
            side,
            qty: String(Number.isFinite(qty) ? Math.abs(qty) : 0),
            price: String(Number.isFinite(price) ? price : 0),
            notional: String(Number.isFinite(notional) ? notional : 0),
            fee: String(Number.isFinite(fee) ? Math.abs(fee) : 0),
            feeCurrency,
            realizedPnl: String(Number.isFinite(realizedPnl) ? realizedPnl : 0),
            isMaker,
            timestamp: String(Number.isFinite(timestamp) ? Math.floor(timestamp) : 0),
          } as NormalizedTrade;
        })
        .filter((trade) => Boolean(trade.tradeId || trade.orderId || trade.timestamp !== '0'))
        .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))
        .slice(0, safeLimit);
    } catch (error) {
      logger.error(`Error loading trades via ccxt for ${apiKeyName}: ${(error as Error).message}`);
      throw error;
    }
  }

  const requests = symbol
    ? [
      {
        category: 'linear',
        symbol: String(symbol).toUpperCase(),
        limit: safeLimit,
      },
    ]
    : [
      {
        category: 'linear',
        settleCoin: 'USDT',
        limit: safeLimit,
      },
      {
        category: 'linear',
        settleCoin: 'USDC',
        limit: safeLimit,
      },
      {
        category: 'inverse',
        limit: safeLimit,
      },
    ];

  const collected: any[] = [];
  let firstError: Error | null = null;

  for (const request of requests) {
    try {
      const response: any = await callPrivateWithDemoFallback(apiKeyName, `getExecutionList:${JSON.stringify(request)}`, (client) =>
        client.getExecutionList(request as any)
      );

      if (!isBybitSuccess(response)) {
        const apiError = formatBybitError(response, 'getExecutionList');
        if (!firstError) {
          firstError = apiError;
        }
        continue;
      }

      const list = Array.isArray(response?.result?.list) ? response.result.list : [];
      collected.push(...list);
    } catch (error) {
      const err = error as Error;
      logger.error(`Error loading trades for ${apiKeyName}: ${err.message}`);
      if (!firstError) {
        firstError = err;
      }
    }
  }

  if (collected.length === 0 && firstError) {
    throw firstError;
  }

  const normalized = collected
    .map((trade: any) => {
      const sideRaw = String(trade?.side || '').toLowerCase();
      const side: 'Buy' | 'Sell' = sideRaw === 'buy' ? 'Buy' : 'Sell';
      const qty = Number(trade?.execQty ?? trade?.qty ?? 0);
      const price = Number(trade?.execPrice ?? trade?.price ?? 0);
      const notionalRaw = Number(trade?.execValue ?? trade?.orderValue ?? 0);
      const fee = Number(trade?.execFee ?? trade?.fee ?? 0);
      const realizedPnl = Number(trade?.closedPnl ?? trade?.realizedPnl ?? 0);
      const timestamp = Number(trade?.execTime ?? trade?.tradeTime ?? 0);
      const tradeId = String(trade?.execId || trade?.tradeId || '');
      const orderId = String(trade?.orderId || '');
      const normalizedSymbol = toUiSymbol(trade?.symbol || symbol || '');
      const feeCurrency = String(trade?.feeCurrency || trade?.feeCoin || '');
      const isMaker = String(trade?.isMaker || '').toLowerCase() === 'true';

      const notional = Number.isFinite(notionalRaw) && notionalRaw > 0
        ? Math.abs(notionalRaw)
        : (Number.isFinite(price) && Number.isFinite(qty) ? Math.abs(price * qty) : 0);

      return {
        tradeId,
        orderId,
        symbol: normalizedSymbol,
        side,
        qty: String(Number.isFinite(qty) ? Math.abs(qty) : 0),
        price: String(Number.isFinite(price) ? price : 0),
        notional: String(Number.isFinite(notional) ? notional : 0),
        fee: String(Number.isFinite(fee) ? Math.abs(fee) : 0),
        feeCurrency,
        realizedPnl: String(Number.isFinite(realizedPnl) ? realizedPnl : 0),
        isMaker,
        timestamp: String(Number.isFinite(timestamp) ? Math.floor(timestamp) : 0),
      } as NormalizedTrade;
    })
    .filter((trade) => Boolean(trade.tradeId || trade.orderId || trade.timestamp !== '0'));

  const deduped = Array.from(
    new Map(
      normalized.map((trade) => [`${trade.tradeId}_${trade.symbol}_${trade.timestamp}`, trade])
    ).values()
  );

  return deduped
    .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))
    .slice(0, safeLimit);
};

export const closePositionPercent = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  percent: number
) => {
  const safePercent = Number.isFinite(percent) ? Math.min(100, Math.max(0.1, percent)) : 100;
  const positions = await getPositions(apiKeyName, symbol);
  const target = positions.find((position: any) => {
    return (
      String(position?.symbol || '').toUpperCase() === symbol.toUpperCase() &&
      String(position?.side || '') === side &&
      Number.parseFloat(String(position?.size || '0')) > 0
    );
  });

  if (!target) {
    throw new Error(`Position not found for ${symbol} side ${side}`);
  }

  const currentSize = Number.parseFloat(String(target.size || '0'));
  const qtyToClose = (currentSize * safePercent) / 100;

  if (!Number.isFinite(qtyToClose) || qtyToClose <= 0) {
    throw new Error(`Invalid close size for ${symbol}`);
  }

  const qty = qtyToClose.toFixed(8).replace(/\.?0+$/, '');
  return closePosition(apiKeyName, symbol, qty, side);
};

export const applySymbolRiskSettings = async (
  apiKeyName: string,
  symbol: string,
  marginType: 'cross' | 'isolated',
  leverage: number
) => {
  const requestedLeverage = Math.max(1, Number.isFinite(leverage) ? leverage : 1);
  const safeLeverage = await resolveSafeLeverage(apiKeyName, symbol, requestedLeverage);

  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);
    const ccxtSymbol = await resolveCcxtSymbol(entry, symbol);

    try {
      if (typeof entry.client.setLeverage === 'function') {
        await entry.limiter.schedule(() => entry.client.setLeverage(safeLeverage, ccxtSymbol));
      }
    } catch (error) {
      logger.warn(`Could not set leverage via ccxt for ${symbol}: ${(error as Error).message}`);
    }

    try {
      if (typeof entry.client.setMarginMode === 'function') {
        await entry.limiter.schedule(() => entry.client.setMarginMode(marginType, ccxtSymbol));
      }
    } catch (error) {
      logger.warn(`Could not set margin mode via ccxt for ${symbol}: ${(error as Error).message}`);
    }

    return {
      leverage: String(safeLeverage),
      requestedLeverage: String(requestedLeverage),
      marginType,
    };
  }

  const leverageValue = safeLeverage.toFixed(2).replace(/\.?0+$/, '');

  const leverageResponse: any = await callPrivateWithDemoFallback(apiKeyName, 'setLeverage', (client) =>
    client.setLeverage({
      category: 'linear',
      symbol: symbol.toUpperCase(),
      buyLeverage: leverageValue,
      sellLeverage: leverageValue,
    } as any)
  );

  if (!isBybitSuccess(leverageResponse)) {
    throw formatBybitError(leverageResponse, `setLeverage:${symbol}`);
  }

  const tradeMode = marginType === 'isolated' ? 1 : 0;

  const marginResponse: any = await callPrivateWithDemoFallback(apiKeyName, 'switchIsolatedMargin', (client) =>
    client.switchIsolatedMargin({
      category: 'linear',
      symbol: symbol.toUpperCase(),
      tradeMode,
      buyLeverage: leverageValue,
      sellLeverage: leverageValue,
    } as any)
  );

  // Bybit may return "not modified" style codes when mode is already set.
  if (!isBybitSuccess(marginResponse) && Number(marginResponse?.retCode) !== 110026) {
    throw formatBybitError(marginResponse, `switchIsolatedMargin:${symbol}`);
  }

  return {
    leverage: leverageValue,
    requestedLeverage: String(requestedLeverage),
    marginType,
  };
};

export const getOpenOrders = async (apiKeyName: string, symbol?: string) => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const resolvedSymbol = symbol ? await resolveCcxtSymbol(entry, symbol) : undefined;
      const orders = await entry.limiter.schedule(() => entry.client.fetchOpenOrders(resolvedSymbol));
      const list = Array.isArray(orders) ? orders : [];

      return list.map((order: any) => {
        const sideRaw = String(order?.side || order?.info?.side || '').toLowerCase();
        return {
          orderId: String(order?.id || order?.info?.orderId || ''),
          symbol: toUiSymbol(order?.info?.symbol || order?.symbol || resolvedSymbol || symbol),
          side: sideRaw === 'buy' ? 'Buy' : 'Sell',
          orderType: String(order?.type || order?.info?.orderType || 'market'),
          qty: String(order?.amount ?? order?.info?.size ?? 0),
          price: String(order?.price ?? order?.info?.price ?? 0),
          orderStatus: String(order?.status || order?.info?.status || 'open'),
          reduceOnly: Boolean(order?.reduceOnly || order?.info?.reduceOnly),
          createdTime: String(order?.timestamp || order?.info?.cTime || Date.now()),
        };
      });
    } catch (error) {
      const err = error as Error;
      logger.error(`Error loading open orders via ccxt for ${apiKeyName}: ${err.message}`);
      throw error;
    }
  }

  const requests = symbol
    ? [
      {
        category: 'linear',
        symbol: String(symbol).toUpperCase(),
        openOnly: 0,
        limit: 200,
      },
    ]
    : [
      {
        category: 'linear',
        settleCoin: 'USDT',
        openOnly: 0,
        limit: 200,
      },
      {
        category: 'linear',
        settleCoin: 'USDC',
        openOnly: 0,
        limit: 200,
      },
      {
        category: 'inverse',
        openOnly: 0,
        limit: 200,
      },
    ];

  const collected: any[] = [];
  let firstError: Error | null = null;

  for (const request of requests) {
    try {
      const response: any = await callPrivateWithDemoFallback(apiKeyName, `getActiveOrders:${JSON.stringify(request)}`, (client) =>
        client.getActiveOrders(request as any)
      );

      if (!isBybitSuccess(response)) {
        const apiError = formatBybitError(response, 'getActiveOrders');
        if (!firstError) {
          firstError = apiError;
        }
        continue;
      }

      const list = Array.isArray(response?.result?.list) ? response.result.list : [];
      collected.push(...list);
    } catch (error) {
      if (!firstError) {
        firstError = error as Error;
      }
    }
  }

  if (collected.length === 0 && firstError) {
    throw firstError;
  }

  const deduped = Array.from(
    new Map(
      collected.map((order: any) => [
        String(order?.orderId || `${order?.symbol || ''}_${order?.createdTime || ''}`),
        order,
      ])
    ).values()
  );

  return deduped;
};

export const cancelAllOrders = async (apiKeyName: string, symbol?: string) => {
  if (ccxtClients[apiKeyName]) {
    const entry = getCcxtClientEntry(apiKeyName);

    try {
      const resolvedSymbol = symbol ? await resolveCcxtSymbol(entry, symbol) : undefined;

      if (typeof entry.client.cancelAllOrders === 'function') {
        const result = await entry.limiter.schedule(() => entry.client.cancelAllOrders(resolvedSymbol));
        return {
          cancelledGroups: 1,
          details: [result || { success: true }],
        };
      }

      const openOrders = await entry.limiter.schedule(() => entry.client.fetchOpenOrders(resolvedSymbol));
      const list = Array.isArray(openOrders) ? openOrders : [];

      for (const order of list) {
        const orderId = String(order?.id || order?.info?.orderId || '');
        const orderSymbol = String(order?.symbol || resolvedSymbol || '');
        if (!orderId) {
          continue;
        }
        await entry.limiter.schedule(() => entry.client.cancelOrder(orderId, orderSymbol || undefined));
      }

      return {
        cancelledGroups: 1,
        details: [{ cancelled: list.length }],
      };
    } catch (error) {
      const err = error as Error;
      logger.error(`Error cancelling orders via ccxt for ${apiKeyName}: ${err.message}`);
      throw error;
    }
  }

  const requests = symbol
    ? [
      {
        category: 'linear',
        symbol: String(symbol).toUpperCase(),
      },
    ]
    : [
      {
        category: 'linear',
        settleCoin: 'USDT',
      },
      {
        category: 'linear',
        settleCoin: 'USDC',
      },
      {
        category: 'inverse',
      },
    ];

  const results: any[] = [];
  let firstError: Error | null = null;

  for (const request of requests) {
    try {
      const response: any = await callPrivateWithDemoFallback(apiKeyName, `cancelAllOrders:${JSON.stringify(request)}`, (client) =>
        client.cancelAllOrders(request as any)
      );

      if (!isBybitSuccess(response)) {
        const apiError = formatBybitError(response, 'cancelAllOrders');
        if (!firstError) {
          firstError = apiError;
        }
        continue;
      }

      results.push(response?.result || { success: true });
    } catch (error) {
      if (!firstError) {
        firstError = error as Error;
      }
    }
  }

  if (results.length === 0 && firstError) {
    throw firstError;
  }

  return {
    cancelledGroups: results.length,
    details: results,
  };
};

export const closeAllPositions = async (apiKeyName: string) => {
  const positions = await getPositions(apiKeyName);
  const actionable = positions.filter((position: any) => Number.parseFloat(String(position?.size || '0')) > 0);

  for (const position of actionable) {
    const symbol = String(position?.symbol || '').toUpperCase();
    const qty = String(position?.size || '0');
    const side = String(position?.side || '') as 'Buy' | 'Sell';

    if (!symbol || !qty || qty === '0') {
      continue;
    }

    await closePosition(apiKeyName, symbol, qty, side);
  }

  return { closed: actionable.length };
};
