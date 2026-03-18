import React, { useEffect, useMemo, useState } from 'react';
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
} from 'antd';
import axios from 'axios';
import { useI18n } from '../i18n';

/* eslint-disable react-hooks/exhaustive-deps */

const { Option } = Select;

type ApiKey = {
  id: number;
  name: string;
  exchange: string;
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

const Positions: React.FC = () => {
  const { t } = useI18n();
  const [positionsByKey, setPositionsByKey] = useState<{ [key: string]: PositionRow[] }>({});
  const [ordersByKey, setOrdersByKey] = useState<{ [key: string]: OrderRow[] }>({});
  const [tradesByKey, setTradesByKey] = useState<{ [key: string]: TradeRow[] }>({});
  const [loadingByKey, setLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [errorByKey, setErrorByKey] = useState<{ [key: string]: string }>({});
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [actionLoading, setActionLoading] = useState<{ [key: string]: boolean }>({});
  const [refreshAllLoading, setRefreshAllLoading] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [manualOrderDraftByKey, setManualOrderDraftByKey] = useState<{ [key: string]: ManualOrderDraft }>({});

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    void fetchApiKeys();
  }, []);

  const fetchApiKeys = async () => {
    try {
      const res = await axios.get('/api/api-keys');
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

      for (const key of keys) {
        void fetchPositions(key.name);
        void fetchOrders(key.name);
        void fetchTrades(key.name);
      }
    } catch (error) {
      console.error(error);
    }
  };

  const fetchPositions = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [apiKeyName]: true }));
    setErrorByKey((prev) => ({ ...prev, [apiKeyName]: '' }));

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
      setPositionsByKey((prev) => ({ ...prev, [apiKeyName]: [] }));
      setErrorByKey((prev) => ({
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
      setOrdersByKey((prev) => ({ ...prev, [apiKeyName]: [] }));
      setErrorByKey((prev) => ({
        ...prev,
        [apiKeyName]: error.response?.data?.error || t('positions.msg.loadOrdersFailed', 'Failed to load open orders'),
      }));
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
      setTradesByKey((prev) => ({ ...prev, [apiKeyName]: [] }));
      setErrorByKey((prev) => ({
        ...prev,
        [apiKeyName]: error.response?.data?.error || t('positions.msg.loadTradesFailed', 'Failed to load trade history'),
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`trades:${apiKeyName}`]: false }));
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
      for (const key of apiKeys) {
        await fetchPositions(key.name);
        await fetchOrders(key.name);
        await fetchTrades(key.name);
      }
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

  const apiKeysByExchange = useMemo(() => {
    return apiKeys.reduce((acc, apiKey) => {
      const exchange = apiKey.exchange || t('common.unknown', 'Unknown');
      if (!acc[exchange]) {
        acc[exchange] = [];
      }
      acc[exchange].push(apiKey);
      return acc;
    }, {} as { [exchange: string]: ApiKey[] });
  }, [apiKeys, t]);

  const shouldShowPositions = viewMode === 'positions' || viewMode === 'all';
  const shouldShowOrders = viewMode === 'orders' || viewMode === 'all';
  const shouldShowTrades = viewMode === 'trades' || viewMode === 'all';

  return (
    <div className="positions-page">
      <Space style={{ marginBottom: 8 }}>
        <Button loading={refreshAllLoading} onClick={() => { void refreshAllPositions(); }}>
          {t('positions.refreshAll', 'Refresh all')}
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
      </Space>

      {Object.entries(apiKeysByExchange).map(([exchange, keys]) => (
        <Card className="battletoads-card" key={exchange} title={`${t('positions.exchange', 'Exchange')}: ${exchange}`} size="small" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {keys.map((key) => {
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
              const positionsLoading = Boolean(loadingByKey[key.name]);
              const ordersLoading = Boolean(loadingByKey[`orders:${key.name}`]);
              const tradesLoading = Boolean(loadingByKey[`trades:${key.name}`]);
              return (
                <Card
                  className="battletoads-card"
                  key={key.id}
                  type="inner"
                  title={`${key.name}`}
                  size="small"
                  style={{ width: '100%' }}
                  bodyStyle={{ padding: 10 }}
                >
                  <Space wrap style={{ marginBottom: 8 }}>
                    <Button
                      loading={positionsLoading || ordersLoading}
                      onClick={() => {
                        void fetchPositions(key.name);
                        void fetchOrders(key.name);
                        void fetchTrades(key.name);
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

                  {errorByKey[key.name] ? (
                    <Alert type="error" showIcon message={errorByKey[key.name]} style={{ marginBottom: 12 }} />
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
        </Card>
      ))}
    </div>
  );
};

export default Positions;