import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import axios from 'axios';
import ChartComponent from '../components/ChartComponent';
import { useI18n } from '../i18n';

const { Paragraph, Text, Title } = Typography;

const initialTradingSystemsParams = new URLSearchParams(window.location.search);
const initialApiKeyNameFromUrl = String(initialTradingSystemsParams.get('apiKeyName') || '').trim();
const initialSystemIdFromUrlRaw = Number(initialTradingSystemsParams.get('systemId') || '');
const initialSystemIdFromUrl = Number.isFinite(initialSystemIdFromUrlRaw) && initialSystemIdFromUrlRaw > 0
  ? initialSystemIdFromUrlRaw
  : null;

type ApiKeyRecord = {
  id: number;
  name: string;
  exchange: string;
};

type StrategySummary = {
  id: number;
  name: string;
  strategy_type?: string;
  base_symbol?: string;
  quote_symbol?: string;
  interval?: string;
};

type TradingSystemMember = {
  id?: number;
  system_id: number;
  strategy_id: number;
  weight: number;
  member_role: string;
  is_enabled: boolean;
  notes: string;
  strategy?: StrategySummary | null;
};

type TradingSystemMetrics = {
  equity_usd: number;
  unrealized_pnl: number;
  margin_load_percent: number;
  drawdown_percent: number;
  effective_leverage: number;
  recorded_at?: string;
};

type TradingSystem = {
  id?: number;
  name: string;
  description: string;
  is_active: boolean;
  auto_sync_members: boolean;
  discovery_enabled: boolean;
  discovery_interval_hours: number;
  max_members: number;
  members: TradingSystemMember[];
  metrics?: TradingSystemMetrics;
};

type BacktestPoint = {
  time: number;
  equity: number;
};

type MonitoringPoint = {
  recorded_at?: string;
  margin_load_percent?: number;
  drawdown_percent?: number;
};

type BacktestSummary = {
  initialBalance: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  strategyNames: string[];
  interval: string;
  barsRequested?: number;
  barsProcessed?: number;
  dateFromMs?: number;
  dateToMs?: number;
  warmupBars?: number;
};

type BacktestResult = {
  runId?: number;
  summary: BacktestSummary;
  equityCurve: BacktestPoint[];
};

type BacktestTuning = {
  riskMultiplier: number;
  targetTrades: number;
  bars: number;
};

type AnalysisReport = {
  strategyId: number;
  strategyName: string;
  symbol: string;
  metrics: Record<string, any>;
  recommendation: {
    recommendation: string;
    severity: string;
    confidence: number;
    rationale: string;
  };
};

type AnalysisResponse = {
  system_id: number;
  system_name: string;
  period_hours: number;
  recommendations_count: number;
  reports: AnalysisReport[];
};

type FrequencyDiagnostics = {
  success: boolean;
  targetTrades: number;
  targetTradesPerDay: number;
  inferredSweepDays: number;
  currentTradesEstimate: number;
  currentTradesPerDayEstimate: number;
  range: {
    minTrades: number;
    maxTrades: number;
  };
  adjustable: boolean;
  nearTarget: boolean;
  recommendation: string;
  memberDiagnostics: Array<{
    strategyId: number;
    strategyName: string;
    market: string;
    interval: string;
    weight: number;
    trades: number;
    tradesPerDay: number;
    profitFactor: number;
    maxDrawdownPercent: number;
  }>;
  candidateSuggestions: Array<{
    strategyId: number;
    strategyName: string;
    tradesPerDay: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    score: number;
  }>;
};

type LiquiditySuggestion = {
  id: number;
  system_id: number;
  symbol: string;
  suggested_action: 'add' | 'replace' | 'watch';
  score: number;
  details_json?: string;
  status: 'new' | 'accepted' | 'rejected' | 'applied';
  created_at: string | number;
};

type Copy = {
  title: string;
  subtitle: string;
  apiKey: string;
  refresh: string;
  systems: string;
  members: string;
  open: string;
  delete: string;
  deleteConfirm: string;
  backtest: string;
  analysis: string;
  suggestions: string;
  scan: string;
  periodHours: string;
  status: string;
  active: string;
  discovery: string;
  interval: string;
  noSystems: string;
  loading: string;
  weights: string;
  role: string;
  notes: string;
  recommendation: string;
  severity: string;
  confidence: string;
  rationale: string;
  replaceSymbol: string;
  action: string;
};

const COPY_BY_LANGUAGE: Record<'ru' | 'en' | 'tr', Copy> = {
  ru: {
    title: 'Trading Systems',
    subtitle: 'Ручные торговые системы (настройка админом): состав, веса, backtest, анализ и liquidity suggestions. Это отдельный слой от sweep-профилей.',
    apiKey: 'API-ключ',
    refresh: 'Обновить',
    systems: 'Системы',
    members: 'Состав',
    open: 'Открыть',
    delete: 'Удалить',
    deleteConfirm: 'Удалить эту торговую систему?',
    backtest: 'Запустить backtest ТС',
    analysis: 'Анализировать ТС',
    suggestions: 'Liquidity suggestions',
    scan: 'Скан ликвидности',
    periodHours: 'Период анализа, ч',
    status: 'Статус',
    active: 'Активна',
    discovery: 'Discovery',
    interval: 'Интервал',
    noSystems: 'Для этого API-ключа торговые системы не найдены.',
    loading: 'Загрузка...',
    weights: 'Вес',
    role: 'Роль',
    notes: 'Заметки',
    recommendation: 'Рекомендация',
    severity: 'Серьезность',
    confidence: 'Уверенность',
    rationale: 'Обоснование',
    replaceSymbol: 'Замена',
    action: 'Действие',
  },
  en: {
    title: 'Trading Systems',
    subtitle: 'Manual trading systems (admin-configured): members, weights, backtests, analysis, and liquidity suggestions. This is separate from sweep profiles.',
    apiKey: 'API Key',
    refresh: 'Refresh',
    systems: 'Systems',
    members: 'Members',
    open: 'Open',
    delete: 'Delete',
    deleteConfirm: 'Delete this trading system?',
    backtest: 'Run system backtest',
    analysis: 'Analyze system',
    suggestions: 'Liquidity suggestions',
    scan: 'Liquidity scan',
    periodHours: 'Analysis period, h',
    status: 'Status',
    active: 'Active',
    discovery: 'Discovery',
    interval: 'Interval',
    noSystems: 'No trading systems found for this API key.',
    loading: 'Loading...',
    weights: 'Weight',
    role: 'Role',
    notes: 'Notes',
    recommendation: 'Recommendation',
    severity: 'Severity',
    confidence: 'Confidence',
    rationale: 'Rationale',
    replaceSymbol: 'Replace',
    action: 'Action',
  },
  tr: {
    title: 'Trading Systems',
    subtitle: 'Manuel trading system katmani (admin ayari): uyeler, agirliklar, backtest, analiz ve liquidity suggestions. Sweep profillerinden ayridir.',
    apiKey: 'API Key',
    refresh: 'Yenile',
    systems: 'Sistemler',
    members: 'Uyeler',
    open: 'Ac',
    delete: 'Sil',
    deleteConfirm: 'Bu trading system silinsin mi?',
    backtest: 'System backtest calistir',
    analysis: 'System analiz et',
    suggestions: 'Liquidity suggestions',
    scan: 'Likidite taramasi',
    periodHours: 'Analiz periyodu, saat',
    status: 'Durum',
    active: 'Aktif',
    discovery: 'Discovery',
    interval: 'Interval',
    noSystems: 'Bu API key icin trading system bulunamadi.',
    loading: 'Yukleniyor...',
    weights: 'Agirlik',
    role: 'Rol',
    notes: 'Notlar',
    recommendation: 'Oneri',
    severity: 'Seviye',
    confidence: 'Guven',
    rationale: 'Gerekce',
    replaceSymbol: 'Degistir',
    action: 'Aksiyon',
  },
};

const formatNumber = (value: unknown, digits = 2): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  return numeric.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
};

const formatPercent = (value: unknown, digits = 2): string => `${formatNumber(value, digits)}%`;

const parseSuggestionDetails = (value?: string): Record<string, any> => {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
};

const TradingSystems: React.FC = () => {
  const { language } = useI18n();
  const copy = COPY_BY_LANGUAGE[language];
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [apiKeyName, setApiKeyName] = useState(initialApiKeyNameFromUrl);
  const [systems, setSystems] = useState<TradingSystem[]>([]);
  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(initialSystemIdFromUrl);
  const [selectedSystem, setSelectedSystem] = useState<TradingSystem | null>(null);
  const [systemsLoading, setSystemsLoading] = useState(false);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemActionLoading, setSystemActionLoading] = useState('');
  const [periodHours, setPeriodHours] = useState(24);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResponse | null>(null);
  const [suggestions, setSuggestions] = useState<LiquiditySuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [frequencyDiagnostics, setFrequencyDiagnostics] = useState<FrequencyDiagnostics | null>(null);
  const [frequencyDiagnosticsLoading, setFrequencyDiagnosticsLoading] = useState(false);
  const [safeMembersApply, setSafeMembersApply] = useState(true);
  const [monitoringPoints, setMonitoringPoints] = useState<MonitoringPoint[]>([]);
  const [memberDraftsByStrategyId, setMemberDraftsByStrategyId] = useState<Record<number, { weight: number; is_enabled: boolean }>>({});
  const [backtestTuning, setBacktestTuning] = useState<BacktestTuning>({
    riskMultiplier: 1,
    targetTrades: 160,
    bars: 1200,
  });

  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    void loadApiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!apiKeyName) {
      setSystems([]);
      setSelectedSystemId(null);
      setSelectedSystem(null);
      return;
    }

    void loadSystems(apiKeyName);
    void loadSuggestions(apiKeyName);
    void loadMonitoring(apiKeyName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName]);

  useEffect(() => {
    if (!apiKeyName || !selectedSystemId) {
      setSelectedSystem(null);
      setMemberDraftsByStrategyId({});
      setFrequencyDiagnostics(null);
      return;
    }

    void loadSystem(apiKeyName, selectedSystemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName, selectedSystemId]);

  useEffect(() => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadFrequencyDiagnostics(apiKeyName, selectedSystemId, Math.max(20, Math.floor(backtestTuning.targetTrades)));
    }, 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyName, selectedSystemId, backtestTuning.targetTrades]);

  const loadApiKeys = useCallback(async () => {
    try {
      const response = await axios.get<ApiKeyRecord[]>('/api/api-keys');
      const rows = Array.isArray(response.data) ? response.data : [];
      setApiKeys(rows);
      if (rows.length > 0) {
        setApiKeyName((current) => current || rows[0].name);
      }
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load API keys'));
    }
  }, []);

  const loadSystems = useCallback(async (nextApiKeyName: string) => {
    setSystemsLoading(true);
    try {
      const response = await axios.get<TradingSystem[]>(`/api/trading-systems/${encodeURIComponent(nextApiKeyName)}`);
      const rows = Array.isArray(response.data) ? response.data : [];
      setSystems(rows);
      setSelectedSystemId((current) => {
        if (current && rows.some((item) => Number(item.id) === current)) {
          return current;
        }
        return rows[0]?.id ? Number(rows[0].id) : null;
      });
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load trading systems'));
      setSystems([]);
      setSelectedSystemId(null);
      setSelectedSystem(null);
    } finally {
      setSystemsLoading(false);
    }
  }, []);

  const loadMonitoring = useCallback(async (nextApiKeyName: string) => {
    if (!nextApiKeyName) {
      setMonitoringPoints([]);
      return;
    }

    try {
      const response = await axios.get(`/api/monitoring/${encodeURIComponent(nextApiKeyName)}`, {
        params: { limit: 240 },
      });
      const points = Array.isArray(response.data?.points) ? response.data.points : [];
      setMonitoringPoints(points);
    } catch {
      setMonitoringPoints([]);
    }
  }, []);

  const loadSystem = useCallback(async (nextApiKeyName: string, systemId: number) => {
    setSystemLoading(true);
    try {
      const response = await axios.get<TradingSystem>(`/api/trading-systems/${encodeURIComponent(nextApiKeyName)}/${systemId}`);
      setSelectedSystem(response.data);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load trading system'));
      setSelectedSystem(null);
    } finally {
      setSystemLoading(false);
    }
  }, []);

  const loadFrequencyDiagnostics = useCallback(async (nextApiKeyName: string, systemId: number, targetTrades: number) => {
    setFrequencyDiagnosticsLoading(true);
    try {
      const response = await axios.get<FrequencyDiagnostics>(`/api/trading-systems/${encodeURIComponent(nextApiKeyName)}/${systemId}/frequency-diagnostics`, {
        params: {
          targetTrades,
          targetTradesPerDay: Math.max(1, Number((targetTrades / 50).toFixed(2))),
        },
      });
      setFrequencyDiagnostics(response.data || null);
    } catch {
      setFrequencyDiagnostics(null);
    } finally {
      setFrequencyDiagnosticsLoading(false);
    }
  }, []);

  const runSystemBacktest = async () => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }

    setSystemActionLoading('backtest');
    try {
      const memberWeights = Object.fromEntries(
        Object.entries(memberDraftsByStrategyId).map(([strategyId, draft]) => [
          String(strategyId),
          Number(draft.weight),
        ])
      );

      const enabledMembers = Object.fromEntries(
        Object.entries(memberDraftsByStrategyId).map(([strategyId, draft]) => [
          String(strategyId),
          draft.is_enabled,
        ])
      );

      const tunedBars = Math.max(240, Math.floor(backtestTuning.bars));

      const response = await axios.post(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${selectedSystemId}/backtest`, {
        saveResult: true,
        bars: tunedBars,
        initialBalance: 1000,
        riskMultiplier: Math.max(0.25, Math.min(3, Number(backtestTuning.riskMultiplier) || 1)),
        memberWeights,
        enabledMembers,
      });
      const result = response.data?.result as BacktestResult | undefined;
      if (!result) {
        throw new Error('Trading system backtest returned empty result');
      }
      setBacktestResult(result);
      message.success('Trading system backtest finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to run trading system backtest'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const saveMemberDrafts = async () => {
    if (!apiKeyName || !selectedSystemId || !selectedSystem) {
      return;
    }

    const members = (selectedSystem.members || []).map((member) => {
      const draft = memberDraftsByStrategyId[member.strategy_id];
      return {
        strategy_id: member.strategy_id,
        member_role: member.member_role,
        notes: member.notes,
        is_enabled: draft ? draft.is_enabled : member.is_enabled,
        weight: draft ? Math.max(0, Number(draft.weight)) : Number(member.weight),
      };
    });

    setSystemActionLoading('members-save');
    try {
      const response = await axios.put(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${selectedSystemId}/members`, {
        members,
        safeApply: safeMembersApply,
        options: {
          safeApply: safeMembersApply,
          cancelRemovedOrders: true,
          closeRemovedPositions: true,
          syncMemberActivation: true,
        },
      });
      message.success('Trading system members updated');
      const orchestration = response.data?.orchestration;
      if (orchestration) {
        const removedSymbols = Array.isArray(orchestration.removedSymbols) ? orchestration.removedSymbols.length : 0;
        const closedPositions = Number(orchestration.closedPositions || 0);
        const warnings = Array.isArray(orchestration.warnings) ? orchestration.warnings.length : 0;
        message.info(`Safe apply: removedSymbols=${removedSymbols}, closedPositions=${closedPositions}, warnings=${warnings}`);
      }
      await loadSystem(apiKeyName, selectedSystemId);
      await loadSystems(apiKeyName);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to update trading system members'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const runSystemAnalysis = async () => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }

    setSystemActionLoading('analysis');
    try {
      const response = await axios.post<AnalysisResponse>(`/api/analytics/${encodeURIComponent(apiKeyName)}/system/${selectedSystemId}/analysis`, {
        periodHours,
      });
      setAnalysisResult(response.data);
      message.success('Trading system analysis finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to analyze trading system'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const loadSuggestions = useCallback(async (nextApiKeyName: string) => {
    if (!nextApiKeyName) {
      return;
    }

    setSuggestionsLoading(true);
    try {
      const response = await axios.get(`/api/analytics/${encodeURIComponent(nextApiKeyName)}/liquidity-suggestions`, {
        params: {
          status: 'all',
          limit: 100,
        },
      });
      const rows = Array.isArray(response.data?.suggestions) ? response.data.suggestions : [];
      setSuggestions(rows);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to load liquidity suggestions'));
      setSuggestions([]);
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  const runLiquidityScan = async () => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading('scan');
    try {
      await axios.post(`/api/analytics/${encodeURIComponent(apiKeyName)}/liquidity-scan/run`, {
        topUniverseLimit: 120,
        maxAddSuggestions: 3,
        maxReplaceSuggestions: 2,
      });
      await loadSuggestions(apiKeyName);
      message.success('Liquidity scan finished');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to run liquidity scan'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const updateSuggestionStatus = async (suggestionId: number, status: 'accepted' | 'rejected' | 'applied') => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading(`suggestion-${suggestionId}`);
    try {
      await axios.patch(`/api/analytics/${encodeURIComponent(apiKeyName)}/liquidity-suggestions/${suggestionId}/status`, {
        status,
      });
      await loadSuggestions(apiKeyName);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to update suggestion status'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const deleteSystem = async (systemId: number) => {
    if (!apiKeyName) {
      return;
    }

    setSystemActionLoading(`delete-${systemId}`);
    try {
      await axios.delete(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${systemId}`);
      if (selectedSystemId === systemId) {
        setBacktestResult(null);
        setAnalysisResult(null);
      }
      await loadSystems(apiKeyName);
      await loadSuggestions(apiKeyName);
      message.success('Trading system deleted');
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to delete trading system'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const setSystemActivation = async (isActive: boolean) => {
    if (!apiKeyName || !selectedSystemId) {
      return;
    }

    setSystemActionLoading('activation');
    try {
      await axios.post(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${selectedSystemId}/activation`, {
        isActive,
        syncMembers: false,
      });
      message.success(isActive ? 'Trading system activated' : 'Trading system deactivated');
      await loadSystem(apiKeyName, selectedSystemId);
      await loadSystems(apiKeyName);
    } catch (error: any) {
      message.error(String(error?.response?.data?.error || error?.message || 'Failed to update trading system activation'));
    } finally {
      setSystemActionLoading('');
    }
  };

  const equityChartData = useMemo(
    () => (backtestResult?.equityCurve || [])
      .map((point) => ({ time: point.time, value: point.equity }))
      .sort((left, right) => left.time - right.time),
    [backtestResult]
  );

  const drawdownChartData = useMemo(() => {
    if (equityChartData.length === 0) {
      return [] as Array<{ time: number; value: number }>;
    }

    let peak = Number(equityChartData[0].value);
    return equityChartData.map((point) => {
      const value = Number(point.value);
      if (value > peak) {
        peak = value;
      }
      const drawdownPercent = peak > 0 ? ((peak - value) / peak) * 100 : 0;
      return {
        time: point.time,
        value: Number(drawdownPercent.toFixed(6)),
      };
    });
  }, [equityChartData]);

  const marginLoadChartData = useMemo(
    () => (monitoringPoints || [])
      .map((point) => ({
        time: point.recorded_at ? Math.floor(new Date(point.recorded_at).getTime() / 1000) : 0,
        value: Number(point.margin_load_percent),
      }))
      .filter((point) => Number.isFinite(point.time) && point.time > 0 && Number.isFinite(point.value))
      .sort((left, right) => left.time - right.time),
    [monitoringPoints]
  );

  const visibleSuggestions = useMemo(
    () => suggestions.filter((item) => !selectedSystemId || Number(item.system_id) === selectedSystemId),
    [selectedSystemId, suggestions]
  );

  useEffect(() => {
    const nextDrafts: Record<number, { weight: number; is_enabled: boolean }> = {};
    for (const member of selectedSystem?.members || []) {
      nextDrafts[member.strategy_id] = {
        weight: Number(member.weight || 0),
        is_enabled: Boolean(member.is_enabled),
      };
    }
    setMemberDraftsByStrategyId(nextDrafts);
  }, [selectedSystem]);

  const systemSummary = useMemo(() => {
    const members = selectedSystem?.members || [];
    const enabledMembers = members.filter((member) => memberDraftsByStrategyId[member.strategy_id]?.is_enabled ?? member.is_enabled);
    const totalWeight = enabledMembers.reduce((sum, member) => {
      const draft = memberDraftsByStrategyId[member.strategy_id];
      return sum + Math.max(0, Number(draft ? draft.weight : member.weight));
    }, 0);

    return {
      membersCount: members.length,
      enabledCount: enabledMembers.length,
      totalWeight,
    };
  }, [memberDraftsByStrategyId, selectedSystem]);

  const explainRecommendation = (row: AnalysisReport): string => {
    const metrics = row.metrics || {};
    const samples = Number(metrics.samples_count || 0);
    if (samples <= 0) {
      return 'Нет live-сделок в выбранном периоде. Рекомендация построена без статистической базы, поэтому это информационный статус.';
    }

    const pnlDrift = Number(metrics.realized_vs_predicted_pnl_percent || 0);
    const slip = Number(metrics.actual_avg_slippage_percent || 0);
    const winLive = Number(metrics.win_rate_live || 0);
    const winBacktest = Number(metrics.win_rate_backtest || 0);

    return `Сэмплов: ${formatNumber(samples, 0)}. Drift PnL: ${formatPercent(pnlDrift, 2)}. Slippage: ${formatPercent(slip * 100, 3)}. WinRate live/backtest: ${formatPercent(winLive * 100, 1)} / ${formatPercent(winBacktest * 100, 1)}.`;
  };

  return (
    <div className="battletoads-form-shell">
      <Card className="battletoads-card" bordered={false}>
        <Title level={3} style={{ marginTop: 0, marginBottom: 8 }}>{copy.title}</Title>
        <Paragraph style={{ marginBottom: 0 }}>{copy.subtitle}</Paragraph>
      </Card>

      <Card className="battletoads-card" style={{ marginTop: 16 }}>
        <Row gutter={[16, 16]} align="middle">
          <Col xs={24} lg={8}>
            <Text strong>{copy.apiKey}</Text>
            <Select
              style={{ width: '100%', marginTop: 8 }}
              value={apiKeyName || undefined}
              onChange={setApiKeyName}
              options={apiKeys.map((item) => ({ value: item.name, label: `${item.name} (${item.exchange})` }))}
            />
          </Col>
          <Col xs={24} md={12} lg={4}>
            <Text strong>{copy.periodHours}</Text>
            <InputNumber min={1} max={720} style={{ width: '100%', marginTop: 8 }} value={periodHours} onChange={(value) => setPeriodHours(Number(value || 24))} />
          </Col>
          <Col xs={24} lg={12}>
            <Space wrap style={{ marginTop: 30 }}>
              <Tooltip title="Обновить список систем и выбранную карточку">
                <Button onClick={() => { void loadSystems(apiKeyName); void loadMonitoring(apiKeyName); }} loading={systemsLoading}>{copy.refresh}</Button>
              </Tooltip>
              <Tooltip title="Подтянуть текущие liquidity suggestions">
                <Button onClick={() => void loadSuggestions(apiKeyName)} loading={suggestionsLoading}>{copy.suggestions}</Button>
              </Tooltip>
              <Tooltip title="Запустить новый скан ликвидности по рынку">
                <Button onClick={() => void runLiquidityScan()} loading={systemActionLoading === 'scan'}>{copy.scan}</Button>
              </Tooltip>
            </Space>
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 0 }}>
        <Col xs={24} xl={10}>
          <Card className="battletoads-card" title={copy.systems}>
            <Table<TradingSystem>
              size="small"
              rowKey={(row) => String(row.id)}
              dataSource={systems}
              loading={systemsLoading}
              pagination={false}
              locale={{ emptyText: <Empty description={copy.noSystems} /> }}
              columns={[
                {
                  title: 'Name',
                  key: 'name',
                  ellipsis: true,
                  render: (_value, row) => (
                    <Space direction="vertical" size={0}>
                      <Text strong>{row.name}</Text>
                      <Text type="secondary">#{row.id}</Text>
                    </Space>
                  ),
                },
                {
                  title: copy.status,
                  key: 'status',
                  width: 160,
                  render: (_value, row) => (
                    <Space direction="vertical" size={4}>
                      <Tag color={row.is_active ? 'success' : 'default'}>{copy.active}: {row.is_active ? 'yes' : 'no'}</Tag>
                      <Tag color={row.discovery_enabled ? 'processing' : 'default'}>{copy.discovery}: {row.discovery_enabled ? 'on' : 'off'}</Tag>
                    </Space>
                  ),
                },
                {
                  title: copy.action,
                  key: 'action',
                  width: 150,
                  render: (_value, row) => (
                    <Space wrap>
                      <Button size="small" onClick={() => setSelectedSystemId(Number(row.id))}>{copy.open}</Button>
                      <Popconfirm title={copy.deleteConfirm} onConfirm={() => void deleteSystem(Number(row.id))}>
                        <Button size="small" danger loading={systemActionLoading === `delete-${row.id}`}>
                          {copy.delete}
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        <Col xs={24} xl={14}>
          <Card
            className="battletoads-card"
            title={selectedSystem?.name || copy.members}
            extra={selectedSystem ? (
              <Space wrap>
                <Tooltip title="Включить/выключить торговую систему целиком (статус active/inactive)">
                  <Button onClick={() => void setSystemActivation(!selectedSystem.is_active)} loading={systemActionLoading === 'activation'}>
                    {selectedSystem.is_active ? 'Deactivate system' : 'Activate system'}
                  </Button>
                </Tooltip>
                <Tooltip title="Записать новые веса/статусы блоков в торговую систему">
                  <Button onClick={() => void saveMemberDrafts()} loading={systemActionLoading === 'members-save'}>Сохранить блоки</Button>
                </Tooltip>
                <Tooltip title="Safe apply: отменить ордера и закрыть позиции по удаляемым парам перед применением нового состава">
                  <Checkbox checked={safeMembersApply} onChange={(e) => setSafeMembersApply(e.target.checked)}>
                    Safe apply
                  </Checkbox>
                </Tooltip>
                <Tooltip title="Бэктест учитывает текущие веса блоков и параметры ниже">
                  <Button onClick={() => void runSystemBacktest()} loading={systemActionLoading === 'backtest'}>{copy.backtest}</Button>
                </Tooltip>
                <Tooltip title="Сравнение с live-данными и рекомендации по каждой стратегии">
                  <Button onClick={() => void runSystemAnalysis()} loading={systemActionLoading === 'analysis'}>{copy.analysis}</Button>
                </Tooltip>
              </Space>
            ) : null}
          >
            <Spin spinning={systemLoading} tip={copy.loading}>
              {selectedSystem ? (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <Row gutter={[12, 12]}>
                    <Col xs={12} md={8}><Card size="small"><Text type="secondary">Members</Text><div><Text strong>{systemSummary.membersCount}</Text></div></Card></Col>
                    <Col xs={12} md={8}><Card size="small"><Text type="secondary">Enabled</Text><div><Text strong>{systemSummary.enabledCount}</Text></div></Card></Col>
                    <Col xs={24} md={8}><Card size="small"><Text type="secondary">Total weight</Text><div><Text strong>{formatNumber(systemSummary.totalWeight, 3)}</Text></div></Card></Col>
                  </Row>

                  <Card size="small" title="Live Metrics" style={{ backgroundColor: '#fafafa' }}>
                    <Row gutter={[12, 12]}>
                      <Col xs={12} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Equity</Text>
                          <div><Text strong style={{ fontSize: 16 }}>${formatNumber(selectedSystem.metrics?.equity_usd ?? 0, 2)}</Text></div>
                        </Card>
                      </Col>
                      <Col xs={12} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Unrealized PnL</Text>
                          <div>
                            <Text
                              strong
                              style={{
                                fontSize: 16,
                                color: Number(selectedSystem.metrics?.unrealized_pnl ?? 0) >= 0 ? '#52c41a' : '#ff4d4f'
                              }}
                            >
                              ${formatNumber(selectedSystem.metrics?.unrealized_pnl ?? 0, 2)}
                            </Text>
                          </div>
                        </Card>
                      </Col>
                      <Col xs={12} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Drawdown</Text>
                          <div>
                            <Text
                              strong
                              style={{
                                fontSize: 16,
                                color: Number(selectedSystem.metrics?.drawdown_percent ?? 0) > 20
                                  ? '#ff4d4f'
                                  : (Number(selectedSystem.metrics?.drawdown_percent ?? 0) > 10 ? '#faad14' : '#52c41a')
                              }}
                            >
                              {formatPercent(selectedSystem.metrics?.drawdown_percent ?? 0, 2)}
                            </Text>
                          </div>
                        </Card>
                      </Col>
                      <Col xs={12} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Margin Load</Text>
                          <div><Text strong style={{ fontSize: 16 }}>{formatPercent(selectedSystem.metrics?.margin_load_percent ?? 0, 2)}</Text></div>
                        </Card>
                      </Col>
                      <Col xs={12} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Leverage</Text>
                          <div><Text strong style={{ fontSize: 16 }}>{formatNumber(selectedSystem.metrics?.effective_leverage ?? 0, 2)}x</Text></div>
                        </Card>
                      </Col>
                      <Col xs={24} sm={12} md={8}>
                        <Card size="small" bordered>
                          <Text type="secondary">Updated</Text>
                          <div>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {selectedSystem.metrics?.recorded_at
                                ? new Date(selectedSystem.metrics.recorded_at).toLocaleString()
                                : 'No snapshot yet'}
                            </Text>
                          </div>
                        </Card>
                      </Col>
                    </Row>
                  </Card>

                  <Card size="small" title="Параметры запуска backtest">
                    <Row gutter={[12, 12]}>
                      <Col xs={24} md={8}>
                        <Text strong>Риск-множитель: {formatNumber(backtestTuning.riskMultiplier, 2)}</Text>
                        <Slider min={0.25} max={3} step={0.05} value={backtestTuning.riskMultiplier} onChange={(value) => setBacktestTuning((prev) => ({ ...prev, riskMultiplier: Number(value) || 1 }))} />
                      </Col>
                      <Col xs={24} md={8}>
                        <Text strong>Цель по сделкам: {formatNumber(backtestTuning.targetTrades, 0)}</Text>
                        <Slider min={20} max={500} step={5} value={backtestTuning.targetTrades} onChange={(value) => {
                          const target = Number(value) || 160;
                          setBacktestTuning((prev) => ({
                            ...prev,
                            targetTrades: target,
                            bars: Math.max(240, target * 8),
                          }));
                        }} />
                      </Col>
                      <Col xs={24} md={8}>
                        <Text strong>Глубина (bars)</Text>
                        <InputNumber min={240} max={20000} step={20} style={{ width: '100%', marginTop: 8 }} value={backtestTuning.bars} onChange={(value) => setBacktestTuning((prev) => ({ ...prev, bars: Math.max(240, Number(value || 1200)) }))} />
                      </Col>
                    </Row>
                    <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                      Период бэктеста определяется глубиной candles (bars) и интервалом стратегий. Чем больше bars, тем длиннее исторический отрезок.
                    </Paragraph>
                    <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
                      Цель по сделкам влияет на подбор и оценку в бэктесте/свипе, но не является прямой крутилкой live-лотности в algofund.
                    </Paragraph>
                    <Spin spinning={frequencyDiagnosticsLoading}>
                      {frequencyDiagnostics ? (
                        <div style={{ marginTop: 10 }}>
                          <Space wrap>
                            <Tag color={frequencyDiagnostics.adjustable ? 'success' : 'warning'}>
                              {frequencyDiagnostics.adjustable ? 'Frequency adjustable' : 'Low frequency flexibility'}
                            </Tag>
                            <Tag color={frequencyDiagnostics.nearTarget ? 'success' : 'processing'}>
                              {frequencyDiagnostics.nearTarget ? 'Near target trades' : 'Far from target trades'}
                            </Tag>
                            <Text type="secondary">
                              Est: {formatNumber(frequencyDiagnostics.currentTradesEstimate, 0)} trades / {frequencyDiagnostics.inferredSweepDays}d ({formatNumber(frequencyDiagnostics.currentTradesPerDayEstimate, 2)}/day)
                            </Text>
                          </Space>
                          <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
                            {frequencyDiagnostics.recommendation}
                          </Paragraph>
                        </div>
                      ) : null}
                    </Spin>
                  </Card>

                  <Descriptions column={1} bordered size="small">
                    <Descriptions.Item label="ID">{selectedSystem.id}</Descriptions.Item>
                    <Descriptions.Item label={copy.status}>{selectedSystem.is_active ? 'active' : 'inactive'}</Descriptions.Item>
                    <Descriptions.Item label={copy.discovery}>{selectedSystem.discovery_enabled ? `on (${selectedSystem.discovery_interval_hours}h)` : 'off'}</Descriptions.Item>
                    <Descriptions.Item label="Auto sync">{selectedSystem.auto_sync_members ? 'on' : 'off'}</Descriptions.Item>
                    <Descriptions.Item label="Max members">{selectedSystem.max_members}</Descriptions.Item>
                    <Descriptions.Item label="Description">{selectedSystem.description || '—'}</Descriptions.Item>
                  </Descriptions>

                  <Alert
                    type="info"
                    showIcon
                    message="Status=active: система участвует в торговом контуре. Discovery: авто-поиск кандидатов/обновлений состава. Auto sync: при включении/выключении системы автоматически синхронизировать статусы стратегий-участников."
                  />

                  <Table<TradingSystemMember>
                    size="small"
                    rowKey={(row) => `${row.system_id}-${row.strategy_id}`}
                    dataSource={selectedSystem.members || []}
                    pagination={false}
                    columns={[
                      {
                        title: 'Strategy',
                        key: 'strategy',
                        ellipsis: true,
                        render: (_value, row) => (
                          <Space direction="vertical" size={0}>
                            <Text strong>{row.strategy?.name || `#${row.strategy_id}`}</Text>
                            <Text type="secondary">{row.strategy?.base_symbol || '—'} · {row.strategy?.interval || '—'}</Text>
                          </Space>
                        ),
                      },
                      {
                        title: copy.weights,
                        dataIndex: 'weight',
                        key: 'weight',
                        width: 140,
                        render: (_value, row) => (
                          <InputNumber
                            min={0}
                            max={50}
                            step={0.05}
                            style={{ width: 120 }}
                            value={memberDraftsByStrategyId[row.strategy_id]?.weight ?? Number(row.weight)}
                            onChange={(value) => {
                              const nextWeight = Number(value ?? 0);
                              setMemberDraftsByStrategyId((prev) => ({
                                ...prev,
                                [row.strategy_id]: {
                                  weight: Number.isFinite(nextWeight) ? nextWeight : 0,
                                  is_enabled: prev[row.strategy_id]?.is_enabled ?? Boolean(row.is_enabled),
                                },
                              }));
                            }}
                          />
                        ),
                      },
                      {
                        title: copy.role,
                        dataIndex: 'member_role',
                        key: 'member_role',
                        width: 90,
                        render: (value) => <Tag>{String(value || 'core')}</Tag>,
                      },
                      {
                        title: copy.status,
                        dataIndex: 'is_enabled',
                        key: 'is_enabled',
                        width: 120,
                        render: (_value, row) => (
                          <Switch
                            size="small"
                            checked={memberDraftsByStrategyId[row.strategy_id]?.is_enabled ?? Boolean(row.is_enabled)}
                            onChange={(checked) => {
                              setMemberDraftsByStrategyId((prev) => ({
                                ...prev,
                                [row.strategy_id]: {
                                  weight: prev[row.strategy_id]?.weight ?? Number(row.weight),
                                  is_enabled: checked,
                                },
                              }));
                            }}
                          />
                        ),
                      },
                      {
                        title: copy.notes,
                        dataIndex: 'notes',
                        key: 'notes',
                        ellipsis: true,
                      },
                    ]}
                  />
                </Space>
              ) : (
                <Empty description={copy.noSystems} />
              )}
            </Spin>
          </Card>
        </Col>
      </Row>

      {backtestResult ? (
        <Card className="battletoads-card" title={copy.backtest} style={{ marginTop: 16 }}>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Initial">{formatNumber(backtestResult.summary.initialBalance)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Final">{formatNumber(backtestResult.summary.finalEquity)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Return">{formatPercent(backtestResult.summary.totalReturnPercent)}</Descriptions.Item></Descriptions></Col>
            <Col xs={12} md={6}><Descriptions column={1} bordered size="small"><Descriptions.Item label="Max DD">{formatPercent(backtestResult.summary.maxDrawdownPercent)}</Descriptions.Item></Descriptions></Col>
          </Row>

          <Space wrap style={{ marginTop: 12 }}>
            <Tag>{copy.interval}: {backtestResult.summary.interval || '—'}</Tag>
            <Tag>Trades: {formatNumber(backtestResult.summary.tradesCount, 0)}</Tag>
            <Tag>PF: {formatNumber(backtestResult.summary.profitFactor)}</Tag>
            <Tag>WR: {formatPercent(backtestResult.summary.winRatePercent)}</Tag>
            <Tag>Bars: {formatNumber(backtestResult.summary.barsRequested, 0)}</Tag>
            <Tag>Processed: {formatNumber(backtestResult.summary.barsProcessed, 0)}</Tag>
          </Space>

          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Period: {backtestResult.summary.dateFromMs ? new Date(backtestResult.summary.dateFromMs).toISOString().slice(0, 10) : 'auto'} {' to '} {backtestResult.summary.dateToMs ? new Date(backtestResult.summary.dateToMs).toISOString().slice(0, 10) : 'auto'}.
            Warmup: {formatNumber(backtestResult.summary.warmupBars, 0)} bars.
          </Paragraph>

          <div style={{ marginTop: 16 }}>
            {equityChartData.length > 0 ? <ChartComponent data={equityChartData} type="line" /> : <Empty description={copy.backtest} />}
          </div>

          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={24} xl={12}>
              <Card size="small" title="График просадки (DD)">
                {drawdownChartData.length > 0 ? <ChartComponent data={drawdownChartData} type="line" /> : <Empty description="Нет данных DD" />}
              </Card>
            </Col>
            <Col xs={24} xl={12}>
              <Card size="small" title="График загрузки маржи (live monitoring)">
                {marginLoadChartData.length > 0 ? (
                  <ChartComponent data={marginLoadChartData} type="line" />
                ) : (
                  <Empty description="Нет history по margin load: метрика еще не собиралась или система не торговала" />
                )}
              </Card>
            </Col>
          </Row>
        </Card>
      ) : null}

      {analysisResult ? (
        <Card className="battletoads-card" title={copy.analysis} style={{ marginTop: 16 }}>
          <Alert
            style={{ marginBottom: 12 }}
            type="info"
            showIcon
            message={`Пояснение: confidence показывает надежность рекомендации, severity - срочность. При samples=0 вывод носит справочный характер.`}
          />
          <Table<AnalysisReport>
            size="small"
            rowKey={(row) => String(row.strategyId)}
            dataSource={analysisResult.reports || []}
            pagination={false}
            expandable={{
              expandedRowRender: (row) => (
                <Descriptions size="small" bordered column={1}>
                  <Descriptions.Item label="Объяснение">{explainRecommendation(row)}</Descriptions.Item>
                  <Descriptions.Item label="Live samples">{formatNumber((row.metrics || {}).samples_count, 0)}</Descriptions.Item>
                  <Descriptions.Item label="PnL drift">{formatPercent(Number((row.metrics || {}).realized_vs_predicted_pnl_percent || 0), 2)}</Descriptions.Item>
                  <Descriptions.Item label="Execution cost">{formatNumber((row.metrics || {}).total_execution_cost, 4)}</Descriptions.Item>
                </Descriptions>
              ),
            }}
            columns={[
              {
                title: 'Strategy',
                key: 'strategy',
                ellipsis: true,
                render: (_value, row) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{row.strategyName}</Text>
                    <Text type="secondary">{row.symbol || '—'}</Text>
                  </Space>
                ),
              },
              {
                title: copy.recommendation,
                key: 'recommendation',
                width: 160,
                render: (_value, row) => <Tag color="blue">{row.recommendation?.recommendation || 'none'}</Tag>,
              },
              {
                title: copy.severity,
                key: 'severity',
                width: 130,
                render: (_value, row) => <Tag color={row.recommendation?.severity === 'critical' ? 'error' : row.recommendation?.severity === 'warning' ? 'warning' : 'default'}>{row.recommendation?.severity || 'info'}</Tag>,
              },
              {
                title: copy.confidence,
                key: 'confidence',
                width: 120,
                render: (_value, row) => formatPercent(Number(row.recommendation?.confidence || 0) * 100, 0),
              },
              {
                title: 'Samples',
                key: 'samples',
                width: 100,
                render: (_value, row) => formatNumber((row.metrics || {}).samples_count, 0),
              },
              {
                title: copy.rationale,
                key: 'rationale',
                render: (_value, row) => row.recommendation?.rationale || '—',
              },
            ]}
          />
        </Card>
      ) : null}

      <Card className="battletoads-card" title={copy.suggestions} style={{ marginTop: 16 }}>
        {selectedSystemId && visibleSuggestions.length === 0 && !suggestionsLoading ? (
          <Alert type="info" showIcon message="Для выбранной системы suggestions пока нет." style={{ marginBottom: 12 }} />
        ) : null}

        <Table<LiquiditySuggestion>
          rowKey={(row) => String(row.id)}
          dataSource={visibleSuggestions}
          loading={suggestionsLoading}
          pagination={{ pageSize: 8 }}
          scroll={{ x: 980 }}
          columns={[
            {
              title: 'System',
              dataIndex: 'system_id',
              key: 'system_id',
              width: 90,
            },
            {
              title: 'Symbol',
              dataIndex: 'symbol',
              key: 'symbol',
              width: 120,
            },
            {
              title: copy.action,
              dataIndex: 'suggested_action',
              key: 'suggested_action',
              width: 120,
              render: (value) => <Tag color={value === 'replace' ? 'gold' : value === 'add' ? 'green' : 'default'}>{String(value || 'watch')}</Tag>,
            },
            {
              title: 'Score',
              dataIndex: 'score',
              key: 'score',
              width: 100,
              render: (value) => formatNumber(value),
            },
            {
              title: copy.replaceSymbol,
              key: 'replace',
              render: (_value, row) => parseSuggestionDetails(row.details_json).replace_symbol || '—',
            },
            {
              title: copy.status,
              dataIndex: 'status',
              key: 'status',
              width: 120,
              render: (value) => <Tag color={value === 'accepted' ? 'success' : value === 'rejected' ? 'error' : value === 'applied' ? 'processing' : 'default'}>{String(value || 'new')}</Tag>,
            },
            {
              title: copy.notes,
              key: 'notes',
              render: (_value, row) => parseSuggestionDetails(row.details_json).reason || '—',
            },
            {
              title: copy.action,
              key: 'buttons',
              width: 220,
              render: (_value, row) => (
                <Space wrap>
                  <Button size="small" onClick={() => void updateSuggestionStatus(row.id, 'accepted')} loading={systemActionLoading === `suggestion-${row.id}`}>Accept</Button>
                  <Button size="small" danger onClick={() => void updateSuggestionStatus(row.id, 'rejected')} loading={systemActionLoading === `suggestion-${row.id}`}>Reject</Button>
                  <Button size="small" type="primary" onClick={() => void updateSuggestionStatus(row.id, 'applied')} loading={systemActionLoading === `suggestion-${row.id}`}>Applied</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
};

export default TradingSystems;