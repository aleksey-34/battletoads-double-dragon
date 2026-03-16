import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { Dayjs } from 'dayjs';
import axios from 'axios';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

type BacktestMode = 'single' | 'portfolio';

type ApiKeyRecord = {
  id: number;
  name: string;
  exchange: string;
};

type StrategyRecord = {
  id: number;
  name: string;
  strategy_type?: string;
  interval?: string;
  base_symbol?: string;
  quote_symbol?: string;
  is_active?: boolean;
};

type BacktestPoint = {
  time: number;
  equity: number;
};

type BacktestTrade = {
  strategyId: number;
  strategyName: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  netPnl: number;
  pnlPercent: number;
  fees: number;
  funding: number;
  reason: string;
};

type BacktestSummary = {
  mode: BacktestMode;
  apiKeyName: string;
  strategyIds: number[];
  strategyNames: string[];
  interval: string;
  barsRequested: number;
  barsProcessed: number;
  dateFromMs: number | null;
  dateToMs: number | null;
  warmupBars: number;
  skippedStrategies: number;
  processedStrategies: number;
  initialBalance: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  maxDrawdownAbsolute: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
};

type BacktestRequest = {
  apiKeyName: string;
  mode: BacktestMode;
  strategyId?: number;
  strategyIds?: number[];
  bars: number;
  dateFrom?: string | number;
  dateTo?: string | number;
  warmupBars?: number;
  skipMissingSymbols?: boolean;
  initialBalance: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
};

type BacktestResult = {
  runId?: number;
  request: BacktestRequest;
  summary: BacktestSummary;
  equityCurve: BacktestPoint[];
  trades: BacktestTrade[];
};

type BacktestRunRow = {
  id: number;
  created_at: string;
  api_key_name: string;
  mode: BacktestMode;
  strategy_ids: number[];
  strategy_names: string[];
  interval: string;
  bars: number;
  initial_balance: number;
  final_equity: number;
  total_return_percent: number;
  max_drawdown_percent: number;
  trades_count: number;
  win_rate_percent: number;
  profit_factor: number;
};

const formatNumber = (value: number, digits: number = 2): string => {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return value.toFixed(digits);
};

const formatPercent = (value: number, digits: number = 2): string => {
  if (!Number.isFinite(value)) {
    return '-';
  }
  return `${value.toFixed(digits)}%`;
};

const Backtest: React.FC = () => {
  const { t } = useI18n();
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [apiKeyName, setApiKeyName] = useState<string>('');
  const [strategies, setStrategies] = useState<StrategyRecord[]>([]);

  const [mode, setMode] = useState<BacktestMode>('single');
  const [strategyId, setStrategyId] = useState<number | null>(null);
  const [strategyIds, setStrategyIds] = useState<number[]>([]);

  const [bars, setBars] = useState<number>(1200);
  const [dateFrom, setDateFrom] = useState<Dayjs | null>(null);
  const [dateTo, setDateTo] = useState<Dayjs | null>(null);
  const [warmupBars, setWarmupBars] = useState<number>(0);
  const [skipMissingSymbols, setSkipMissingSymbols] = useState<boolean>(false);
  const [initialBalance, setInitialBalance] = useState<number>(1000);
  const [commissionPercent, setCommissionPercent] = useState<number>(0.06);
  const [slippagePercent, setSlippagePercent] = useState<number>(0.03);
  const [fundingRatePercent, setFundingRatePercent] = useState<number>(0);

  const [loadingApiKeys, setLoadingApiKeys] = useState<boolean>(false);
  const [loadingStrategies, setLoadingStrategies] = useState<boolean>(false);
  const [runLoading, setRunLoading] = useState<boolean>(false);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string>('');
  const [deletingRunId, setDeletingRunId] = useState<number | null>(null);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [historyRows, setHistoryRows] = useState<BacktestRunRow[]>([]);

  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    void loadApiKeys();
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!apiKeyName) {
      setStrategies([]);
      setStrategyId(null);
      setStrategyIds([]);
      return;
    }

    void loadStrategies(apiKeyName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName]);

  const loadApiKeys = useCallback(async () => {
    setLoadingApiKeys(true);
    try {
      const res = await axios.get('/api/api-keys');
      const rows = Array.isArray(res.data) ? (res.data as ApiKeyRecord[]) : [];
      setApiKeys(rows);

      if (rows.length > 0) {
        setApiKeyName((prev) => prev || rows[0].name);
      }
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('backtest.msg.loadApiKeysFailed', 'Failed to load API keys'));
    } finally {
      setLoadingApiKeys(false);
    }
  }, [t]);

  const loadStrategies = useCallback(async (selectedApiKeyName: string) => {
    setLoadingStrategies(true);
    setErrorText('');

    try {
      const res = await axios.get(`/api/backtest/strategies/${selectedApiKeyName}`);
      const rows = Array.isArray(res.data) ? (res.data as StrategyRecord[]) : [];
      setStrategies(rows);

      if (rows.length > 0) {
        setStrategyId((prev) => prev ?? rows[0].id);

        setStrategyIds((prev) => {
          if (prev.length > 0) {
            return prev.filter((value) => rows.some((item) => item.id === value));
          }
          return [rows[0].id];
        });
      } else {
        setStrategyId(null);
        setStrategyIds([]);
      }
    } catch (error: any) {
      console.error(error);
      setErrorText(error?.response?.data?.error || t('backtest.msg.loadStrategiesFailed', 'Failed to load strategies for selected API key'));
      setStrategies([]);
      setStrategyId(null);
      setStrategyIds([]);
    } finally {
      setLoadingStrategies(false);
    }
  }, [t]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await axios.get('/api/backtest/runs', {
        params: {
          limit: 30,
        },
      });
      const rows = Array.isArray(res.data) ? (res.data as BacktestRunRow[]) : [];
      setHistoryRows(rows);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('backtest.msg.loadHistoryFailed', 'Failed to load backtest history'));
    } finally {
      setHistoryLoading(false);
    }
  }, [t]);

  const runBacktest = async () => {
    if (!apiKeyName) {
      message.warning(t('backtest.msg.selectApiKeyFirst', 'Select API key first'));
      return;
    }

    if (mode === 'single' && !strategyId) {
      message.warning(t('backtest.msg.selectSingleStrategy', 'Choose strategy for single mode'));
      return;
    }

    if (mode === 'portfolio' && strategyIds.length === 0) {
      message.warning(t('backtest.msg.selectPortfolioStrategies', 'Choose at least one strategy for portfolio mode'));
      return;
    }

    setRunLoading(true);
    setErrorText('');

    try {
      const payload: BacktestRequest = {
        apiKeyName,
        mode,
        bars,
        dateFrom: dateFrom ? dateFrom.valueOf() : undefined,
        dateTo: dateTo ? dateTo.valueOf() : undefined,
        warmupBars,
        skipMissingSymbols,
        initialBalance,
        commissionPercent,
        slippagePercent,
        fundingRatePercent,
      };

      if (mode === 'single') {
        payload.strategyId = Number(strategyId);
      } else {
        payload.strategyIds = strategyIds;
      }

      const res = await axios.post('/api/backtest/run', {
        ...payload,
        saveResult: true,
      });

      const data = res.data?.result as BacktestResult | undefined;
      if (!data) {
        throw new Error(t('backtest.msg.emptyResult', 'Backtest API returned empty result'));
      }

      setResult(data);
      message.success(t('backtest.msg.finished', 'Backtest finished{runSuffix}', {
        runSuffix: data.runId ? ` (run #${data.runId})` : '',
      }));
      await loadHistory();
    } catch (error: any) {
      console.error(error);
      const statusCode = Number(error?.response?.status || 0);
      const backendError = error?.response?.data?.error || error?.message || t('backtest.msg.failed', 'Backtest failed');
      const userMessage = statusCode === 429
        ? t('backtest.msg.alreadyRunning', 'Backtest already running. Wait until it finishes to avoid overloading live trading.')
        : backendError;

      setErrorText(userMessage);
      message.error(userMessage);
    } finally {
      setRunLoading(false);
    }
  };

  const loadRunById = async (id: number) => {
    try {
      const res = await axios.get(`/api/backtest/runs/${id}`);
      setResult(res.data as BacktestResult);
      message.success(t('backtest.msg.loadedRun', 'Loaded run #{id}', { id }));
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('backtest.msg.loadRunFailed', 'Failed to load run #{id}', { id }));
    }
  };

  const deleteRunById = async (id: number) => {
    setDeletingRunId(id);
    try {
      await axios.delete(`/api/backtest/runs/${id}`);
      if (result?.runId === id) {
        setResult(null);
      }
      await loadHistory();
      message.success(t('backtest.msg.deletedRun', 'Deleted run #{id}', { id }));
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || t('backtest.msg.deleteRunFailed', 'Failed to delete run #{id}', { id }));
    } finally {
      setDeletingRunId(null);
    }
  };

  const strategyOptions = useMemo(
    () => strategies.map((strategy) => ({
      label: `#${strategy.id} ${strategy.name} (${strategy.base_symbol || '?'}/${strategy.quote_symbol || '?'}, ${strategy.interval || '?'})`,
      value: strategy.id,
    })),
    [strategies]
  );

  const equityChartData = useMemo(
    () => (result?.equityCurve || [])
      .map((point) => ({
        time: point.time,
        open: point.equity,
        high: point.equity,
        low: point.equity,
        close: point.equity,
      }))
      .sort((left, right) => left.time - right.time),
    [result]
  );

  const summary = result?.summary || null;

  return (
    <div className="battletoads-form-shell">
      <Card className="battletoads-card" title={t('backtest.runnerTitle', 'Backtest Runner')} extra={<Button onClick={() => { void loadHistory(); }} loading={historyLoading}>{t('backtest.refreshHistory', 'Refresh history')}</Button>}>
        <Space direction="vertical" style={{ width: '100%' }} size={14}>
          {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.apiKey', 'API Key')}</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                loading={loadingApiKeys}
                value={apiKeyName || undefined}
                placeholder={t('backtest.selectApiKey', 'Select API key')}
                onChange={(value) => setApiKeyName(value)}
                options={apiKeys.map((item) => ({
                  label: `${item.name} (${item.exchange})`,
                  value: item.name,
                }))}
              />
            </Col>

            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.mode', 'Mode')}</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                value={mode}
                onChange={(value: BacktestMode) => setMode(value)}
                options={[
                  { label: t('backtest.mode.single', 'Single Strategy'), value: 'single' },
                  { label: t('backtest.mode.portfolio', 'Portfolio (shared balance)'), value: 'portfolio' },
                ]}
              />
            </Col>
          </Row>

          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.barsFallback', 'Bars (fallback)')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={120}
                max={20000}
                step={100}
                value={bars}
                onChange={(value) => setBars(Number(value || 1200))}
              />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
                {t('backtest.barsHint', 'Used when Date From/To are not set, and as extra fetch depth for indicator warmup.')}
              </Typography.Text>
            </Col>

            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.initialBalance', 'Initial Balance')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={10}
                max={100000000}
                value={initialBalance}
                onChange={(value) => setInitialBalance(Number(value || 1000))}
              />
            </Col>
          </Row>

          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.dateFrom', 'Date From')}</Typography.Text>
              <DatePicker
                showTime
                format="YYYY-MM-DD HH:mm:ss"
                style={{ width: '100%', marginTop: 6 }}
                placeholder={t('backtest.selectStartDate', 'Select start date')}
                value={dateFrom}
                onChange={(value) => setDateFrom(value)}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.dateTo', 'Date To')}</Typography.Text>
              <DatePicker
                showTime
                format="YYYY-MM-DD HH:mm:ss"
                style={{ width: '100%', marginTop: 6 }}
                placeholder={t('backtest.selectEndDate', 'Select end date')}
                value={dateTo}
                onChange={(value) => setDateTo(value)}
              />
            </Col>
          </Row>

          <Row gutter={[12, 12]}>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.warmupBars', 'Warmup / Freeze Bars')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={0}
                max={5000}
                step={1}
                value={warmupBars}
                onChange={(value) => setWarmupBars(Number(value || 0))}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text strong>{t('backtest.skipUnusableHistory', 'Skip pairs with unusable history')}</Typography.Text>
              <div style={{ marginTop: 10 }}>
                <Switch checked={skipMissingSymbols} onChange={(checked) => setSkipMissingSymbols(checked)} />
              </div>
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
                {t('backtest.skipHint', 'Off by default: pairs start from first available candles and warm up before trading.')}
              </Typography.Text>
            </Col>
          </Row>

          {mode === 'single' ? (
            <div>
              <Typography.Text strong>{t('backtest.strategy', 'Strategy')}</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                loading={loadingStrategies}
                value={strategyId || undefined}
                placeholder={t('backtest.selectStrategy', 'Select strategy')}
                options={strategyOptions}
                onChange={(value) => setStrategyId(Number(value))}
              />
            </div>
          ) : (
            <div>
              <Typography.Text strong>{t('backtest.portfolioStrategies', 'Strategies (shared balance pool)')}</Typography.Text>
              <Select
                mode="multiple"
                style={{ width: '100%', marginTop: 6 }}
                loading={loadingStrategies}
                value={strategyIds}
                placeholder={t('backtest.selectMultipleStrategies', 'Select one or more strategies')}
                options={strategyOptions}
                onChange={(values) => setStrategyIds(values.map((value) => Number(value)))}
              />
            </div>
          )}

          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <Typography.Text strong>{t('backtest.commission', 'Commission %')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={0}
                max={5}
                step={0.01}
                value={commissionPercent}
                onChange={(value) => setCommissionPercent(Number(value || 0))}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text strong>{t('backtest.slippage', 'Slippage %')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={0}
                max={5}
                step={0.01}
                value={slippagePercent}
                onChange={(value) => setSlippagePercent(Number(value || 0))}
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text strong>{t('backtest.fundingPerEvent', 'Funding % per Event')}</Typography.Text>
              <InputNumber
                style={{ width: '100%', marginTop: 6 }}
                min={-5}
                max={5}
                step={0.01}
                value={fundingRatePercent}
                onChange={(value) => setFundingRatePercent(Number(value || 0))}
              />
            </Col>
          </Row>

          <Space>
            <Button type="primary" loading={runLoading} onClick={() => { void runBacktest(); }}>
              {t('backtest.run', 'Run Backtest')}
            </Button>
            <Button
              onClick={() => {
                setResult(null);
                setErrorText('');
              }}
            >
              {t('backtest.clear', 'Clear Result')}
            </Button>
          </Space>
        </Space>
      </Card>

      {summary ? (
        <Card className="battletoads-card" title={t('backtest.summary', 'Backtest Summary')} style={{ marginTop: 16 }}>
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.initial', 'Initial')} value={summary.initialBalance} precision={2} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.final', 'Final')} value={summary.finalEquity} precision={2} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.return', 'Return')} value={summary.totalReturnPercent} precision={2} suffix="%" /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.maxDd', 'Max DD')} value={summary.maxDrawdownPercent} precision={2} suffix="%" /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.trades', 'Trades')} value={summary.tradesCount} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.winRate', 'Win Rate')} value={summary.winRatePercent} precision={2} suffix="%" /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.profitFactor', 'Profit Factor')} value={summary.profitFactor} precision={2} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.bars', 'Bars')} value={summary.barsProcessed} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.processedStrategies', 'Processed Strategies')} value={summary.processedStrategies ?? summary.strategyIds.length} /></Col>
            <Col xs={12} md={6}><Statistic title={t('backtest.stat.skippedStrategies', 'Skipped Strategies')} value={summary.skippedStrategies ?? 0} /></Col>
          </Row>

          <Space style={{ marginTop: 12 }} wrap>
            <Tag color={summary.mode === 'portfolio' ? 'gold' : 'blue'}>{summary.mode.toUpperCase()}</Tag>
            <Tag>{summary.apiKeyName}</Tag>
            <Tag>{summary.interval}</Tag>
            {summary.dateFromMs ? <Tag>{t('backtest.from', 'From')} {new Date(summary.dateFromMs).toLocaleString()}</Tag> : null}
            {summary.dateToMs ? <Tag>{t('backtest.to', 'To')} {new Date(summary.dateToMs).toLocaleString()}</Tag> : null}
            <Tag>{t('backtest.warmup', 'Warmup')} {summary.warmupBars ?? 0}</Tag>
            <Tag>{t('backtest.commissionShort', 'Commission')} {formatPercent(summary.commissionPercent, 3)}</Tag>
            <Tag>{t('backtest.slippageShort', 'Slippage')} {formatPercent(summary.slippagePercent, 3)}</Tag>
            <Tag>{t('backtest.fundingShort', 'Funding')} {formatPercent(summary.fundingRatePercent, 3)}</Tag>
          </Space>

          <Typography.Paragraph style={{ marginTop: 12, marginBottom: 0 }}>
            {summary.strategyNames.join(', ')}
          </Typography.Paragraph>
        </Card>
      ) : null}

      <Card className="battletoads-card" title={t('backtest.equityCurve', 'Equity Curve')} style={{ marginTop: 16 }}>
        {equityChartData.length > 0
          ? <ChartComponent data={equityChartData} type="line" />
          : <Alert type="info" showIcon message={t('backtest.equityHint', 'Run a backtest or load history to display equity curve.')} />}
      </Card>

      <Card className="battletoads-card" title={t('backtest.trades', 'Trades')} style={{ marginTop: 16 }}>
        <Table<BacktestTrade>
          dataSource={result?.trades || []}
          rowKey={(row) => `${row.entryTime}_${row.exitTime}_${row.strategyId}_${row.side}`}
          size="small"
          pagination={{ pageSize: 12 }}
          scroll={{ x: 1200 }}
          columns={[
            {
              title: t('backtest.col.strategy', 'Strategy'),
              dataIndex: 'strategyName',
              key: 'strategyName',
              render: (value: string, row: BacktestTrade) => `#${row.strategyId} ${value}`,
            },
            {
              title: t('backtest.col.side', 'Side'),
              dataIndex: 'side',
              key: 'side',
              render: (value: 'long' | 'short') => <Tag color={value === 'long' ? 'green' : 'red'}>{value}</Tag>,
            },
            {
              title: t('backtest.col.entry', 'Entry'),
              key: 'entry',
              render: (_: unknown, row: BacktestTrade) => new Date(row.entryTime).toLocaleString(),
            },
            {
              title: t('backtest.col.exit', 'Exit'),
              key: 'exit',
              render: (_: unknown, row: BacktestTrade) => new Date(row.exitTime).toLocaleString(),
            },
            {
              title: t('backtest.col.entryPrice', 'Entry Px'),
              dataIndex: 'entryPrice',
              key: 'entryPrice',
              render: (value: number) => formatNumber(value, 6),
            },
            {
              title: t('backtest.col.exitPrice', 'Exit Px'),
              dataIndex: 'exitPrice',
              key: 'exitPrice',
              render: (value: number) => formatNumber(value, 6),
            },
            {
              title: t('backtest.col.notional', 'Notional'),
              dataIndex: 'notional',
              key: 'notional',
              render: (value: number) => formatNumber(value, 2),
            },
            {
              title: t('backtest.col.netPnl', 'Net PnL'),
              dataIndex: 'netPnl',
              key: 'netPnl',
              render: (value: number) => (
                <span style={{ color: value >= 0 ? '#166534' : '#b91c1c' }}>
                  {formatNumber(value, 2)}
                </span>
              ),
            },
            {
              title: t('backtest.col.pnlPercent', 'PnL %'),
              dataIndex: 'pnlPercent',
              key: 'pnlPercent',
              render: (value: number) => formatPercent(value, 2),
            },
            {
              title: t('backtest.col.fees', 'Fees'),
              dataIndex: 'fees',
              key: 'fees',
              render: (value: number) => formatNumber(value, 3),
            },
            {
              title: t('backtest.col.funding', 'Funding'),
              dataIndex: 'funding',
              key: 'funding',
              render: (value: number) => formatNumber(value, 3),
            },
            {
              title: t('backtest.col.reason', 'Reason'),
              dataIndex: 'reason',
              key: 'reason',
            },
          ]}
        />
      </Card>

      <Card className="battletoads-card" title={t('backtest.history', 'Backtest History')} style={{ marginTop: 16 }}>
        <Table<BacktestRunRow>
          dataSource={historyRows}
          rowKey={(row) => String(row.id)}
          size="small"
          loading={historyLoading}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 1200 }}
          columns={[
            { title: t('backtest.col.run', 'Run'), dataIndex: 'id', key: 'id', width: 80 },
            {
              title: t('backtest.col.created', 'Created'),
              dataIndex: 'created_at',
              key: 'created_at',
              render: (value: string) => value ? new Date(value).toLocaleString() : '-',
            },
            { title: t('backtest.col.apiKey', 'API Key'), dataIndex: 'api_key_name', key: 'api_key_name' },
            {
              title: t('backtest.col.mode', 'Mode'),
              dataIndex: 'mode',
              key: 'mode',
              render: (value: BacktestMode) => <Tag color={value === 'portfolio' ? 'gold' : 'blue'}>{value}</Tag>,
            },
            {
              title: t('backtest.col.strategies', 'Strategies'),
              dataIndex: 'strategy_names',
              key: 'strategy_names',
              render: (value: string[]) => (Array.isArray(value) ? value.join(', ') : '-'),
            },
            {
              title: t('backtest.col.return', 'Return'),
              dataIndex: 'total_return_percent',
              key: 'total_return_percent',
              render: (value: number) => formatPercent(value, 2),
            },
            {
              title: t('backtest.col.maxDd', 'Max DD'),
              dataIndex: 'max_drawdown_percent',
              key: 'max_drawdown_percent',
              render: (value: number) => formatPercent(value, 2),
            },
            {
              title: t('backtest.col.trades', 'Trades'),
              dataIndex: 'trades_count',
              key: 'trades_count',
            },
            {
              title: t('backtest.col.action', 'Action'),
              key: 'action',
              render: (_: unknown, row: BacktestRunRow) => (
                <Space wrap>
                  <Button size="small" onClick={() => { void loadRunById(row.id); }}>
                    {t('backtest.load', 'Load')}
                  </Button>
                  <Popconfirm
                    title={t('backtest.deleteConfirm', 'Delete run #{id}?', { id: row.id })}
                    onConfirm={() => { void deleteRunById(row.id); }}
                  >
                    <Button size="small" danger loading={deletingRunId === row.id}>
                      {t('backtest.delete', 'Delete')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default Backtest;
