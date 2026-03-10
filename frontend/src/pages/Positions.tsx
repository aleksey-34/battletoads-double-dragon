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

type ManualOrderDraft = {
  symbol: string;
  side: 'Buy' | 'Sell';
  qty: number;
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

const Positions: React.FC = () => {
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
      const res = await axios.get('http://localhost:3001/api/api-keys');
      const keys: ApiKey[] = Array.isArray(res.data) ? res.data : [];
      setApiKeys(keys);

      setManualOrderDraftByKey((prev) => {
        const next = { ...prev };
        for (const key of keys) {
          if (!next[key.name]) {
            next[key.name] = {
              symbol: 'BTCUSDT',
              side: 'Buy',
              qty: 0.001,
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
      const res = await axios.get(`http://localhost:3001/api/positions/${apiKeyName}`);
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
        [apiKeyName]: error.response?.data?.error || 'Failed to load positions',
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [apiKeyName]: false }));
    }
  };

  const fetchOrders = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [`orders:${apiKeyName}`]: true }));

    try {
      const res = await axios.get(`http://localhost:3001/api/orders/${apiKeyName}`);
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
        [apiKeyName]: error.response?.data?.error || 'Failed to load open orders',
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`orders:${apiKeyName}`]: false }));
    }
  };

  const fetchTrades = async (apiKeyName: string) => {
    setLoadingByKey((prev) => ({ ...prev, [`trades:${apiKeyName}`]: true }));

    try {
      const res = await axios.get(`http://localhost:3001/api/trades/${apiKeyName}`, {
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
        [apiKeyName]: error.response?.data?.error || 'Failed to load trade history',
      }));
    } finally {
      setLoadingByKey((prev) => ({ ...prev, [`trades:${apiKeyName}`]: false }));
    }
  };

  const closePositionPart = async (apiKeyName: string, row: PositionRow, percent: number) => {
    const actionKey = `${apiKeyName}:${row.symbol}:${row.side}:${percent}`;

    try {
      setActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`http://localhost:3001/api/positions/${apiKeyName}/close-percent`, {
        symbol: row.symbol,
        side: row.side,
        percent,
      });

      message.success(`Closed ${percent}% for ${row.symbol} (${row.side})`);
      await fetchPositions(apiKeyName);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || `Failed to close ${percent}% of ${row.symbol}`);
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
        await axios.post(`http://localhost:3001/api/orders/${apiKeyName}/cancel-all`);
      } else {
        await axios.post(`http://localhost:3001/api/positions/${apiKeyName}/close-all`);
      }

      message.success(successText);
      await Promise.all([
        fetchPositions(apiKeyName),
        fetchOrders(apiKeyName),
        fetchTrades(apiKeyName),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || `Failed action: ${action}`);
    } finally {
      setActionLoading((prev) => ({ ...prev, [actionKey]: false }));
    }
  };

  const placeManualOrder = async (apiKeyName: string) => {
    const draft = manualOrderDraftByKey[apiKeyName];
    if (!draft || !draft.symbol || !draft.qty || draft.qty <= 0) {
      message.warning('Set symbol and qty before placing manual order');
      return;
    }

    const actionKey = `${apiKeyName}:manual-order`;

    try {
      setActionLoading((prev) => ({ ...prev, [actionKey]: true }));
      await axios.post(`http://localhost:3001/api/manual-order/${apiKeyName}`, {
        symbol: draft.symbol,
        side: draft.side,
        qty: String(draft.qty),
        price: draft.price && draft.price > 0 ? String(draft.price) : undefined,
      });

      message.success(`Manual order placed for ${apiKeyName}`);
      await Promise.all([
        fetchOrders(apiKeyName),
        fetchPositions(apiKeyName),
        fetchTrades(apiKeyName),
      ]);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to place manual order');
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
      message.success('Positions, orders and trades refreshed for all API keys');
    } catch (error) {
      console.error(error);
      message.error('Failed to refresh all positions');
    } finally {
      setRefreshAllLoading(false);
    }
  };

  const getColumns = (apiKeyName: string) => [
    { title: 'Symbol', dataIndex: 'symbol', key: 'symbol' },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const normalized = String(side || '').toLowerCase();
        const isLong = normalized === 'buy';
        return <Tag color={isLong ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    { title: 'Size', dataIndex: 'size', key: 'size' },
    { title: 'Entry Price', dataIndex: 'avgPrice', key: 'avgPrice' },
    { title: 'Mark Price', dataIndex: 'markPrice', key: 'markPrice' },
    { title: 'Liq Price', dataIndex: 'liqPrice', key: 'liqPrice' },
    { title: 'Leverage', dataIndex: 'leverage', key: 'leverage' },
    {
      title: 'Position Value',
      dataIndex: 'positionValue',
      key: 'positionValue',
      render: (value: string) => formatCompact(value, 4),
    },
    {
      title: 'Value (USDT)',
      dataIndex: 'positionValueUsdt',
      key: 'positionValueUsdt',
    },
    {
      title: 'UPnL',
      dataIndex: 'unrealisedPnl',
      key: 'unrealisedPnl',
      render: (value: string) => {
        const numeric = toNumber(value);
        const color = numeric > 0 ? '#16a34a' : numeric < 0 ? '#dc2626' : '#4b5563';
        return <span style={{ color, fontWeight: 600 }}>{formatCompact(numeric, 4)}</span>;
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_: any, row: PositionRow) => {
        const key25 = `${apiKeyName}:${row.symbol}:${row.side}:25`;
        const key50 = `${apiKeyName}:${row.symbol}:${row.side}:50`;
        const key100 = `${apiKeyName}:${row.symbol}:${row.side}:100`;

        return (
          <Space wrap>
            <Button size="small" loading={Boolean(actionLoading[key25])} onClick={() => { void closePositionPart(apiKeyName, row, 25); }}>
              Close 25%
            </Button>
            <Button size="small" loading={Boolean(actionLoading[key50])} onClick={() => { void closePositionPart(apiKeyName, row, 50); }}>
              Close 50%
            </Button>
            <Button size="small" danger loading={Boolean(actionLoading[key100])} onClick={() => { void closePositionPart(apiKeyName, row, 100); }}>
              Close 100%
            </Button>
          </Space>
        );
      },
    },
  ];

  const orderColumns = [
    { title: 'Symbol', dataIndex: 'symbol', key: 'symbol' },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const normalized = String(side || '').toLowerCase();
        const isBuy = normalized === 'buy';
        return <Tag color={isBuy ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    { title: 'Type', dataIndex: 'orderType', key: 'orderType' },
    {
      title: 'Qty',
      dataIndex: 'qty',
      key: 'qty',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      key: 'price',
      render: (value: string) => (value === '-' ? '-' : formatCompact(value, 6)),
    },
    { title: 'Status', dataIndex: 'orderStatus', key: 'orderStatus' },
    {
      title: 'Reduce',
      dataIndex: 'reduceOnly',
      key: 'reduceOnly',
      render: (value: boolean) => <Tag color={value ? 'orange' : 'default'}>{value ? 'Yes' : 'No'}</Tag>,
    },
    {
      title: 'Created',
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
      title: 'Time',
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
    { title: 'Symbol', dataIndex: 'symbol', key: 'symbol' },
    {
      title: 'Side',
      dataIndex: 'side',
      key: 'side',
      render: (side: string) => {
        const isBuy = String(side || '').toLowerCase() === 'buy';
        return <Tag color={isBuy ? 'green' : 'red'}>{side}</Tag>;
      },
    },
    {
      title: 'Qty',
      dataIndex: 'qty',
      key: 'qty',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: 'Price',
      dataIndex: 'price',
      key: 'price',
      render: (value: string) => formatCompact(value, 6),
    },
    {
      title: 'Notional',
      dataIndex: 'notional',
      key: 'notional',
      render: (value: string) => formatCompact(value, 2),
    },
    {
      title: 'Fee',
      key: 'fee',
      render: (_: unknown, row: TradeRow) => {
        const feeValue = formatCompact(row.fee, 6);
        return `${feeValue}${row.feeCurrency ? ` ${row.feeCurrency}` : ''}`;
      },
    },
    {
      title: 'Realized PnL',
      dataIndex: 'realizedPnl',
      key: 'realizedPnl',
      render: (value: string) => {
        const numeric = toNumber(value);
        const color = numeric > 0 ? '#16a34a' : numeric < 0 ? '#dc2626' : '#4b5563';
        return <span style={{ color, fontWeight: 600 }}>{formatCompact(numeric, 4)}</span>;
      },
    },
    {
      title: 'Maker',
      dataIndex: 'isMaker',
      key: 'isMaker',
      render: (value: boolean) => <Tag color={value ? 'blue' : 'default'}>{value ? 'Maker' : 'Taker'}</Tag>,
    },
  ];

  const apiKeysByExchange = useMemo(() => {
    return apiKeys.reduce((acc, apiKey) => {
      const exchange = apiKey.exchange || 'Unknown';
      if (!acc[exchange]) {
        acc[exchange] = [];
      }
      acc[exchange].push(apiKey);
      return acc;
    }, {} as { [exchange: string]: ApiKey[] });
  }, [apiKeys]);

  const shouldShowPositions = viewMode === 'positions' || viewMode === 'all';
  const shouldShowOrders = viewMode === 'orders' || viewMode === 'all';
  const shouldShowTrades = viewMode === 'trades' || viewMode === 'all';

  return (
    <div className="positions-page">
      <Space style={{ marginBottom: 8 }}>
        <Button loading={refreshAllLoading} onClick={() => { void refreshAllPositions(); }}>
          Refresh all
        </Button>
        <Segmented<ViewMode>
          value={viewMode}
          onChange={(value) => setViewMode(value as ViewMode)}
          options={[
            { label: 'Positions', value: 'positions' },
            { label: 'Orders', value: 'orders' },
            { label: 'Trades', value: 'trades' },
            { label: 'All', value: 'all' },
          ]}
        />
      </Space>

      {Object.entries(apiKeysByExchange).map(([exchange, keys]) => (
        <Card key={exchange} title={`Exchange: ${exchange}`} size="small" style={{ marginBottom: 12 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {keys.map((key) => {
              const manualDraft = manualOrderDraftByKey[key.name] || { symbol: 'BTCUSDT', side: 'Buy' as const, qty: 0.001 };
              const keyPositions = positionsByKey[key.name] || [];
              const keyOrders = ordersByKey[key.name] || [];
              const keyTrades = tradesByKey[key.name] || [];
              const positionsLoading = Boolean(loadingByKey[key.name]);
              const ordersLoading = Boolean(loadingByKey[`orders:${key.name}`]);
              const tradesLoading = Boolean(loadingByKey[`trades:${key.name}`]);
              return (
                <Card
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
                      Refresh
                    </Button>
                    <Popconfirm
                      title={`Cancel all orders for ${key.name}?`}
                      onConfirm={() => {
                        void runKeyAction(key.name, 'cancel-orders', `All orders cancelled for ${key.name}`);
                      }}
                    >
                      <Button loading={Boolean(actionLoading[`${key.name}:cancel-orders`])}>
                        Cancel all orders
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title={`Close all positions for ${key.name}?`}
                      onConfirm={() => {
                        void runKeyAction(key.name, 'close-positions', `All positions closed for ${key.name}`);
                      }}
                    >
                      <Button danger loading={Boolean(actionLoading[`${key.name}:close-positions`])}>
                        Close all positions
                      </Button>
                    </Popconfirm>
                  </Space>

                  <Card size="small" title="Quick Manual Order" style={{ marginBottom: 8 }} bodyStyle={{ padding: 10 }}>
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
                        placeholder="BTCUSDT"
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
                        <Option value="Buy">Buy</Option>
                        <Option value="Sell">Sell</Option>
                      </Select>
                      <InputNumber
                        style={{ width: 120 }}
                        min={0}
                        step={0.001}
                        value={manualDraft.qty}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, qty: Number(value) || 0 },
                          }));
                        }}
                        placeholder="Qty"
                      />
                      <InputNumber
                        style={{ width: 140 }}
                        min={0}
                        step={0.01}
                        value={manualDraft.price}
                        onChange={(value) => {
                          setManualOrderDraftByKey((prev) => ({
                            ...prev,
                            [key.name]: { ...manualDraft, price: value === null ? undefined : Number(value) },
                          }));
                        }}
                        placeholder="Price (market if empty)"
                      />
                      <Button
                        type="primary"
                        loading={Boolean(actionLoading[`${key.name}:manual-order`])}
                        onClick={() => {
                          void placeManualOrder(key.name);
                        }}
                      >
                        Place order
                      </Button>
                    </Space>
                  </Card>

                  {errorByKey[key.name] ? (
                    <Alert type="error" showIcon message={errorByKey[key.name]} style={{ marginBottom: 12 }} />
                  ) : null}

                  {shouldShowPositions ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>Positions</Divider>
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
                          No open positions
                        </div>
                      )}
                    </>
                  ) : null}

                  {shouldShowOrders ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>Open Orders</Divider>
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
                          No open orders
                        </div>
                      )}
                    </>
                  ) : null}

                  {shouldShowTrades ? (
                    <>
                      <Divider style={{ margin: '6px 0' }}>Recent Trades</Divider>
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
                          No recent trades
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