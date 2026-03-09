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

type ViewMode = 'positions' | 'orders' | 'both';

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
  const [loadingByKey, setLoadingByKey] = useState<{ [key: string]: boolean }>({});
  const [errorByKey, setErrorByKey] = useState<{ [key: string]: string }>({});
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [actionLoading, setActionLoading] = useState<{ [key: string]: boolean }>({});
  const [refreshAllLoading, setRefreshAllLoading] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ViewMode>('both');
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
      }
      message.success('Positions and orders refreshed for all API keys');
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

  const shouldShowPositions = viewMode === 'positions' || viewMode === 'both';
  const shouldShowOrders = viewMode === 'orders' || viewMode === 'both';

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Button loading={refreshAllLoading} onClick={() => { void refreshAllPositions(); }}>
          Refresh all
        </Button>
        <Segmented<ViewMode>
          value={viewMode}
          onChange={(value) => setViewMode(value as ViewMode)}
          options={[
            { label: 'Positions', value: 'positions' },
            { label: 'Orders', value: 'orders' },
            { label: 'Positions + Orders', value: 'both' },
          ]}
        />
      </Space>

      {Object.entries(apiKeysByExchange).map(([exchange, keys]) => (
        <Card key={exchange} title={`Exchange: ${exchange}`} style={{ marginBottom: 16 }}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {keys.map((key) => {
              const manualDraft = manualOrderDraftByKey[key.name] || { symbol: 'BTCUSDT', side: 'Buy' as const, qty: 0.001 };
              return (
                <Card
                  key={key.id}
                  type="inner"
                  title={`${key.name}`}
                  style={{ width: '100%' }}
                  bodyStyle={{ padding: 12 }}
                >
                  <Space wrap style={{ marginBottom: 12 }}>
                    <Button
                      loading={Boolean(loadingByKey[key.name]) || Boolean(loadingByKey[`orders:${key.name}`])}
                      onClick={() => {
                        void fetchPositions(key.name);
                        void fetchOrders(key.name);
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

                  <Card size="small" title="Quick Manual Order" style={{ marginBottom: 12 }}>
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
                      <Divider style={{ margin: '10px 0' }}>Positions</Divider>
                      <Table
                        size="small"
                        rowKey={(row) => `${row.symbol}_${row.side}_${row.avgPrice}`}
                        dataSource={positionsByKey[key.name] || []}
                        columns={getColumns(key.name)}
                        loading={loadingByKey[key.name]}
                        pagination={{ pageSize: 8 }}
                        scroll={{ x: 980 }}
                      />
                    </>
                  ) : null}

                  {shouldShowOrders ? (
                    <>
                      <Divider style={{ margin: '10px 0' }}>Open Orders</Divider>
                      <Table
                        size="small"
                        rowKey={(row) => row.orderId}
                        dataSource={ordersByKey[key.name] || []}
                        columns={orderColumns}
                        loading={loadingByKey[`orders:${key.name}`]}
                        pagination={{ pageSize: 8 }}
                        scroll={{ x: 900 }}
                      />
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