import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Table,
  Button,
  Card,
  Alert,
  Space,
  message,
  Tag,
  Segmented,
  Select,
  Input,
  InputNumber,
  Popconfirm,
  Divider,
  Modal,
  Tabs,
  Spin,
  Empty,
  Checkbox,
} from 'antd';
import axios from 'axios';
import { useI18n } from '../i18n';
import MonitoringChartPanel, {
  MonitoringSnapshot,
  MonitoringTradeMarker,
  MonitoringPeriodStats,
  MonitoringTradeRow,
  MonitoringTradeFrequencyPoint,
  ChartPeriodDays,
} from '../components/MonitoringChartPanel';
import { buildPublicPortfolioUrl, sharePublicPortfolioLink } from '../utils/portfolioLinks';
import {
  groupMonitoringByAccount,
  isCopyTradingKey,
  type MonitoringAccountGroupRow,
  type MonitoringLeafMetrics,
} from '../utils/monitoringAccountGroups';

/* eslint-disable react-hooks/exhaustive-deps */

const { Option } = Select;

type ApiKey = {
  id: number;
  name: string;
  exchange: string;
  algofundDematerialized?: boolean;
  tenantDisplayName?: string;
  tenantSlug?: string;
};

type AdminMonitoringRow = MonitoringLeafMetrics;

type BalanceRow = {
  coin: string;
  walletBalance: string;
  availableBalance: string;
  usdValue: string;
  accountType?: string;
  marginUsed?: string;
  unrealisedPnl?: string;
};

type PositionRow = {
  symbol: string;
  side: string;
  size: string;
  avgPrice: string;
  markPrice: string;
  liqPrice: string;
  unrealisedPnl: string;
  leverage: string;
  positionValue: string;
  positionValueUsdt: string;
};

type OrderRow = {
  orderId: string;
  symbol: string;
  side: string;
  orderType: string;
  qty: string;
  price: string;
  orderStatus: string;
  reduceOnly: boolean;
  createdTime: string;
};

type TradeRow = {
  tradeId: string;
  orderId: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  notional: string;
  fee: string;
  feeCurrency: string;
  realizedPnl: string;
  isMaker: boolean;
  timestamp: string;
};

type ViewMode = 'positions' | 'orders' | 'trades' | 'all';
type PageTab = 'monitoring' | 'positions';

type ManualAmountMode = 'coin' | 'usdt';
type ManualOrderType = 'market' | 'limit';

type ManualOrderDraft = {
  symbol: string;
  side: 'Buy' | 'Sell';
  amount: number;
  amountMode: ManualAmountMode;
  orderType: ManualOrderType;
  price?: number;
};

const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

const BATCH_SIZE = 3;
const BATCH_DELAY_MS = 400;

const toNumber = (value: any): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

const formatCompact = (value: any, digits: number = 4): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value ?? '-');
  }
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
};

const extractLastClosePrice = (payload: any): number | null => {
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }

  const last = payload[payload.length - 1];
  if (Array.isArray(last) && last.length >= 5) {
    const close = Number(last[4]);
    return Number.isFinite(close) && close > 0 ? close : null;
  }

  if (last && typeof last === 'object') {
    const close = Number(last.close);
    return Number.isFinite(close) && close > 0 ? close : null;
  }

  return null;
};

const canonicalExchangeLabel = (raw: string): string => {
  const s = String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.startsWith('mexc')) return 'MEXC';
  if (s.startsWith('bybit')) return 'Bybit';
  if (s.startsWith('binance')) return 'Binance';
  if (s.startsWith('bingx')) return 'BingX';
  if (s.startsWith('bitget')) return 'Bitget';
  if (s.startsWith('weex')) return 'WEEX';
  if (s.startsWith('okx')) return 'OKX';
  if (s.startsWith('htx') || s.startsWith('huobi')) return 'HTX';
  return raw || 'Unknown';
};

const Positions: React.FC = () => {
  const { t } = useI18n();
  const [positionsByKey, setPositionsByKey] = useState<{ [key: string]: PositionRow[] }>({});
  const [ordersByKey, setOrdersByKey] = useState<{ [key: string]: OrderRow[] }>({});
  const [tradesByKey, setTradesByKey] = useState<{ [key: string]: TradeRow[] }>({});
  const [balancesByKey, setBalancesByKey] = useState<{ [key: string]: BalanceRow[] }>({});
  const [loadingByKey, setLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [balanceErrorByKey, setBalanceErrorByKey] = useState<{ [key: string]: string }>({});
  const [positionErrorByKey, setPositionErrorByKey] = useState<{ [key: string]: string }>({});
  const [hideDematerializedKeys, setHideDematerializedKeys] = useState(true);
  const [hideUnboundKeys, setHideUnboundKeys] = useState(true);
  const [hideBelow1Usdt, setHideBelow1Usdt] = useState(true);
  const [copyTradersOnly, setCopyTradersOnly] = useState(false);
  const [pageTab, setPageTab] = useState<PageTab>('monitoring');
  const [monitoringRows, setMonitoringRows] = useState<AdminMonitoringRow[]>([]);
  const [monitoringTableLoading, setMonitoringTableLoading] = useState(false);
  const [serverEgressIp, setServerEgressIp] = useState('176.57.184.98');
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(true);
  const [apiKeysError, setApiKeysError] = useState('');
  const [actionLoading, setActionLoading] = useState<{ [key: string]: boolean }>({});
  const [refreshAllLoading, setRefreshAllLoading] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('positions');
  const [monitorModalOpen, setMonitorModalOpen] = useState(false);
  const [monChartOpen, setMonChartOpen] = useState(false);
  const [monChartKey, setMonChartKey] = useState('');
  const [monChartDays, setMonChartDays] = useState<ChartPeriodDays>(7);
  const [monChartLoading, setMonChartLoading] = useState(false);
  const [monChartRaw, setMonChartRaw] = useState<MonitoringSnapshot[]>([]);
  const [monChartPeriodStats, setMonChartPeriodStats] = useState<MonitoringPeriodStats | null>(null);
  const [monChartTrades, setMonChartTrades] = useState<MonitoringTradeRow[]>([]);
  const [monChartTradeFrequency, setMonChartTradeFrequency] = useState<MonitoringTradeFrequencyPoint[]>([]);
  const [monChartTradeStats, setMonChartTradeStats] = useState<{ trades24h: number; lastTradeAt: string | null }>({ trades24h: 0, lastTradeAt: null });
  const [monChartTradeMarkers, setMonChartTradeMarkers] = useState<MonitoringTradeMarker[]>([]);
  const [monChartBackfillLoading, setMonChartBackfillLoading] = useState(false);
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState<boolean>(false);
  const [activeExchangeTab, setActiveExchangeTab] = useState<string>('');
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(() => new Set());
  const [manualOrderDraftByKey, setManualOrderDraftByKey] = useState<{ [key: string]: ManualOrderDraft }>({});
  const apiKeysRef = useRef<ApiKey[]>([]);
  const activeExchangeTabRef = useRef('');
  const fetchApiKeysSeq = useRef(0);

  useEffect(() => {
    void fetchApiKeys();
    void axios.get('/api/admin/egress-ip').then((res) => {
      const ip = String(res.data?.ip || '').trim();
      if (ip) setServerEgressIp(ip);
    }).catch(() => undefined);
  }, []);

  const refreshSingleKey = async (apiKeyName: string, options?: { includeTrades?: boolean }) => {
    const includeTrades = options?.includeTrades === true;
    await Promise.all([
      fetchPositions(apiKeyName),
      fetchOrders(apiKeyName),
      fetchBalances(apiKeyName),
      includeTrades ? fetchTrades(apiKeyName) : Promise.resolve(),
    ]);
  };

  const refreshKeysBatched = async (keys: ApiKey[], options?: { includeTrades?: boolean; force?: boolean }) => {
    const force = options?.force === true;
    const pending = keys.filter((k) => force || !loadedKeys.has(k.name));
    if (pending.length === 0) return;
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((k) => refreshSingleKey(k.name, options)));
      setLoadedKeys((prev) => {
        const next = new Set(prev);
        batch.forEach((k) => next.add(k.name));
        return next;
      });
      if (i + BATCH_SIZE < pending.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }
  };

  const fetchApiKeys = async () => {
    const seq = ++fetchApiKeysSeq.current;
    setApiKeysLoading(true);
    setApiKeysError('');
    // Ensure bearer is set even if Positions mounts before App finishes auth check.
    const password = String(localStorage.getItem('password') || '').trim();
    if (password) {
      axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    }
    try {
      const res = await axios.get('/api/api-keys', { timeout: 60_000 });
      if (seq !== fetchApiKeysSeq.current) return;
      const keys: ApiKey[] = Array.isArray(res.data) ? res.data : [];
      setApiKeys(keys);

      setManualOrderDraftByKey((prev) => {
        const next = { ...prev };
        for (const key of keys) {
          if (!next[key.name]) {
            next[key.name] = {
              symbol: 'BTCUSDT',
              side: 'Buy',
              amount: 0.001,
              amountMode: 'coin',
              orderType: 'market',
            };
          }
        }
        return next;
      });

      setLoadedKeys(new Set());
    } catch (error: any) {
      if (seq !== fetchApiKeysSeq.current) return;
      // Aborted / superseded requests are not "backend down".
      if (axios.isCancel?.(error) || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') {
        return;
      }
      const status = Number(error?.response?.status || 0);
      const serverMessage = String(error?.response?.data?.error || '').trim();
      if (status === 403) {
        setApiKeysError('Нет доступа к API-ключам. Проверьте platform token или пароль админки.');
      } else if (status === 401) {
        setApiKeysError('Сессия истекла. Перелогиньтесь через кнопку в шапке.');
      } else if (status > 0) {
        setApiKeysError(serverMessage || `Не удалось загрузить API-ключи (HTTP ${status}).`);
      } else {
        const detail = String(error?.message || error?.code || '').trim();
        setApiKeysError(
          detail
            ? `Бэкенд недоступен (${detail}). Проверьте API и повторите.`
            : 'Бэкенд недоступен. Проверьте API и повторите.',
        );
      }
      setApiKeys([]);
      console.error(error);
    } finally {
      if (seq === fetchApiKeysSeq.current) {
        setApiKeysLoading(false);
      }
    }
  };

  useEffect(() => {
    apiKeysRef.current = apiKeys;
  }, [apiKeys]);

  useEffect(() => {
    activeExchangeTabRef.current = activeExchangeTab;
  }, [activeExchangeTab]);

  const visibleApiKeys = useMemo(
    () => apiKeys.filter((k) => {
      if (hideDematerializedKeys && k.algofundDematerialized) return false;
      const copy = isCopyTradingKey(k.name, k.tenantDisplayName);
      if (hideUnboundKeys && !String(k.tenantDisplayName || '').trim() && !copy) return false;
      if (copyTradersOnly && !copy) return false;
      return true;
    }),
    [apiKeys, hideDematerializedKeys, hideUnboundKeys, copyTradersOnly],
  );

  const apiKeysByExchange = useMemo(() => {
    return visibleApiKeys.reduce((acc, apiKey) => {
      const exchange = canonicalExchangeLabel(apiKey.exchange || t('common.unknown', 'Unknown'));
      if (!acc[exchange]) acc[exchange] = [];
      acc[exchange].push(apiKey);
      return acc;
    }, {} as { [exchange: string]: ApiKey[] });
  }, [visibleApiKeys, t]);

  useEffect(() => {
    const exchanges = Object.keys(apiKeysByExchange);
    if (exchanges.length === 0) return;
    setActiveExchangeTab((prev) => (prev && exchanges.includes(prev) ? prev : exchanges[0]));
  }, [apiKeysByExchange]);

  useEffect(() => {
    if (pageTab !== 'positions' || !activeExchangeTab) return;
    const keys = apiKeysByExchange[activeExchangeTab] || [];
    if (keys.length > 0) {
      void refreshKeysBatched(keys);
    }
  }, [activeExchangeTab, apiKeysByExchange, pageTab]);

  useEffect(() => {
    if (!autoRefreshEnabled) {
      return () => undefined;
    }

    const timerId = window.setInterval(() => {
      const tab = activeExchangeTabRef.current;
      const keys = apiKeysRef.current.filter((k) => canonicalExchangeLabel(k.exchange || '') === tab);
      if (keys.length > 0) {
        void refreshKeysBatched(keys, { force: true });
      }
    }, 180000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [autoRefreshEnabled]);

  const fetchPositions = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [apiKeyName]: true }));
    setPositionErrorByKey((prev) => ({ ...prev, [apiKeyName]: '' }));

    try {
      const res = await axios.get(`/api/positions/${apiKeyName}`);
      const normalized = (Array.isArray(res.data) ? res.data : []).map((pos: any) => ({
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        avgPrice: pos.avgPrice,
        markPrice: pos.markPrice,
        liqPrice: pos.liqPrice || '-',
        unrealisedPnl: pos.unrealisedPnl,
        leverage: pos.leverage,
        positionValue: pos.positionValue,
        positionValueUsdt: (() => {
          const value = Number.parseFloat(String(pos.positionValue || '0'));
          if (!Number.isFinite(value)) {
            return '-';
          }
          return `${value.toFixed(2)} USDT`;
        })(),
      }));

      setPositionsByKey((prev) => ({ ...prev, [apiKeyName]: normalized }));
    } catch (error: any) {
      console.error(error);
      setPositionErrorByKey((prev) => ({
        ...prev,
        [apiKeyName]: error.response?.data?.error || t('positions.msg.loadPositionsFailed', 'Failed to load positions'),
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [apiKeyName]: false }));
    }
  };

  const fetchOrders = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [`orders:${apiKeyName}`]: true }));

    try {
      const res = await axios.get(`/api/orders/${apiKeyName}`);
      const normalized = (Array.isArray(res.data) ? res.data : []).map((order: any) => ({
        orderId: String(order.orderId || order.orderLinkId || `${order.symbol}_${order.createdTime || Date.now()}`),
        symbol: String(order.symbol || ''),
        side: String(order.side || ''),
        orderType: String(order.orderType || ''),
        qty: String(order.qty || '0'),
        price: String(order.price || '-'),
        orderStatus: String(order.orderStatus || ''),
        reduceOnly: Boolean(order.reduceOnly),
        createdTime: String(order.createdTime || ''),
      }));

      setOrdersByKey((prev) => ({ ...prev, [apiKeyName]: normalized }));
    } catch (error: any) {
      console.error(error);
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`orders:${apiKeyName}`]: false }));
    }
  };

  const fetchTrades = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [`trades:${apiKeyName}`]: true }));

    try {
      const res = await axios.get(`/api/trades/${apiKeyName}`, {
        params: {
          limit: 200,
        },
      });

      const normalized = (Array.isArray(res.data) ? res.data : []).map((trade: any, index: number) => ({
        tradeId: String(trade.tradeId || `trade_${index}`),
        orderId: String(trade.orderId || ''),
        symbol: String(trade.symbol || ''),
        side: String(trade.side || ''),
        qty: String(trade.qty || '0'),
        price: String(trade.price || '0'),
        notional: String(trade.notional || '0'),
        fee: String(trade.fee || '0'),
        feeCurrency: String(trade.feeCurrency || ''),
        realizedPnl: String(trade.realizedPnl || '0'),
        isMaker: Boolean(trade.isMaker),
        timestamp: String(trade.timestamp || ''),
      }));

      setTradesByKey((prev) => ({ ...prev, [apiKeyName]: normalized }));
    } catch (error: any) {
      console.error(error);
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`trades:${apiKeyName}`]: false }));
    }
  };

  const fetchBalances = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [`balances:${apiKeyName}`]: true }));
    setBalanceErrorByKey((prev) => ({ ...prev, [apiKeyName]: '' }));

    try {
      const res = await axios.get(`/api/balances/${apiKeyName}`);
      const normalized = (Array.isArray(res.data) ? res.data : []).map((item: any) => ({
        coin: String(item.coin || ''),
        walletBalance: String(item.walletBalance || '0'),
        availableBalance: String(item.availableBalance || '0'),
        usdValue: String(item.usdValue || '0'),
        accountType: String(item.accountType || ''),
        marginUsed: item.marginUsed != null ? String(item.marginUsed) : undefined,
        unrealisedPnl: item.unrealisedPnl != null ? String(item.unrealisedPnl) : undefined,
      }));
      setBalancesByKey((prev) => ({ ...prev, [apiKeyName]: normalized }));
    } catch (error: any) {
      console.error(error);
      setBalanceErrorByKey((prev) => ({
        ...prev,
        [apiKeyName]: error.response?.data?.error || t('positions.msg.loadBalancesFailed', 'Failed to load balances'),
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`balances:${apiKeyName}`]: false }));
    }
  };

  const closePositionPart = async (apiKeyName: string, row: PositionRow, percent: number) => {
    const actionKey = `${apiKeyName}:${row.symbol}:${row.side}:${percent}`;

    try {
      setActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`/api/positions/${apiKeyName}/close-percent`, {
        symbol: row.symbol,
        side: row.side,
        percent,
      });

      message.success(
        t('positions.msg.closedPercent', 'Closed {percent}% for {symbol} ({side})', {
          percent,
          symbol: row.symbol,
          side: row.side,
        })
      );
      await fetchPositions(apiKeyName);
    } catch (error: any) {
      console.error(error);
      message.error(
        error?.response?.data?.error
        || t('positions.msg.closePercentFailed', 'Failed to close {percent}% of {symbol}', {
          percent,
          symbol: row.symbol,
        })
      );
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const runKeyAction = async (
    apiKeyName: string,
    action: 'cancel-orders' | 'close-positions',
    successText: string
  ) => {
    const actionKey = `${apiKeyName}:${action}`;

    try {
      setActionLoading((prev) => ({ ...prev, [actionKey]: true }));

      if (action === 'cancel-orders') {
        await axios.post(`/api/orders/${apiKeyName}/cancel-all`);
      } else {
        await axios.post(`/api/positions/${apiKeyName}/close-all`);
      }

      message.success(successText);
      await Promise.all([
        fetchPositions(apiKeyName),
        fetchOrders(apiKeyName),
        fetchBalances(apiKeyName),
        fetchTrades(apiKeyName),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('positions.msg.actionFailed', 'Failed action: {action}', { action }));
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const placeManualOrder = async (apiKeyName: string) => {
    const draft = manualOrderDraftByKey[apiKeyName];
    if (!draft || !draft.symbol || !draft.amount || draft.amount <= 0) {
      message.warning(t('positions.msg.setSymbolQty', 'Set symbol and qty before placing manual order'));
      return;
    }

    const normalizedSymbol = String(draft.symbol || '').trim().toUpperCase();
    const normalizedPrice = draft.price && draft.price > 0 ? draft.price : undefined;
    if (draft.orderType === 'limit' && !normalizedPrice) {
      message.warning(t('positions.msg.setLimitPrice', 'Set limit price for a limit order'));
      return;
    }

    const actionKey = `${apiKeyName}:manual-order`;

    try {
      setActionLoading((prev) => ({ ...prev, [actionKey]: true }));

      let qty = draft.amount;
      if (draft.amountMode === 'usdt') {
        let conversionPrice = normalizedPrice;

        if (!conversionPrice) {
          const marketRes = await axios.get(`/api/market-data/${apiKeyName}`, {
            params: {
              symbol: normalizedSymbol,
              interval: '1m',
              limit: 1,
            },
          });
          conversionPrice = extractLastClosePrice(marketRes.data) || undefined;
        }

        if (!conversionPrice || conversionPrice <= 0) {
          throw new Error('Cannot convert USDT amount to coin qty: price unavailable');
        }

        qty = draft.amount / conversionPrice;
      }

      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error('Invalid qty after amount conversion');
      }

      await axios.post(`/api/manual-order/${apiKeyName}`, {
        symbol: normalizedSymbol,
        side: draft.side,
        qty: String(qty),
        price: draft.orderType === 'limit' && normalizedPrice ? String(normalizedPrice) : undefined,
      });

      message.success(t('positions.msg.manualOrderPlaced', 'Manual order placed for {apiKey}', { apiKey: apiKeyName }));
      await Promise.all([
        fetchOrders(apiKeyName),
        fetchPositions(apiKeyName),
        fetchTrades(apiKeyName),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('positions.msg.placeOrderFailed', 'Failed to place manual order'));
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const refreshAllPositions = async () => {
    setRefreshAllLoading(true);
    try {
      await refreshKeysBatched(visibleApiKeys, { includeTrades: true, force: true });
      message.success(t('positions.msg.refreshedAll', 'Positions, orders and trades refreshed for all API keys'));
    } catch (error) {
      console.error(error);
      message.error(t('positions.msg.refreshAllFailed', 'Failed to refresh all positions'));
    } finally {
      setRefreshAllLoading(false);
    }
  };

  const getColumns = (apiKeyName: string) => [
    { title: t('positions.col.symbol', 'Symbol'), dataIndex: 'symbol', key: 'symbol' },
    {
      title: t('positions.col.side', 'Side'),
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const normalized = String(side || '').toLowerCase();
        const isLong = normalized === 'buy';
        return <Tag color={isLong ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    { title: t('positions.col.size', 'Size'), dataIndex: 'size', key: 'size' },
    { title: t('positions.col.entryPrice', 'Entry Price'), dataIndex: 'avgPrice', key: 'avgPrice' },
    { title: t('positions.col.markPrice', 'Mark Price'), dataIndex: 'markPrice', key: 'markPrice' },
    { title: t('positions.col.liqPrice', 'Liq Price'), dataIndex: 'liqPrice', key: 'liqPrice' },
    { title: t('positions.col.leverage', 'Leverage'), dataIndex: 'leverage', key: 'leverage' },
    {
      title: t('positions.col.positionValue', 'Position Value'),
      dataIndex: 'positionValue',
      key: 'positionValue',
      render: (value: string) => formatCompact(value, 4),
    },
    {
      title: t('positions.col.valueUsdt', 'Value (USDT)'),
      dataIndex: 'positionValueUsdt',
      key: 'positionValueUsdt',
    },
    {
      title: t('positions.col.upnl', 'UPnL'),
      dataIndex: 'unrealisedPnl',
      key: 'unrealisedPnl',
      render: (value: string) => {
        const numeric = toNumber(value);
        const color = numeric > 0 ? '#16a34a' : numeric < 0 ? '#dc2626' : '#4b5563';
        return <span style={{ color, fontWeight: 600 }}>{formatCompact(numeric, 4)}</span>;
      },
    },
    {
      title: t('positions.col.actions', 'Actions'),
      key: 'actions',
      render: (_: any, row: PositionRow) => {
        const key25 = `${apiKeyName}:${row.symbol}:${row.side}:25`;
        const key50 = `${apiKeyName}:${row.symbol}:${row.side}:50`;
        const key100 = `${apiKeyName}:${row.symbol}:${row.side}:100`;

        return (
          <Space wrap>
            <Button size="small" loading={Boolean(actionLoading[key25])} onClick={() => { void closePositionPart(apiKeyName, row, 25); }}>
              {t('positions.close25', 'Close 25%')}
            </Button>
            <Button size="small" loading={Boolean(actionLoading[key50])} onClick={() => { void closePositionPart(apiKeyName, row, 50); }}>
              {t('positions.close50', 'Close 50%')}
            </Button>
            <Button size="small" danger loading={Boolean(actionLoading[key100])} onClick={() => { void closePositionPart(apiKeyName, row, 100); }}>
              {t('positions.close100', 'Close 100%')}
            </Button>
          </Space>
        );
      },
    },
  ];

  const orderColumns = [
    { title: t('positions.col.symbol', 'Symbol'), dataIndex: 'symbol', key: 'symbol' },
    {
      title: t('positions.col.side', 'Side'),
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const normalized = String(side || '').toLowerCase();
        const isBuy = normalized === 'buy';
        return <Tag color={isBuy ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    { title: t('positions.col.type', 'Type'), dataIndex: 'orderType', key: 'orderType' },
    {
      title: t('positions.col.qty', 'Qty'),
      dataIndex: 'qty',
      key: 'qty',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: t('positions.col.price', 'Price'),
      dataIndex: 'price',
      key: 'price',
      render: (value: string) => (value === '-' ? '-' : formatCompact(value, 6)),
    },
    { title: t('positions.col.status', 'Status'), dataIndex: 'orderStatus', key: 'orderStatus' },
    {
      title: t('positions.col.reduce', 'Reduce'),
      dataIndex: 'reduceOnly',
      key: 'reduceOnly',
      render: (value: boolean) => <Tag color={value ? 'orange' : 'default'}>{value ? t('common.yes', 'Yes') : t('common.no', 'No')}</Tag>,
    },
    {
      title: t('positions.col.created', 'Created'),
      dataIndex: 'createdTime',
      key: 'createdTime',
      render: (value: string) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          return '-';
        }

        const date = new Date(numeric);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
      },
    },
  ];

  const tradeColumns = [
    {
      title: t('positions.col.time', 'Time'),
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (value: string) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          return '-';
        }

        const date = new Date(numeric > 9999999999 ? numeric : numeric * 1000);
        return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
      },
    },
    { title: t('positions.col.symbol', 'Symbol'), dataIndex: 'symbol', key: 'symbol' },
    {
      title: t('positions.col.side', 'Side'),
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const isBuy = String(side || '').toLowerCase() === 'buy';
        return <Tag color={isBuy ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    {
      title: t('positions.col.qty', 'Qty'),
      dataIndex: 'qty',
      key: 'qty',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: t('positions.col.price', 'Price'),
      dataIndex: 'price',
      key: 'price',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: t('positions.col.notional', 'Notional'),
      dataIndex: 'notional',
      key: 'notional',
      render: (value: string) => formatCompact(value, 2),
    },
    {
      title: t('positions.col.fee', 'Fee'),
      key: 'fee',
      render: (_: unknown, row: TradeRow) => {
        const feeValue = formatCompact(row.fee, 6);
        return `${feeValue}${row.feeCurrency ? ` ${row.feeCurrency}` : ''}`;
      },
    },
    {
      title: t('positions.col.realizedPnl', 'Realized PnL'),
      dataIndex: 'realizedPnl',
      key: 'realizedPnl',
      render: (value: string) => {
        const numeric = toNumber(value);
        const color = numeric > 0 ? '#16a34a' : numeric < 0 ? '#dc2626' : '#4b5563';
        return <span style={{ color, fontWeight: 600 }}>{formatCompact(numeric, 4)}</span>;
      },
    },
    {
      title: t('positions.col.maker', 'Maker'),
      dataIndex: 'isMaker',
      key: 'isMaker',
      render: (value: boolean) => <Tag color={value ? 'blue' : 'default'}>{value ? t('positions.maker', 'Maker') : t('positions.taker', 'Taker')}</Tag>,
    },
  ];

  const hiddenByFiltersCount = useMemo(
    () => apiKeys.length - visibleApiKeys.length,
    [apiKeys.length, visibleApiKeys.length],
  );

  const monitoringEmptyDescription = useMemo(() => {
    if (apiKeysLoading) {
      return 'Загрузка API-ключей...';
    }
    if (apiKeysError) {
      return apiKeysError;
    }
    if (apiKeys.length === 0) {
      return 'API-ключи не найдены. Добавьте ключи в настройках.';
    }
    if (visibleApiKeys.length === 0) {
      return `Все ${apiKeys.length} ключ(ей) скрыты фильтрами. Снимите галочки «Скрыть ключи без привязки» / «Скрыть дематериализованные» / «Баланс > 1 USDT» / «Копитрейдеры».`;
    }
    if (monitoringRows.length === 0) {
      return 'Нет снимков мониторинга. Нажмите «Обновить сводку» или дождитесь планового снимка.';
    }
    return 'Нет данных';
  }, [apiKeys.length, apiKeysError, apiKeysLoading, monitoringRows.length, visibleApiKeys.length]);

  const weexIpErrorCount = useMemo(
    () => Object.values({ ...balanceErrorByKey, ...positionErrorByKey })
      .filter((msg) => /whitelist|WEEX отклонил|无效的IP|40018/i.test(String(msg || ''))).length,
    [balanceErrorByKey, positionErrorByKey],
  );

  const loadMonitoringTable = async (keys: ApiKey[]) => {
    setMonitoringTableLoading(true);
    try {
      const names = keys.map((k) => k.name).filter(Boolean);
      const byName = new Map(keys.map((k) => [k.name, k]));
      let summaryRows: Array<{
        apiKeyName: string;
        latest: Record<string, unknown> | null;
        tradeStats?: { trades24h?: number; lastTradeAt?: string | null };
      }> = [];

      try {
        const res = await axios.get('/api/monitoring-summary', {
          params: {
            keys: names.join(','),
            includeTrades: '1',
          },
          timeout: 60_000,
        });
        summaryRows = Array.isArray(res.data?.rows) ? res.data.rows : [];
      } catch {
        // Fallback: per-key latest only (no trades) with limited concurrency.
        const concurrency = 6;
        const queue = [...names];
        const collected: typeof summaryRows = [];
        const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
          while (queue.length) {
            const name = queue.shift();
            if (!name) break;
            try {
              const res = await axios.get(`/api/monitoring/${encodeURIComponent(name)}`, {
                params: { limit: 1 },
                timeout: 15_000,
              });
              const latest = res.data?.latest || (Array.isArray(res.data?.points) ? res.data.points[res.data.points.length - 1] : null) || null;
              collected.push({ apiKeyName: name, latest, tradeStats: { trades24h: 0, lastTradeAt: null } });
            } catch (err: any) {
              collected.push({
                apiKeyName: name,
                latest: null,
                tradeStats: { trades24h: 0, lastTradeAt: null },
              });
              console.warn(`monitoring load failed for ${name}:`, err?.message || err);
            }
          }
        });
        await Promise.all(workers);
        summaryRows = collected;
      }

      const summaryByName = new Map(summaryRows.map((r) => [r.apiKeyName, r]));
      const rows: AdminMonitoringRow[] = names.map((name) => {
        const key = byName.get(name)!;
        const summary = summaryByName.get(name);
        const latest = summary?.latest || null;
        const hasEquity = latest?.equity_usd != null && Number.isFinite(Number(latest.equity_usd));
        return {
          apiKeyName: name,
          exchange: key.exchange,
          tenantLabel: String(key.tenantDisplayName || '').trim() || 'без привязки',
          tenantSlug: key.tenantSlug,
          equityUsd: hasEquity ? Number(latest!.equity_usd) : null,
          unrealizedPnl: latest?.unrealized_pnl != null ? Number(latest.unrealized_pnl) : null,
          pnlNetUsd: latest?.pnl_net_usd != null ? Number(latest.pnl_net_usd) : null,
          drawdownPercent: latest?.drawdown_percent != null ? Number(latest.drawdown_percent) : null,
          recordedAt: latest?.recorded_at ? String(latest.recorded_at) : null,
          trades24h: Number(summary?.tradeStats?.trades24h || 0),
          lastTradeAt: summary?.tradeStats?.lastTradeAt || null,
          loadError: !latest ? 'нет снимка' : null,
        };
      });
      setMonitoringRows(rows);
    } finally {
      setMonitoringTableLoading(false);
    }
  };

  useEffect(() => {
    if (pageTab !== 'monitoring' || visibleApiKeys.length === 0) return;
    void loadMonitoringTable(visibleApiKeys);
  }, [pageTab, visibleApiKeys]);

  const loadMonChart = async (key: string, days: ChartPeriodDays) => {
    setMonChartLoading(true);
    try {
      const params: Record<string, number | string> = days === 0
        ? { all: '1', includeTrades: '1', includeTradesRows: '1' }
        : days > 1
          ? { days, includeTrades: '1', includeTradesRows: '1' }
          : { limit: 288, includeTrades: '1', includeTradesRows: '1' };
      const res = await axios.get(
        `/api/monitoring/${encodeURIComponent(key)}`, { params },
      );
      const rows = Array.isArray(res.data?.points) ? res.data.points : [];
      setMonChartRaw(rows);
      setMonChartPeriodStats(res.data?.periodStats || null);
      setMonChartTrades(Array.isArray(res.data?.trades) ? res.data.trades : []);
      setMonChartTradeFrequency(Array.isArray(res.data?.tradeFrequency) ? res.data.tradeFrequency : []);
      setMonChartTradeStats({
        trades24h: Number(res.data?.tradeStats?.trades24h || 0),
        lastTradeAt: res.data?.tradeStats?.lastTradeAt || null,
      });
      setMonChartTradeMarkers([]);
    } catch {
      setMonChartRaw([]);
      setMonChartPeriodStats(null);
      setMonChartTrades([]);
      setMonChartTradeFrequency([]);
      setMonChartTradeStats({ trades24h: 0, lastTradeAt: null });
      setMonChartTradeMarkers([]);
    } finally {
      setMonChartLoading(false);
    }
  };

  const openMonChart = (key: string) => {
    setMonChartOpen(true); setMonChartKey(key); setMonChartDays(7);
    void loadMonChart(key, 7);
  };

  useEffect(() => { if (monChartOpen && monChartKey) void loadMonChart(monChartKey, monChartDays); }, [monChartDays]);

  const fmtNum = (v: unknown, d = 2) => {
    if (v == null || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(d) : '—';
  };

  const monitoringAccountRows = useMemo(
    () => {
      const exchange = activeExchangeTab;
      let rows = monitoringRows;
      if (exchange) {
        rows = rows.filter((r) => canonicalExchangeLabel(r.exchange || '') === exchange);
      }
      if (copyTradersOnly) {
        rows = rows.filter((r) => isCopyTradingKey(r.apiKeyName, r.tenantLabel));
      }
      if (hideBelow1Usdt) {
        rows = rows.filter((r) => r.equityUsd == null || Number(r.equityUsd) > 1);
      }
      return groupMonitoringByAccount(rows);
    },
    [monitoringRows, activeExchangeTab, copyTradersOnly, hideBelow1Usdt],
  );

  const monChartTenantSlug = useMemo(
    () => apiKeys.find((key) => key.name === monChartKey)?.tenantSlug || '',
    [apiKeys, monChartKey],
  );

  const monChartExchange = useMemo(
    () => String(apiKeys.find((key) => key.name === monChartKey)?.exchange || '').toLowerCase(),
    [apiKeys, monChartKey],
  );
  const monChartBackfillSupported = monChartExchange.includes('bybit');

  const handleBackfillFromExchange = async () => {
    if (!monChartKey) return;
    setMonChartBackfillLoading(true);
    try {
      const res = await axios.post(
        `/api/monitoring/${encodeURIComponent(monChartKey)}/backfill-equity`,
        { maxDays: 90 },
      );
      const inserted = Number(res.data?.inserted || 0);
      const fillsInserted = Number(res.data?.fillsInserted || 0);
      const note = String(res.data?.note || '');
      if (inserted > 0 || fillsInserted > 0) {
        message.success(
          `С биржи: equity +${inserted}, fills +${fillsInserted}`
          + (res.data?.firstAt ? ` (${res.data.firstAt} → ${res.data.lastAt})` : ''),
        );
        setMonChartDays(0);
        await loadMonChart(monChartKey, 0);
      } else {
        message.info(note || 'Новых точек с биржи нет');
      }
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Не удалось подтянуть историю с биржи'));
    } finally {
      setMonChartBackfillLoading(false);
    }
  };

  const handleCopyPortfolioLink = async (slug: string) => {
    await sharePublicPortfolioLink(slug, { title: 'Ссылка на публичный мониторинг' });
  };

  const monitoringColumns = [
    {
      title: 'Аккаунт / API',
      dataIndex: 'accountLabel',
      render: (_: unknown, row: MonitoringAccountGroupRow) => {
        if (row.rowKind === 'account') {
          return (
            <Space direction="vertical" size={0}>
              <strong>{row.accountLabel}</strong>
              <span style={{ fontSize: 11, color: '#6b7280' }}>
                {row.keyCount > 1
                  ? `${row.keyCount} API · ${row.exchange}`
                  : `${row.apiKeyName} · ${row.exchange}`}
              </span>
            </Space>
          );
        }
        return (
          <Space direction="vertical" size={0}>
            <span style={{ fontFamily: 'monospace' }}>{row.apiKeyName}</span>
            <span style={{ fontSize: 11, color: '#6b7280' }}>{row.exchange}</span>
          </Space>
        );
      },
    },
    {
      title: 'Equity',
      render: (_: unknown, row: MonitoringAccountGroupRow) => (
        <span title={row.loadError || undefined}>
          {row.equityUsd == null ? '—' : `$${fmtNum(row.equityUsd)}`}
        </span>
      ),
    },
    {
      title: 'UPNL',
      render: (_: unknown, row: MonitoringAccountGroupRow) => {
        if (row.unrealizedPnl == null) return '—';
        const v = Number(row.unrealizedPnl || 0);
        return <span style={{ color: v >= 0 ? '#16a34a' : '#dc2626' }}>${fmtNum(v)}</span>;
      },
    },
    {
      title: 'PnL net',
      render: (_: unknown, row: MonitoringAccountGroupRow) => {
        if (row.pnlNetUsd == null) return '—';
        const v = Number(row.pnlNetUsd);
        return <span style={{ color: v >= 0 ? '#16a34a' : '#dc2626' }}>${fmtNum(v)}</span>;
      },
    },
    {
      title: 'DD %',
      render: (_: unknown, row: MonitoringAccountGroupRow) => (
        row.drawdownPercent == null ? '—' : `${fmtNum(row.drawdownPercent)}%`
      ),
    },
    {
      title: 'Входы 24ч',
      render: (_: unknown, row: MonitoringAccountGroupRow) => (
        <Space direction="vertical" size={0}>
          <span>{row.trades24h}</span>
          {row.lastTradeAt ? (
            <span style={{ fontSize: 10, color: '#9ca3af' }}>
              {new Date(row.lastTradeAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
            </span>
          ) : null}
        </Space>
      ),
    },
    {
      title: '',
      width: 250,
      render: (_: unknown, row: MonitoringAccountGroupRow) => {
        const chartKey = row.rowKind === 'apiKey' || row.keyCount === 1
          ? (row.rowKind === 'apiKey' ? row.apiKeyName : row.children?.[0]?.apiKeyName || row.apiKeyName)
          : '';
        return (
          <Space wrap size={[4, 4]}>
            {chartKey ? (
              <Button size="small" type="primary" ghost onClick={() => openMonChart(chartKey)}>График</Button>
            ) : null}
            {row.tenantSlug ? (
              <>
                <Button
                  size="small"
                  onClick={() => void handleCopyPortfolioLink(String(row.tenantSlug || ''))}
                >
                  Ссылка
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => window.open(buildPublicPortfolioUrl(String(row.tenantSlug || '')), '_blank', 'noopener,noreferrer')}
                >
                  Открыть
                </Button>
              </>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const shouldShowPositions = viewMode === 'positions' || viewMode === 'all';
  const shouldShowOrders = viewMode === 'orders' || viewMode === 'all';
  const shouldShowTrades = viewMode === 'trades' || viewMode === 'all';

  return (
    <div className="positions-page">
      <Tabs
        activeKey={pageTab}
        onChange={(key) => setPageTab(key as PageTab)}
        style={{ marginBottom: 12 }}
        items={[
          { key: 'monitoring', label: 'Мониторинг' },
          { key: 'positions', label: t('positions.segment.positions', 'Позиции') },
        ]}
      />

      {pageTab === 'monitoring' ? (
        <>
          <Space style={{ marginBottom: 12 }} wrap>
            <Button loading={monitoringTableLoading || apiKeysLoading} onClick={() => void loadMonitoringTable(visibleApiKeys)}>
              Обновить сводку
            </Button>
            <Checkbox checked={hideUnboundKeys} onChange={(e) => setHideUnboundKeys(e.target.checked)}>
              Скрыть ключи без привязки
            </Checkbox>
            <Checkbox checked={hideDematerializedKeys} onChange={(e) => setHideDematerializedKeys(e.target.checked)}>
              Скрыть дематериализованные ключи
            </Checkbox>
            <Checkbox checked={hideBelow1Usdt} onChange={(e) => setHideBelow1Usdt(e.target.checked)}>
              Баланс {'>'} 1 USDT
            </Checkbox>
            <Checkbox checked={copyTradersOnly} onChange={(e) => setCopyTradersOnly(e.target.checked)}>
              Копитрейдеры
            </Checkbox>
          </Space>
          {apiKeysError ? (
            <Alert
              type="error"
              showIcon
              message={apiKeysError}
              action={<Button size="small" onClick={() => void fetchApiKeys()}>Повторить</Button>}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          {hiddenByFiltersCount > 0 ? (
            <Alert
              type="info"
              showIcon
              message={`Скрыто фильтрами: ${hiddenByFiltersCount} из ${apiKeys.length} ключ(ей).`}
              style={{ marginBottom: 12 }}
            />
          ) : null}
          <Spin spinning={monitoringTableLoading || apiKeysLoading}>
            <Tabs
              type="card"
              activeKey={activeExchangeTab || undefined}
              onChange={(key) => setActiveExchangeTab(key)}
              items={Object.entries(apiKeysByExchange).map(([exchange, keys]) => ({
                key: exchange,
                label: `${exchange} (${keys.length})`,
                children: (
                  <Table
                    rowKey="key"
                    size="small"
                    pagination={{ pageSize: 20 }}
                    dataSource={monitoringAccountRows}
                    columns={monitoringColumns}
                    expandable={{
                      defaultExpandAllRows: false,
                      rowExpandable: (row) => Array.isArray(row.children) && row.children.length > 0,
                    }}
                    locale={{ emptyText: <Empty description={monitoringEmptyDescription} /> }}
                  />
                ),
              }))}
            />
          </Spin>
        </>
      ) : (
        <>
      <Space style={{ marginBottom: 8 }}>
        <Button loading={refreshAllLoading} onClick={() => { void refreshAllPositions(); }}>
          {t('positions.refreshAll', 'Refresh all')}
        </Button>
        <Tag color={autoRefreshEnabled ? 'green' : 'default'}>
          {autoRefreshEnabled ? t('positions.autoRefreshOn', 'Auto refresh: ON (3m)') : t('positions.autoRefreshOff', 'Auto refresh: OFF')}
        </Tag>
        <Button onClick={() => setAutoRefreshEnabled((prev) => !prev)}>
          {autoRefreshEnabled ? t('positions.disableAutoRefresh', 'Disable auto refresh') : t('positions.enableAutoRefresh', 'Enable auto refresh')}
        </Button>
        <Button type="primary" style={{ background: '#7c3aed' }} onClick={() => setMonitorModalOpen(true)}>
          📊 Сводка
        </Button>
        <Segmented<ViewMode>
          value={viewMode}
          onChange={(value) => setViewMode(value as ViewMode)}
          options={[
            { label: t('positions.segment.positions', 'Positions'), value: 'positions' },
            { label: t('positions.segment.orders', 'Orders'), value: 'orders' },
            { label: t('positions.segment.trades', 'Trades'), value: 'trades' },
            { label: t('positions.segment.all', 'All'), value: 'all' },
          ]}
        />
        <Checkbox checked={hideDematerializedKeys} onChange={(e) => setHideDematerializedKeys(e.target.checked)}>
          Скрыть дематериализованные ключи
        </Checkbox>
        <Checkbox checked={hideBelow1Usdt} onChange={(e) => setHideBelow1Usdt(e.target.checked)}>
          Баланс {'>'} 1 USDT
        </Checkbox>
        <Checkbox checked={copyTradersOnly} onChange={(e) => setCopyTradersOnly(e.target.checked)}>
          Копитрейдеры
        </Checkbox>
      </Space>

      {weexIpErrorCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="WEEX: неверный IP в whitelist API-ключа"
          description={`Запросы с сервера идут с IP ${serverEgressIp}. В кабинете WEEX для каждого проблемного API-ключа добавьте этот IP в список разрешённых, затем нажмите «Обновить». Ключи без whitelist показывают 0 USDT и пустые позиции — это не слив, а блокировка API.`}
        />
      ) : null}

      <Modal
        title="📊 Мониторинг позиций"
        open={monitorModalOpen}
        onCancel={() => setMonitorModalOpen(false)}
        footer={null}
        width={900}
      >
        {Object.entries(apiKeysByExchange).map(([exchange, keys]) => (
          <Card key={exchange} title={exchange} size="small" style={{ marginBottom: 12 }}>
            {keys.map((key) => {
              const positions = positionsByKey[key.name] || [];
              const totalPnl = positions.reduce((s, p) => s + Number(p.unrealisedPnl || 0), 0);
              const totalValue = positions.reduce((s, p) => {
                const v = Number(p.positionValueUsdt || p.positionValue || 0);
                return s + (Number.isFinite(v) ? v : 0);
              }, 0);
              return positions.length > 0 ? (
                <div key={key.name} style={{ marginBottom: 8 }}>
                  <Tag color="blue">{key.name}</Tag>
                  <Tag>{positions.length} поз.</Tag>
                  <Tag color={totalPnl >= 0 ? 'green' : 'red'}>UPNL: {totalPnl.toFixed(2)} USDT</Tag>
                  <Tag>Объём: {totalValue.toFixed(1)} USDT</Tag>
                  <Table size="small" rowKey="symbol" dataSource={positions} pagination={false} columns={[
                    { title: 'Символ', dataIndex: 'symbol', width: 120 },
                    { title: 'Сторона', dataIndex: 'side', width: 70, render: (v: string) => <Tag color={v === 'long' ? 'green' : 'red'}>{v}</Tag> },
                    { title: 'Размер', dataIndex: 'size', width: 100 },
                    { title: 'Lev', dataIndex: 'leverage', width: 60 },
                    { title: 'Вход', dataIndex: 'avgPrice', width: 100 },
                    { title: 'Марк', dataIndex: 'markPrice', width: 100 },
                    { title: 'UPNL', dataIndex: 'unrealisedPnl', width: 100, render: (v: string) => <span style={{ color: Number(v) >= 0 ? '#52c41a' : '#ff4d4f' }}>{Number(v).toFixed(4)}</span> },
                    { title: 'Ликв.', dataIndex: 'liqPrice', width: 100 },
                  ]} />
                </div>
              ) : null;
            })}
          </Card>
        ))}
      </Modal>

      <Tabs
        type="card"
        activeKey={activeExchangeTab || undefined}
        onChange={(key) => setActiveExchangeTab(key)}
        items={Object.entries(apiKeysByExchange).map(([exchange, keys]) => ({
        key: exchange,
        label: `${exchange} (${keys.length})`,
        children: (
          <Space direction="vertical" style={{ width: '100%' }}>
            {keys.filter((key) => {
              if (copyTradersOnly && !isCopyTradingKey(key.name, key.tenantDisplayName)) return false;
              if (!hideBelow1Usdt) return true;
              if (balanceErrorByKey[key.name]) return true;
              const balancesLoading = Boolean(loadingByKey[`balances:${key.name}`]);
              if (balancesLoading || !loadedKeys.has(key.name)) return true;
              const totalUsd = (balancesByKey[key.name] || []).reduce((sum, item) => sum + toNumber(item.usdValue), 0);
              if (totalUsd > 1) return true;
              const mon = monitoringRows.find((r) => r.apiKeyName === key.name);
              if (mon?.equityUsd != null) return Number(mon.equityUsd) > 1;
              return totalUsd > 1;
            }).sort((a, b) => {
              const ac = Number(isCopyTradingKey(a.name, a.tenantDisplayName));
              const bc = Number(isCopyTradingKey(b.name, b.tenantDisplayName));
              return bc - ac;
            }).map((key) => {
              const manualDraft = manualOrderDraftByKey[key.name] || {
                symbol: 'BTCUSDT',
                side: 'Buy' as const,
                amount: 0.001,
                amountMode: 'coin' as const,
                orderType: 'market' as const,
              };
              const limitPrice = Number(manualDraft.price);
              const hasLimitPrice = Number.isFinite(limitPrice) && limitPrice > 0;
              const previewQty = manualDraft.amountMode === 'coin'
                ? manualDraft.amount
                : hasLimitPrice
                  ? manualDraft.amount / limitPrice
                  : null;
              const keyPositions = positionsByKey[key.name] || [];
              const keyOrders = ordersByKey[key.name] || [];
              const keyTrades = tradesByKey[key.name] || [];
              const keyBalances = balancesByKey[key.name] || [];
              const positionsLoading = Boolean(loadingByKey[key.name]);
              const ordersLoading = Boolean(loadingByKey[`orders:${key.name}`]);
              const tradesLoading = Boolean(loadingByKey[`trades:${key.name}`]);
              const balancesLoading = Boolean(loadingByKey[`balances:${key.name}`]);
              const keyNotLoaded = !loadedKeys.has(key.name) && !positionsLoading && !balancesLoading;
              const totalUsd = keyBalances.reduce((sum, item) => sum + toNumber(item.usdValue), 0);
              const topBalances = keyBalances
                .filter((item) => toNumber(item.walletBalance) > 0)
                .sort((a, b) => toNumber(b.usdValue) - toNumber(a.usdValue))
                .slice(0, 6);
              return (
                <Card
                  className="battletoads-card"
                  key={key.id}
                  type="inner"
                  title={
                    <Space>
                      {key.name}
                      {isCopyTradingKey(key.name, key.tenantDisplayName) ? <Tag color="purple">copy</Tag> : null}
                    </Space>
                  }
                  size="small"
                  style={{ width: '100%' }}
                  bodyStyle={{ padding: 10 }}
                >
                  {keyNotLoaded ? (
                    <div style={{ padding: 12, textAlign: 'center' }}><Spin size="small" /> <span style={{ marginLeft: 8, color: '#6b7280' }}>Загрузка…</span></div>
                  ) : null}
                  <Space wrap style={{ marginBottom: 8 }}>
                    <Button size="small" onClick={() => openMonChart(key.name)} style={{ background: '#7c3aed', color: '#fff', border: 'none' }}>
                      📈 Мониторинг
                    </Button>
                    <Button
                      loading={positionsLoading || ordersLoading || tradesLoading || balancesLoading}
                      onClick={() => {
                        void fetchPositions(key.name);
                        void fetchOrders(key.name);
                        void fetchBalances(key.name);
                        if (shouldShowTrades) {
                          void fetchTrades(key.name);
                        }
                      }}
                    >
                      {t('common.refresh', 'Refresh')}
                    </Button>
                    <Popconfirm
                      title={t('positions.confirm.cancelAllOrders', 'Cancel all orders for {apiKey}?', { apiKey: key.name })}
                      onConfirm={() => {
                        void runKeyAction(
                          key.name,
                          'cancel-orders',
                          t('positions.msg.ordersCancelled', 'All orders cancelled for {apiKey}', { apiKey: key.name })
                        );
                      }}
                    >
                      <Button loading={Boolean(actionLoading[`${key.name}:cancel-orders`])}>
                        {t('positions.cancelAllOrders', 'Cancel all orders')}
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title={t('positions.confirm.closeAllPositions', 'Close all positions for {apiKey}?', { apiKey: key.name })}
                      onConfirm={() => {
                        void runKeyAction(
                          key.name,
                          'close-positions',
                          t('positions.msg.positionsClosed', 'All positions closed for {apiKey}', { apiKey: key.name })
                        );
                      }}
                    >
                      <Button danger loading={Boolean(actionLoading[`${key.name}:close-positions`])}>
                        {t('positions.closeAllPositions', 'Close all positions')}
                      </Button>
                    </Popconfirm>
                  </Space>

                  <Card className="battletoads-card" size="small" title={t('positions.balances', 'Balances')} style={{ marginBottom: 8 }} bodyStyle={{ padding: 10 }}>
                    <Space direction="vertical" style={{ width: '100%' }} size={6}>
                      {balanceErrorByKey[key.name] ? (
                        <Alert type="error" showIcon message={balanceErrorByKey[key.name]} />
                      ) : null}
                      <Space wrap>
                        <Tag color="blue">{t('positions.totalBalance', 'Total USD')}: {formatCompact(totalUsd, 2)}</Tag>
                        {balancesLoading ? <Tag color="processing">{t('common.loading', 'Loading')}</Tag> : null}
                      </Space>
                      <Space wrap>
                        {topBalances.length > 0 ? topBalances.map((item) => (
                          <Tag key={`${key.name}:${item.coin}`}>
                            {item.coin}: {formatCompact(item.walletBalance, 6)} ({formatCompact(item.usdValue, 2)} USD)
                            {item.marginUsed && toNumber(item.marginUsed) > 0 ? <span style={{ color: '#f59e0b', marginLeft: 4 }}>margin: {formatCompact(item.marginUsed, 4)}</span> : null}
                            {item.unrealisedPnl && toNumber(item.unrealisedPnl) !== 0 ? <span style={{ color: toNumber(item.unrealisedPnl) >= 0 ? '#22c55e' : '#ef4444', marginLeft: 4 }}>PnL: {formatCompact(item.unrealisedPnl, 4)}</span> : null}
                          </Tag>
                        )) : <span style={{ fontSize: 12, color: '#6b7280' }}>{t('positions.empty.balances', 'No non-zero balances')}</span>}
                      </Space>
                    </Space>
                  </Card>

                  <Card className="battletoads-card" size="small" title={t('positions.quickManualOrder', 'Quick Manual Order')} style={{ marginBottom: 8 }} bodyStyle={{ padding: 10 }}>
                    <Space wrap>
                      <Input
                        style={{ width: 130 }}
                        value={manualDraft.symbol}
                        onChange={(e) => {
                          const value = String(e.target.value || '').toUpperCase();
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, symbol: value },
                          }));
                        }}
                        placeholder={t('positions.placeholder.symbol', 'BTCUSDT')}
                      />
                      <Select
                        style={{ width: 90 }}
                        value={manualDraft.side}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, side: value as 'Buy' | 'Sell' },
                          }));
                        }}
                      >
                        <Option value="Buy">{t('positions.buy', 'Buy')}</Option>
                        <Option value="Sell">{t('positions.sell', 'Sell')}</Option>
                      </Select>
                      <Select
                        style={{ width: 105 }}
                        value={manualDraft.orderType}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: {
                              ...manualDraft,
                              orderType: value as ManualOrderType,
                              price: value === 'market' ? undefined : manualDraft.price,
                            },
                          }));
                        }}
                      >
                        <Option value="market">Market</Option>
                        <Option value="limit">Limit</Option>
                      </Select>
                      <Select
                        style={{ width: 105 }}
                        value={manualDraft.amountMode}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, amountMode: value as ManualAmountMode },
                          }));
                        }}
                      >
                        <Option value="coin">Coin</Option>
                        <Option value="usdt">USDT</Option>
                      </Select>
                      <InputNumber
                        style={{ width: 120 }}
                        min={0}
                        step={manualDraft.amountMode === 'coin' ? 0.001 : 1}
                        value={manualDraft.amount}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, amount: Number(value) || 0 },
                          }));
                        }}
                        placeholder={manualDraft.amountMode === 'coin' ? t('positions.placeholder.qty', 'Qty') : t('positions.placeholder.usdt', 'USDT amount')}
                      />
                      <InputNumber
                        style={{ width: 140 }}
                        min={0}
                        step={0.01}
                        value={manualDraft.price}
                        disabled={manualDraft.orderType === 'market'}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, price: value === null ? undefined : Number(value) },
                          }));
                        }}
                        placeholder={manualDraft.orderType === 'limit'
                          ? t('positions.placeholder.price', 'Limit price')
                          : t('positions.placeholder.priceMarket', 'Price auto (market)')}
                      />
                      <Button
                        type="primary"
                        loading={Boolean(actionLoading[`${key.name}:manual-order`])}
                        onClick={() => {
                          void placeManualOrder(key.name);
                        }}
                      >
                        {t('positions.placeOrder', 'Place order')}
                      </Button>
                    </Space>
                    <div style={{ marginTop: 6, fontSize: 12, color: '#6b7280' }}>
                      Qty preview:{' '}
                      {previewQty !== null && Number.isFinite(previewQty) && previewQty > 0
                        ? formatCompact(previewQty, 8)
                        : manualDraft.amountMode === 'usdt'
                          ? (manualDraft.orderType === 'limit'
                            ? 'set limit price to preview exact qty'
                            : 'will be estimated from latest market price at submit')
                          : '-'}
                    </div>
                  </Card>

                  {positionErrorByKey[key.name] ? (
                    <Alert type="error" showIcon message={positionErrorByKey[key.name]} style={{ marginBottom: 12 }} />
                  ) : null}

                  {shouldShowPositions ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>{t('positions.segment.positions', 'Positions')}</Divider>
                      {positionsLoading || keyPositions.length > 0 ? (
                        <Table
                          size="small"
                          rowKey={(row) => `${row.symbol}_${row.side}_${row.avgPrice}`}
                          dataSource={keyPositions}
                          columns={getColumns(key.name)}
                          loading={positionsLoading}
                          locale={{ emptyText: '' }}
                          pagination={keyPositions.length > 8 ? { pageSize: 8, size: 'small' } : false}
                          scroll={{ x: 980 }}
                        />
                      ) : (
                        <div style={{ fontSize: 12, color: '#6b7280', padding: '2px 0 6px' }}>
                          {t('positions.empty.positions', 'No open positions')}
                        </div>
                      )}
                    </>
                  ) : null}

                  {shouldShowOrders ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>{t('positions.openOrders', 'Open Orders')}</Divider>
                      {ordersLoading || keyOrders.length > 0 ? (
                        <Table
                          size="small"
                          rowKey={(row) => row.orderId}
                          dataSource={keyOrders}
                          columns={orderColumns}
                          loading={ordersLoading}
                          locale={{ emptyText: '' }}
                          pagination={keyOrders.length > 8 ? { pageSize: 8, size: 'small' } : false}
                          scroll={{ x: 900 }}
                        />
                      ) : (
                        <div style={{ fontSize: 12, color: '#6b7280', padding: '2px 0 4px' }}>
                          {t('positions.empty.orders', 'No open orders')}
                        </div>
                      )}
                    </>
                  ) : null}

                  {shouldShowTrades ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>{t('positions.recentTrades', 'Recent Trades')}</Divider>
                      {tradesLoading || keyTrades.length > 0 ? (
                        <Table
                          size="small"
                          rowKey={(row) => `${row.tradeId}_${row.timestamp}_${row.symbol}`}
                          dataSource={keyTrades}
                          columns={tradeColumns}
                          loading={tradesLoading}
                          locale={{ emptyText: '' }}
                          pagination={keyTrades.length > 10 ? { pageSize: 10, size: 'small' } : false}
                          scroll={{ x: 1040 }}
                        />
                      ) : (
                        <div style={{ fontSize: 12, color: '#6b7280', padding: '2px 0 4px' }}>
                          {t('positions.empty.trades', 'No recent trades')}
                        </div>
                      )}
                    </>
                  ) : null}
                </Card>
              );
            })}
          </Space>
        ),
      }))} />
        </>
      )}

      <Modal
        title={`Мониторинг: ${monChartKey || '—'}`}
        open={monChartOpen}
        onCancel={() => setMonChartOpen(false)}
        footer={monChartTenantSlug ? (
          <Space wrap>
            <Button onClick={() => void handleCopyPortfolioLink(monChartTenantSlug)}>
              Скопировать public-ссылку
            </Button>
            <Button
              type="primary"
              onClick={() => window.open(buildPublicPortfolioUrl(monChartTenantSlug), '_blank', 'noopener,noreferrer')}
            >
              Открыть портфолио
            </Button>
          </Space>
        ) : null}
        width={960}
      >
        <MonitoringChartPanel
          snapshots={monChartRaw}
          chartDays={monChartDays}
          onChartDaysChange={setMonChartDays}
          periodStats={monChartPeriodStats}
          trades={monChartTrades}
          tradeFrequency={monChartTradeFrequency}
          trades24h={monChartTradeStats.trades24h}
          lastTradeAt={monChartTradeStats.lastTradeAt}
          tradeMarkers={monChartTradeMarkers}
          loading={monChartLoading}
          currencyLabel="USD"
          onBackfillFromExchange={handleBackfillFromExchange}
          backfillLoading={monChartBackfillLoading}
          backfillSupported={monChartBackfillSupported}
        />
      </Modal>
    </div>
  );
};

export default Positions;