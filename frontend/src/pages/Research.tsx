import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import axios from 'axios';

const { Title, Text, Paragraph } = Typography;

// ─── Types ──────────────────────────────────────────────────────────────────

type SweepRun = {
  id: number;
  name: string;
  description: string;
  status: string;
  catalog_file_path: string | null;
  artifact_file_path: string | null;
  created_at: string;
  completed_at: string | null;
};

type SweepPair = {
  market: string;
  interval: string;
  profiles: number;
};

type ResearchSweepTask = {
  id: number;
  source: string;
  source_request_id: number | null;
  tenant_id: number | null;
  tenant_name: string;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  note: string;
  request_status: string;
  status: string;
  is_selected: number;
  requested_at: string | null;
  selected_at: string | null;
  last_sweep_run_id: number | null;
  last_sweep_at: string | null;
  created_at: string;
  updated_at: string;
};

type StrategyProfile = {
  id: number;
  name: string;
  description: string;
  origin: string;
  strategy_type: string;
  base_symbol: string | null;
  quote_symbol: string | null;
  interval: string;
  status: string; // candidate | published | archived
  sweep_run_id: number | null;
  published_strategy_id: number | null;
  metrics_summary_json: string;
  created_at: string;
};

type PreviewJob = {
  id: number;
  profile_id: number | null;
  status: string; // queued | running | done | failed
  error: string | null;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
};

type ApiKeyRecord = {
  id: number;
  name: string;
  exchange: string;
};

type SchedulerJob = {
  id: number;
  job_key: string;
  title: string;
  is_enabled: number;
  hour_utc: number;
  minute_utc: number;
  last_status: string;
  last_run_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  run_count: number;
};

type SchedulerGapStatus = {
  fromDay: string;
  toDay: string;
  totalDays: number;
  existingDays: number;
  missingDays: string[];
};

type BackfillJobStatus = {
  success?: boolean;
  exists?: boolean;
  id?: number;
  mode?: 'light' | 'heavy';
  status?: 'queued' | 'running' | 'done' | 'failed';
  requested_max_days?: number;
  analyzed_days?: number;
  missing_days?: number;
  processed_days?: number;
  created_runs?: number;
  skipped_days?: number;
  current_day_key?: string;
  eta_seconds?: number;
  progress_percent?: number;
  error?: string;
  started_at?: string;
  updated_at?: string;
  finished_at?: string | null;
};

type FullHistoricalSweepStatus = {
  success?: boolean;
  exists?: boolean;
  id?: number;
  mode?: 'light' | 'heavy';
  status?: 'queued' | 'running' | 'done' | 'failed';
  processed_days?: number;
  created_runs?: number;
  skipped_days?: number;
  current_day_key?: string;
  progress_percent?: number;
  error?: string;
  started_at?: string;
  updated_at?: string;
  finished_at?: string | null;
  details?: {
    totalRuns?: number;
    processedRuns?: number;
    successRuns?: number;
    failedRuns?: number;
    logFilePath?: string;
    sweepFilePath?: string;
    catalogFilePath?: string;
    resumedFromCheckpoint?: boolean;
    skippedFromCheckpoint?: number;
    config?: {
      apiKeyName?: string;
      dateFrom?: string;
      dateTo?: string | null;
      interval?: string;
    };
    researchImport?: {
      sweepRunId?: number;
      imported?: number;
      skipped?: number;
      candidates?: number;
    };
  };
};

type DbObservability = {
  atUtc: string;
  files: {
    mainDb: { path: string; exists: boolean; sizeBytes: number; mtimeUtc: string | null };
    researchDb: { path: string; exists: boolean; sizeBytes: number; mtimeUtc: string | null };
  };
  rowCounts: {
    main: Record<string, number | null>;
    research: Record<string, number | null>;
    totals?: {
      main?: number;
      research?: number;
    };
  };
  freshness?: {
    latestSweep?: {
      id?: number;
      name?: string;
      status?: string;
      sweep_at_utc?: string | null;
    } | null;
    latestSweepLagHours?: number | null;
    scheduler?: {
      last_status?: string;
      last_run_at?: string | null;
      next_run_at?: string | null;
      run_count?: number;
    } | null;
  };
};

// ─── Helper ─────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'published': return 'green';
    case 'archived': return 'default';
    case 'running': return 'blue';
    case 'done': return 'success';
    case 'failed': return 'error';
    case 'queued': return 'gold';
    default: return 'default';
  }
}

function parseMetrics(raw: string): Record<string, unknown> {
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

function formatDurationCompact(totalSeconds?: number | null): string {
  const safe = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  if (hours > 0) return `${hours}ч ${minutes}м`;
  if (minutes > 0) return `${minutes}м ${seconds}с`;
  return `${seconds}с`;
}

// ─── Sweep Panel ─────────────────────────────────────────────────────────────

function SweepPanel({ onSweepSelect }: { onSweepSelect: (id: number | null) => void }) {
  const [sweeps, setSweeps] = useState<SweepRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [importingId, setImportingId] = useState<number | null>(null);
  const [registerModal, setRegisterModal] = useState(false);
  const [importArtifactsModal, setImportArtifactsModal] = useState(false);
  const [importArtifactsLoading, setImportArtifactsLoading] = useState(false);
  const [pairsModalOpen, setPairsModalOpen] = useState(false);
  const [pairsLoading, setPairsLoading] = useState(false);
  const [pairsSweepId, setPairsSweepId] = useState<number | null>(null);
  const [pairs, setPairs] = useState<SweepPair[]>([]);
  const [registerForm] = Form.useForm();
  const [importArtifactsForm] = Form.useForm();

  const fetchSweeps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<SweepRun[]>('/api/research/sweeps');
      setSweeps(res.data || []);
    } catch {
      message.error('Failed to load sweep runs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchSweeps(); }, [fetchSweeps]);

  const handleRegister = async (values: { name: string; description: string; catalogPath: string }) => {
    try {
      await axios.post('/api/research/sweeps/register', {
        name: values.name,
        description: values.description,
        catalogFilePath: values.catalogPath,
      });
      message.success('Sweep run registered');
      setRegisterModal(false);
      registerForm.resetFields();
      void fetchSweeps();
    } catch {
      message.error('Failed to register sweep run');
    }
  };

  const handleImport = async (sweepId: number) => {
    setImportingId(sweepId);
    try {
      const res = await axios.post<{ imported: number }>(`/api/research/sweeps/${sweepId}/import-candidates`);
      message.success(`Imported ${res.data.imported} candidates from sweep #${sweepId}`);
    } catch {
      message.error('Import failed — check that catalog_file_path exists on server');
    } finally {
      setImportingId(null);
    }
  };

  const handleImportArtifacts = async (values: {
    catalogFilePath: string;
    sweepFilePath?: string;
    sweepName?: string;
    description?: string;
  }) => {
    setImportArtifactsLoading(true);
    try {
      const res = await axios.post<{
        sweepRunId: number;
        imported: number;
        skipped: number;
        candidates: number;
      }>('/api/research/sweeps/import-from-file', values);
      message.success(
        `Imported ${res.data.imported}/${res.data.candidates} candidates into sweep #${res.data.sweepRunId}`
      );
      setImportArtifactsModal(false);
      importArtifactsForm.resetFields();
      void fetchSweeps();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Artifacts import failed');
    } finally {
      setImportArtifactsLoading(false);
    }
  };

  const openPairs = async (sweepId: number) => {
    setPairsModalOpen(true);
    setPairsSweepId(sweepId);
    setPairsLoading(true);
    try {
      const res = await axios.get<{ pairs: SweepPair[] }>(`/api/research/sweeps/${sweepId}/pairs`);
      setPairs(res.data?.pairs || []);
    } catch {
      message.error('Failed to load sweep pairs');
      setPairs([]);
    } finally {
      setPairsLoading(false);
    }
  };

  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string, row: SweepRun) => (
        <Button type="link" size="small" onClick={() => onSweepSelect(row.id)}>{name}</Button>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <Tag color={statusColor(s)}>{s}</Tag>,
    },
    { title: 'Catalog path', dataIndex: 'catalog_file_path', ellipsis: true },
    { title: 'Created', dataIndex: 'created_at', width: 160, render: (v: string) => v?.slice(0, 16) ?? '' },
    {
      title: 'Actions',
      width: 160,
      render: (_: unknown, row: SweepRun) => (
        <Space>
          <Tooltip title="Import candidates from catalog JSON into Research DB">
            <Button
              size="small"
              loading={importingId === row.id}
              onClick={() => void handleImport(row.id)}
            >
              Import
            </Button>
          </Tooltip>
          <Button size="small" onClick={() => void openPairs(row.id)}>Pairs</Button>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Sweep Runs"
      extra={
        <Space>
          <Button size="small" onClick={() => setImportArtifactsModal(true)}>
            Import artifacts
          </Button>
          <Button type="primary" size="small" onClick={() => setRegisterModal(true)}>
            + Register sweep
          </Button>
        </Space>
      }
    >
      <Table
        dataSource={sweeps}
        rowKey="id"
        columns={columns}
        loading={loading}
        size="small"
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: <Empty description="No sweep runs registered yet" /> }}
      />

      <Modal
        title="Register Sweep Run"
        open={registerModal}
        onCancel={() => setRegisterModal(false)}
        onOk={() => registerForm.submit()}
        okText="Register"
      >
        <Form form={registerForm} layout="vertical" onFinish={(v) => void handleRegister(v)}>
          <Form.Item name="name" label="Name" rules={[{ required: true }]}>
            <Input placeholder="e.g. sweep_2025_07_v3" />
          </Form.Item>
          <Form.Item name="description" label="Description">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="catalogPath" label="Catalog JSON path (on server)" rules={[{ required: true }]}>
            <Input placeholder="/opt/battletoads-double-dragon/sweeps/catalog.json" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Import Historical Artifacts"
        open={importArtifactsModal}
        onCancel={() => setImportArtifactsModal(false)}
        onOk={() => importArtifactsForm.submit()}
        okText="Import"
        confirmLoading={importArtifactsLoading}
      >
        <Form
          form={importArtifactsForm}
          layout="vertical"
          onFinish={(v) => void handleImportArtifacts(v)}
          initialValues={{
            sweepName: `manual_import_${new Date().toISOString().slice(0, 10)}`,
          }}
        >
          <Form.Item
            name="catalogFilePath"
            label="client_catalog JSON path"
            rules={[{ required: true }]}
          >
            <Input placeholder="/opt/battletoads-double-dragon/results/*_client_catalog_*.json" />
          </Form.Item>
          <Form.Item name="sweepFilePath" label="historical_sweep JSON path (optional)">
            <Input placeholder="/opt/battletoads-double-dragon/results/*_historical_sweep_*.json" />
          </Form.Item>
          <Form.Item name="sweepName" label="Sweep name (optional)">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Description (optional)">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`Sweep #${pairsSweepId || '—'} pairs`}
        open={pairsModalOpen}
        onCancel={() => setPairsModalOpen(false)}
        footer={<Button onClick={() => setPairsModalOpen(false)}>Close</Button>}
      >
        <Table
          dataSource={pairs}
          rowKey={(row) => `${row.market}-${row.interval}`}
          loading={pairsLoading}
          size="small"
          pagination={{ pageSize: 8 }}
          columns={[
            { title: 'Market', dataIndex: 'market' },
            { title: 'Interval', dataIndex: 'interval', width: 100 },
            { title: 'Profiles', dataIndex: 'profiles', width: 100 },
          ]}
          locale={{ emptyText: <Empty description="No pairs in this sweep" /> }}
        />
      </Modal>
    </Card>
  );
}

// ─── Preview result drawer ────────────────────────────────────────────────────

function PreviewResultModal({
  job,
  onClose,
}: {
  job: PreviewJob | null;
  onClose: () => void;
}) {
  if (!job) return null;
  const result = job.result_json ? parseMetrics(job.result_json) : null;

  return (
    <Modal
      title={`Preview Job #${job.id}`}
      open={!!job}
      onCancel={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
      width={640}
    >
      <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="Status">
          <Tag color={statusColor(job.status)}>{job.status}</Tag>
        </Descriptions.Item>
        {job.error && <Descriptions.Item label="Error"><Text type="danger">{job.error}</Text></Descriptions.Item>}
        {result && Object.entries(result).map(([k, v]) => (
          <Descriptions.Item key={k} label={k}>{String(v)}</Descriptions.Item>
        ))}
      </Descriptions>
    </Modal>
  );
}

// ─── BT vs RT Types ──────────────────────────────────────────────────────────

type BtRtSnapshot = {
  id: number;
  snapshot_date: string;
  tenant_id: number;
  api_key_name: string;
  system_name: string;
  rt_equity_usd: number | null;
  rt_return_pct: number | null;
  rt_entries: number | null;
  rt_exits: number | null;
  rt_drawdown_pct: number | null;
  bt_total_return_pct: number | null;
  bt_max_dd_pct: number | null;
  bt_win_rate: number | null;
  drift_avg_pct: number | null;
  drift_flag: string | null;
  drift_alerts_critical: number | null;
  drift_alerts_warn: number | null;
};

// ─── Profile Table ───────────────────────────────────────────────────────────

export default function Research() {
  const [profiles, setProfiles] = useState<StrategyProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(20);
  const [loadingProfiles, setLoadingProfiles] = useState(false);

  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterSweepId, setFilterSweepId] = useState<number | null>(null);

  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [publishModal, setPublishModal] = useState<{ profile: StrategyProfile } | null>(null);
  const [publishApiKey, setPublishApiKey] = useState<string>('');
  const [publishLoading, setPublishLoading] = useState(false);

  const [previewLoadingById, setPreviewLoadingById] = useState<Record<number, boolean>>({});
  const [previewJobResult, setPreviewJobResult] = useState<PreviewJob | null>(null);
  const [schedulerLoading, setSchedulerLoading] = useState(false);
  const [schedulerSaving, setSchedulerSaving] = useState(false);
  const [schedulerRunNowLoading, setSchedulerRunNowLoading] = useState(false);
  const [schedulerGapLoading, setSchedulerGapLoading] = useState(false);
  const [schedulerBackfillLoading, setSchedulerBackfillLoading] = useState(false);
  const [schedulerGapStatus, setSchedulerGapStatus] = useState<SchedulerGapStatus | null>(null);
  const [backfillJobStatus, setBackfillJobStatus] = useState<BackfillJobStatus | null>(null);
  const [schedulerRunStartedAt, setSchedulerRunStartedAt] = useState<number | null>(null);
  const [schedulerRunElapsedSec, setSchedulerRunElapsedSec] = useState(0);
  const [schedulerJob, setSchedulerJob] = useState<SchedulerJob | null>(null);
  const [scheduleHourUtc, setScheduleHourUtc] = useState<number>(3);
  const [scheduleMinuteUtc, setScheduleMinuteUtc] = useState<number>(15);
  const [observability, setObservability] = useState<DbObservability | null>(null);
  const [tasks, setTasks] = useState<ResearchSweepTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskSyncLoading, setTaskSyncLoading] = useState(false);
  const [taskRunLoading, setTaskRunLoading] = useState(false);
  const [manualSweepModalOpen, setManualSweepModalOpen] = useState(false);
  const [manualSweepLoading, setManualSweepLoading] = useState(false);
  const [manualMarketsText, setManualMarketsText] = useState('');
  const [manualDateFrom, setManualDateFrom] = useState('');
  const [manualDateTo, setManualDateTo] = useState('');
  const [manualInterval, setManualInterval] = useState('1h');
  const [manualSweepName, setManualSweepName] = useState('');
  const [manualSweepDescription, setManualSweepDescription] = useState('');
  const [manualSweepNote, setManualSweepNote] = useState('');
  const [taskInterval, setTaskInterval] = useState('1h');
  const [taskDateFrom, setTaskDateFrom] = useState('');
  const [taskDateTo, setTaskDateTo] = useState('');
  const [taskMarkDone, setTaskMarkDone] = useState(true);
  const [sweepMode, setSweepMode] = useState<'light' | 'heavy'>('light');
  const [schedulerBackfillMode, setSchedulerBackfillMode] = useState<'light' | 'heavy'>('light');
  const [fullHistoricalSweepMode, setFullHistoricalSweepMode] = useState<'light' | 'heavy'>('heavy');
  const [fullHistoricalSweepLoading, setFullHistoricalSweepLoading] = useState(false);
  const [fullHistoricalSweepStatus, setFullHistoricalSweepStatus] = useState<FullHistoricalSweepStatus | null>(null);
  const [fullHistoricalDateFrom, setFullHistoricalDateFrom] = useState('2025-01-01');
  const [fullHistoricalDateTo, setFullHistoricalDateTo] = useState('');
  const [fullHistoricalInterval, setFullHistoricalInterval] = useState('4h,1h');
  const [hfGenerateLoading, setHfGenerateLoading] = useState(false);
  const [hfTargetTradesPerDay, setHfTargetTradesPerDay] = useState(10);
  const [hfApiKeyName, setHfApiKeyName] = useState('');

  // BT vs RT state
  const [btRtRows, setBtRtRows] = useState<BtRtSnapshot[]>([]);
  const [btRtLoading, setBtRtLoading] = useState(false);
  const [btRtRunLoading, setBtRtRunLoading] = useState(false);
  const [btRtDays, setBtRtDays] = useState(30);
  const [btRtApiKey, setBtRtApiKey] = useState('');

  const fetchBtRtSnapshots = useCallback(async () => {
    setBtRtLoading(true);
    try {
      const params: Record<string, string | number> = { days: btRtDays };
      if (btRtApiKey) params.apiKeyName = btRtApiKey;
      const res = await axios.get<{ rows: BtRtSnapshot[] }>('/api/saas/bt-rt-snapshots', { params });
      setBtRtRows(res.data.rows || []);
    } catch {
      void message.error('Ошибка загрузки BT vs RT снапшотов');
    } finally {
      setBtRtLoading(false);
    }
  }, [btRtDays, btRtApiKey]);

  const runBtRtSweep = useCallback(async () => {
    setBtRtRunLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await axios.post('/api/saas/bt-rt-snapshots/run', { date: today });
      void message.success('BT vs RT sweep запущен');
      await fetchBtRtSnapshots();
    } catch {
      void message.error('Ошибка запуска BT vs RT sweep');
    } finally {
      setBtRtRunLoading(false);
    }
  }, [fetchBtRtSnapshots]);

  const fetchScheduler = useCallback(async () => {
    setSchedulerLoading(true);
    try {
      const [jobsRes, obsRes] = await Promise.all([
        axios.get<{ jobs: SchedulerJob[] }>('/api/research/scheduler'),
        axios.get<DbObservability>('/api/research/observability/db'),
      ]);
      const job = (jobsRes.data.jobs || []).find((j) => j.job_key === 'daily_incremental_sweep') || null;
      setSchedulerJob(job);
      if (job) {
        setScheduleHourUtc(Number(job.hour_utc));
        setScheduleMinuteUtc(Number(job.minute_utc));
      }
      setObservability(obsRes.data);
    } catch {
      message.error('Failed to load scheduler/DB observability');
    } finally {
      setSchedulerLoading(false);
    }
  }, []);

  const saveScheduler = async () => {
    if (!schedulerJob) return;
    setSchedulerSaving(true);
    try {
      await axios.patch('/api/research/scheduler/daily_incremental_sweep', {
        isEnabled: schedulerJob.is_enabled === 1,
        hourUtc: Math.max(0, Math.min(23, Math.floor(scheduleHourUtc))),
        minuteUtc: Math.max(0, Math.min(59, Math.floor(scheduleMinuteUtc))),
      });
      message.success('Scheduler updated');
      await fetchScheduler();
    } catch {
      message.error('Failed to update scheduler');
    } finally {
      setSchedulerSaving(false);
    }
  };

  const toggleScheduler = async (enabled: boolean) => {
    if (!schedulerJob) return;
    setSchedulerSaving(true);
    try {
      await axios.patch('/api/research/scheduler/daily_incremental_sweep', {
        isEnabled: enabled,
        hourUtc: Number(scheduleHourUtc),
        minuteUtc: Number(scheduleMinuteUtc),
      });
      message.success(enabled ? 'Scheduler enabled' : 'Scheduler disabled');
      await fetchScheduler();
    } catch {
      message.error('Failed to toggle scheduler');
    } finally {
      setSchedulerSaving(false);
    }
  };

  const runSchedulerNow = async () => {
    setSchedulerRunNowLoading(true);
    setSchedulerRunStartedAt(Date.now());
    setSchedulerRunElapsedSec(0);
    try {
      const res = await axios.post<{ result?: { status?: string; details?: Record<string, unknown> } }>('/api/research/scheduler/daily_incremental_sweep/run-now');
      message.success(`Scheduler run finished: ${res.data?.result?.status || 'ok'}`);
      await fetchScheduler();
      await fetchProfiles();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Scheduler run failed');
    } finally {
      setSchedulerRunNowLoading(false);
      setSchedulerRunStartedAt(null);
    }
  };

  const checkSchedulerGap = async () => {
    setSchedulerGapLoading(true);
    try {
      const res = await axios.get<SchedulerGapStatus>('/api/research/scheduler/daily_incremental_sweep/gap', {
        params: { daysBack: 30 },
      });
      setSchedulerGapStatus(res.data);
      const missing = Array.isArray(res.data?.missingDays) ? res.data.missingDays.length : 0;
      message.info(`Gap check: missing days = ${missing}`);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Failed to check scheduler gap');
    } finally {
      setSchedulerGapLoading(false);
    }
  };

  const fetchBackfillStatus = useCallback(async () => {
    try {
      const res = await axios.get<BackfillJobStatus>('/api/research/scheduler/daily_incremental_sweep/backfill-status');
      setBackfillJobStatus(res.data || null);
    } catch {
      // keep UI resilient when endpoint is temporarily unavailable
    }
  }, []);

  const fetchFullHistoricalSweepStatus = useCallback(async () => {
    try {
      const res = await axios.get<FullHistoricalSweepStatus>('/api/research/sweeps/full-historical/status');
      setFullHistoricalSweepStatus(res.data || null);
    } catch {
      // keep UI resilient when endpoint is temporarily unavailable
    }
  }, []);

  const changeBackfillMode = async (value: 'light' | 'heavy') => {
    setSchedulerBackfillMode(value);

    if (!backfillJobStatus?.exists || backfillJobStatus.status !== 'running') {
      return;
    }

    try {
      await axios.patch('/api/research/scheduler/daily_incremental_sweep/backfill-mode', {
        mode: value,
        jobId: backfillJobStatus.id,
      });
      message.success(`Режим backfill переключен на ${value}. Новый режим применится на следующих днях.`);
      await fetchBackfillStatus();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Не удалось переключить режим backfill');
    }
  };

  const backfillSchedulerGap = async () => {
    setSchedulerBackfillLoading(true);
    try {
      const res = await axios.post<{ started?: boolean; reason?: string; mode?: string; jobId?: number; toProcess?: number; missingDays?: number }>('/api/research/scheduler/daily_incremental_sweep/backfill-start', {
        maxDays: 30,
        mode: schedulerBackfillMode,
      });
      if (res.data?.started === false) {
        message.info(String(res.data?.reason || 'Backfill already running'));
      } else {
        message.success(`Backfill started (${res.data?.mode || schedulerBackfillMode}), job #${res.data?.jobId || 'n/a'}: ${res.data?.toProcess || 0}/${res.data?.missingDays || 0} days queued`);
      }
      await Promise.all([fetchScheduler(), checkSchedulerGap(), fetchBackfillStatus()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Backfill failed');
    } finally {
      setSchedulerBackfillLoading(false);
    }
  };

  const startFullHistoricalSweep = async () => {
    setFullHistoricalSweepLoading(true);
    try {
      const res = await axios.post<{
        started?: boolean;
        reason?: string;
        jobId?: number;
        totalRuns?: number;
      }>('/api/research/sweeps/full-historical/start', {
        mode: fullHistoricalSweepMode,
        dateFrom: fullHistoricalDateFrom || undefined,
        dateTo: fullHistoricalDateTo || undefined,
        interval: fullHistoricalInterval || undefined,
      });

      if (res.data?.started === false) {
        message.info(String(res.data?.reason || 'Historical sweep already running'));
      } else {
        message.success(`Полный historical sweep запущен: job #${res.data?.jobId || 'n/a'}, runs=${res.data?.totalRuns || 0}`);
      }

      await Promise.all([fetchFullHistoricalSweepStatus(), fetchScheduler()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Не удалось запустить полный historical sweep');
    } finally {
      setFullHistoricalSweepLoading(false);
    }
  };

  const abortFullHistoricalSweep = async () => {
    setFullHistoricalSweepLoading(true);
    try {
      const res = await axios.post<{ aborted?: boolean; reason?: string; jobId?: number }>('/api/research/sweeps/full-historical/abort', {
        reason: 'manual abort from research ui',
      });

      if (res.data?.aborted) {
        message.success(`Full sweep aborted: job #${res.data?.jobId || 'n/a'}`);
      } else {
        message.info(String(res.data?.reason || 'No running full sweep job to abort'));
      }

      await Promise.all([fetchFullHistoricalSweepStatus(), fetchScheduler()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Не удалось остановить full historical sweep');
    } finally {
      setFullHistoricalSweepLoading(false);
    }
  };

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const res = await axios.get<{ tasks: ResearchSweepTask[] }>('/api/research/tasks/backtest-requests', {
        params: { limit: 500 },
      });
      setTasks(res.data?.tasks || []);
    } catch {
      message.error('Не удалось загрузить задачи sweep');
    } finally {
      setTasksLoading(false);
    }
  }, []);

  const syncTasks = async () => {
    setTaskSyncLoading(true);
    try {
      const res = await axios.post<{ imported: number }>('/api/research/tasks/backtest-requests/sync');
      message.success(`Synced tasks: +${res.data?.imported || 0}`);
      await fetchTasks();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Failed to sync tasks');
    } finally {
      setTaskSyncLoading(false);
    }
  };

  const updateSelection = async (taskId: number, isSelected: boolean) => {
    try {
      await axios.patch('/api/research/tasks/backtest-requests/selection', {
        taskIds: [taskId],
        isSelected,
      });
      setTasks((prev) => prev.map((row) => row.id === taskId
        ? { ...row, is_selected: isSelected ? 1 : 0, status: isSelected ? 'selected' : 'new' }
        : row));
    } catch {
      message.error('Failed to update task selection');
    }
  };

  const runSweepFromTasks = async () => {
    setTaskRunLoading(true);
    try {
      const selectedIds = tasks.filter((row) => row.is_selected === 1).map((row) => row.id);
      const res = await axios.post('/api/research/tasks/run-sweep', {
        taskIds: selectedIds,
        dateFrom: taskDateFrom || undefined,
        dateTo: taskDateTo || undefined,
        interval: taskInterval || undefined,
        markDone: taskMarkDone,
        mode: sweepMode,
      });
      message.success(`Task sweep (${res.data?.mode || sweepMode}) завершен: #${res.data?.sweepRunId || 'n/a'}, импортировано ${res.data?.imported || 0}`);
      await Promise.all([fetchTasks(), fetchScheduler(), fetchProfiles()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Task sweep завершился ошибкой');
    } finally {
      setTaskRunLoading(false);
    }
  };

  const runManualSweep = async () => {
    const markets = Array.from(new Set(
      String(manualMarketsText || '')
        .split(/[\n,;]+/)
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
    ));

    if (markets.length === 0) {
      message.warning('Add at least one market (example: BTC/USDT)');
      return;
    }

    setManualSweepLoading(true);
    try {
      const res = await axios.post('/api/research/tasks/run-sweep/manual', {
        markets,
        dateFrom: manualDateFrom || undefined,
        dateTo: manualDateTo || undefined,
        interval: manualInterval || undefined,
        sweepName: manualSweepName || undefined,
        description: manualSweepDescription || undefined,
        note: manualSweepNote || undefined,
        mode: sweepMode,
      });

      message.success(`Manual sweep (${res.data?.mode || sweepMode}) создан: #${res.data?.sweepRunId || 'n/a'}, импортировано ${res.data?.imported || 0}`);
      setManualSweepModalOpen(false);
      setManualMarketsText('');
      setManualSweepName('');
      setManualSweepDescription('');
      setManualSweepNote('');
      await Promise.all([fetchScheduler(), fetchProfiles(), fetchTasks()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Manual sweep завершился ошибкой');
    } finally {
      setManualSweepLoading(false);
    }
  };

  const markTasks = async (status: 'done' | 'ignored' | 'new') => {
    const selectedIds = tasks.filter((row) => row.is_selected === 1).map((row) => row.id);
    if (!selectedIds.length) {
      message.warning('Сначала выберите задачи');
      return;
    }
    try {
      await axios.patch('/api/research/tasks/backtest-requests/mark', {
        taskIds: selectedIds,
        status,
      });
      message.success(`Marked ${selectedIds.length} tasks as ${status}`);
      await fetchTasks();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Failed to mark tasks');
    }
  };

  const generateHighFrequencySystem = async () => {
    if (!hfApiKeyName) {
      message.warning('Сначала выберите API key');
      return;
    }
    setHfGenerateLoading(true);
    try {
      const res = await axios.post('/api/research/tasks/high-frequency-system', {
        apiKeyName: hfApiKeyName,
        targetTradesPerDay: hfTargetTradesPerDay,
        mode: sweepMode,
        maxMembers: sweepMode === 'heavy' ? 8 : 6,
        minPf: sweepMode === 'heavy' ? 1.0 : 1.05,
        maxDd: sweepMode === 'heavy' ? 35 : 28,
      });
      message.success(`High-frequency TS created: ${res.data?.createdSystem?.name || 'n/a'} (#${res.data?.createdSystem?.id || 'n/a'})`);
      await Promise.all([fetchProfiles(), fetchScheduler()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Failed to generate high-frequency system', 10);
    } finally {
      setHfGenerateLoading(false);
    }
  };

  useEffect(() => {
    if (!schedulerRunNowLoading || schedulerRunStartedAt === null) {
      setSchedulerRunElapsedSec(0);
      return;
    }

    const timer = window.setInterval(() => {
      setSchedulerRunElapsedSec(Math.max(0, Math.floor((Date.now() - schedulerRunStartedAt) / 1000)));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [schedulerRunNowLoading, schedulerRunStartedAt]);

  // ── Fetch profiles ──────────────────────────────────────────────────────────
  const fetchProfiles = useCallback(async (pg = page) => {
    setLoadingProfiles(true);
    try {
      const params: Record<string, string | number> = { page: pg, pageSize };
      if (filterStatus) params.status = filterStatus;
      if (filterSweepId != null) params.sweepRunId = filterSweepId;
      const res = await axios.get<{ profiles: StrategyProfile[]; total: number }>('/api/research/profiles', { params });
      setProfiles(res.data.profiles || []);
      setTotal(res.data.total || 0);
    } catch {
      message.error('Failed to load profiles');
    } finally {
      setLoadingProfiles(false);
    }
  }, [page, pageSize, filterStatus, filterSweepId]);

  useEffect(() => { void fetchProfiles(1); setPage(1); }, [filterStatus, filterSweepId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchProfiles(page); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchScheduler(); }, [fetchScheduler]);
  useEffect(() => { void fetchTasks(); }, [fetchTasks]);
  useEffect(() => { void fetchBackfillStatus(); }, [fetchBackfillStatus]);
  useEffect(() => { void fetchFullHistoricalSweepStatus(); }, [fetchFullHistoricalSweepStatus]);

  useEffect(() => {
    if (!backfillJobStatus || backfillJobStatus.status !== 'running') {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchBackfillStatus();
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [backfillJobStatus, fetchBackfillStatus]);

  useEffect(() => {
    if (!fullHistoricalSweepStatus || fullHistoricalSweepStatus.status !== 'running') {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchFullHistoricalSweepStatus();
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [fullHistoricalSweepStatus, fetchFullHistoricalSweepStatus]);

  useEffect(() => {
    if (backfillJobStatus?.mode) {
      setSchedulerBackfillMode(backfillJobStatus.mode);
    }
  }, [backfillJobStatus?.mode]);

  // ── Fetch API keys for publish modal ───────────────────────────────────────
  useEffect(() => {
    axios.get<ApiKeyRecord[]>('/api/api-keys').then(r => setApiKeys(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!hfApiKeyName && apiKeys.length > 0) {
      setHfApiKeyName(String(apiKeys[0].name || ''));
    }
  }, [apiKeys, hfApiKeyName]);

  const fullHistoricalProcessedRuns = Number(fullHistoricalSweepStatus?.details?.processedRuns || fullHistoricalSweepStatus?.processed_days || 0);
  const fullHistoricalTotalRuns = Number(fullHistoricalSweepStatus?.details?.totalRuns || 0);
  const fullHistoricalStartedAtMs = fullHistoricalSweepStatus?.started_at ? Date.parse(fullHistoricalSweepStatus.started_at) : NaN;
  const fullHistoricalElapsedSec = Number.isFinite(fullHistoricalStartedAtMs)
    ? Math.max(0, Math.floor((Date.now() - fullHistoricalStartedAtMs) / 1000))
    : 0;
  const fullHistoricalRunsPerSec = fullHistoricalElapsedSec > 0 && fullHistoricalProcessedRuns > 0
    ? fullHistoricalProcessedRuns / fullHistoricalElapsedSec
    : 0;
  const fullHistoricalEtaSec = fullHistoricalRunsPerSec > 0 && fullHistoricalTotalRuns > fullHistoricalProcessedRuns
    ? Math.max(0, Math.round((fullHistoricalTotalRuns - fullHistoricalProcessedRuns) / fullHistoricalRunsPerSec))
    : 0;

  // ── Preview ────────────────────────────────────────────────────────────────
  const handlePreview = async (profile: StrategyProfile) => {
    setPreviewLoadingById(prev => ({ ...prev, [profile.id]: true }));
    try {
      const config = parseMetrics(profile.metrics_summary_json);
      const res = await axios.post<{ job: PreviewJob }>('/api/research/preview', {
        config,
        profile_id: profile.id,
        priority: 1,
      });
      const job = res.data.job;
      message.info(`Preview job #${job.id} queued`);
      // Poll for up to 60s
      let attempts = 0;
      const poll = async () => {
        try {
            const pollRes = await axios.get<{ job: PreviewJob }>(`/api/research/preview/${job.id}`);
            if (pollRes.data.job.status === 'done' || pollRes.data.job.status === 'failed') {
              setPreviewJobResult(pollRes.data.job);
          } else if (attempts < 24) {
            attempts++;
            setTimeout(() => void poll(), 2500);
          }
        } catch { /* stop polling on error */ }
      };
      setTimeout(() => void poll(), 2500);
    } catch {
      message.error('Failed to enqueue preview');
    } finally {
      setPreviewLoadingById(prev => ({ ...prev, [profile.id]: false }));
    }
  };

  // ── Publish ────────────────────────────────────────────────────────────────
  const handlePublish = async () => {
    if (!publishModal || !publishApiKey) return;
    setPublishLoading(true);
    try {
      await axios.post(`/api/research/profiles/${publishModal.profile.id}/publish`, {
        apiKeyName: publishApiKey,
      });
      message.success(`Profile #${publishModal.profile.id} published to runtime`);
      setPublishModal(null);
      void fetchProfiles();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Publish failed');
    } finally {
      setPublishLoading(false);
    }
  };

  // ── Revoke ─────────────────────────────────────────────────────────────────
  const handleRevoke = async (profile: StrategyProfile) => {
    try {
      await axios.delete(`/api/research/profiles/${profile.id}/publish`);
      message.success(`Revoked runtime for profile #${profile.id}`);
      void fetchProfiles();
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Revoke failed');
    }
  };

  // ── Archive ────────────────────────────────────────────────────────────────
  const handleArchive = async (profile: StrategyProfile) => {
    try {
      await axios.patch(`/api/research/profiles/${profile.id}`, { status: 'archived' });
      message.success(`Profile #${profile.id} archived`);
      void fetchProfiles();
    } catch {
      message.error('Archive failed');
    }
  };

  // ── Sweep filter selection ─────────────────────────────────────────────────
  const handleSweepSelect = (id: number | null) => {
    setFilterSweepId(id);
    setPage(1);
  };

  // ── Columns ────────────────────────────────────────────────────────────────
  const columns = [
    { title: 'ID', dataIndex: 'id', width: 60 },
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string, row: StrategyProfile) => (
        <Space direction="vertical" size={0}>
          <Text strong>{name}</Text>
          {row.description && <Text type="secondary" style={{ fontSize: 12 }}>{row.description}</Text>}
        </Space>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => <Tag color={statusColor(s)}>{s}</Tag>,
    },
    {
      title: 'Origin',
      dataIndex: 'origin',
      width: 130,
      render: (o: string) => <Tag color="geekblue">{o}</Tag>,
    },
    {
      title: 'Market',
      width: 130,
      render: (_: unknown, row: StrategyProfile) =>
        row.base_symbol ? `${row.base_symbol}/${row.quote_symbol} ${row.interval}` : '—',
    },
    {
      title: 'Sweep',
      dataIndex: 'sweep_run_id',
      width: 80,
      render: (id: number | null) =>
        id ? (
          <Button type="link" size="small" onClick={() => handleSweepSelect(id)}>#{id}</Button>
        ) : '—',
    },
    {
      title: 'Metrics',
      width: 200,
      render: (_: unknown, row: StrategyProfile) => {
        const m = parseMetrics(row.metrics_summary_json);
        const keys = ['totalReturnPercent', 'winRatePercent', 'maxDrawdownPercent', 'profitFactor'];
        const displayed = keys.filter(k => m[k] != null);
        if (!displayed.length) return <Text type="secondary">—</Text>;
        return (
          <Space direction="vertical" size={0} style={{ fontSize: 11 }}>
            {displayed.map(k => (
              <Text key={k} style={{ fontSize: 11 }}>
                {k.replace('Percent', '%').replace('totalReturn', 'return').replace('winRate', 'win').replace('maxDrawdown', 'DD').replace('profitFactor', 'PF')}:{' '}
                <Text strong style={{ fontSize: 11 }}>
                  {typeof m[k] === 'number' ? (m[k] as number).toFixed(2) : String(m[k])}
                </Text>
              </Text>
            ))}
          </Space>
        );
      },
    },
    { title: 'Created', dataIndex: 'created_at', width: 110, render: (v: string) => v?.slice(0, 10) ?? '' },
    {
      title: 'Actions',
      width: 200,
      render: (_: unknown, row: StrategyProfile) => (
        <Space wrap>
          <Tooltip title="Run a quick preview backtest for this profile">
            <Button
              size="small"
              loading={!!previewLoadingById[row.id]}
              onClick={() => void handlePreview(row)}
            >
              Preview
            </Button>
          </Tooltip>

          {row.status !== 'published' && row.status !== 'archived' && (
            <Tooltip title="Publish this profile as a live runtime strategy">
              <Button
                size="small"
                type="primary"
                onClick={() => { setPublishModal({ profile: row }); setPublishApiKey(apiKeys[0]?.name ?? ''); }}
              >
                Publish
              </Button>
            </Tooltip>
          )}

          {row.status === 'published' && (
            <Popconfirm
              title={`Revoke runtime for profile #${row.id}?`}
              description="The strategy will be stopped and marked non-runtime."
              onConfirm={() => void handleRevoke(row)}
              okText="Revoke"
              okButtonProps={{ danger: true }}
            >
              <Button size="small" danger>Revoke</Button>
            </Popconfirm>
          )}

          {row.status !== 'archived' && (
            <Popconfirm
              title={`Archive profile #${row.id}?`}
              onConfirm={() => void handleArchive(row)}
              okText="Archive"
            >
              <Button size="small">Archive</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Title level={3}>Research</Title>
      <Paragraph type="secondary">
        Здесь управляются профили стратегий, собранные из sweep-прогонов. Это база кандидатов и пресетов для офферов, а ручные торговые системы настраиваются отдельно в разделе торговых систем.
      </Paragraph>

      <Card
        title="Планировщик Research (ежедневный incremental sweep)"
        loading={schedulerLoading}
        extra={
          <Space>
            <Tag color={schedulerJob?.is_enabled ? 'success' : 'default'}>
              {schedulerJob?.is_enabled ? 'включен' : 'выключен'}
            </Tag>
            <Tag color={statusColor(String(schedulerJob?.last_status || 'idle'))}>
              {schedulerJob?.last_status || 'idle'}
            </Tag>
          </Space>
        }
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={14}>
            <Space wrap>
              <span>Время (UTC):</span>
              <InputNumber min={0} max={23} value={scheduleHourUtc} onChange={(v) => setScheduleHourUtc(Number(v ?? 0))} />
              <span>:</span>
              <InputNumber min={0} max={59} value={scheduleMinuteUtc} onChange={(v) => setScheduleMinuteUtc(Number(v ?? 0))} />
              <Button onClick={() => void saveScheduler()} loading={schedulerSaving}>Сохранить</Button>
              <Button onClick={() => void toggleScheduler(!(schedulerJob?.is_enabled === 1))} loading={schedulerSaving}>
                {schedulerJob?.is_enabled === 1 ? 'Выключить' : 'Включить'}
              </Button>
              <Button type="primary" onClick={() => void runSchedulerNow()} loading={schedulerRunNowLoading}>
                Запустить сейчас
              </Button>
              <Button onClick={() => void checkSchedulerGap()} loading={schedulerGapLoading}>
                Проверить пробелы (30д)
              </Button>
              <Select
                value={schedulerBackfillMode}
                style={{ width: 130 }}
                options={[
                  { value: 'light', label: 'Режим: мягкий' },
                  { value: 'heavy', label: 'Режим: жесткий' },
                ]}
                onChange={(value) => void changeBackfillMode(value)}
              />
              <Button onClick={() => void backfillSchedulerGap()} loading={schedulerBackfillLoading}>
                Добить пропущенные дни
              </Button>
            </Space>
            <Space direction="vertical" size={2} style={{ marginTop: 12 }}>
              <Text type="secondary">Следующий запуск: {schedulerJob?.next_run_at || '—'}</Text>
              <Text type="secondary">Последний запуск: {schedulerJob?.last_run_at || '—'}</Text>
              <Text type="secondary">Количество запусков: {schedulerJob?.run_count ?? 0}</Text>
              {schedulerJob?.last_error ? <Text type="danger">Последняя ошибка: {schedulerJob.last_error}</Text> : null}
              {schedulerGapStatus ? (
                <Text type={schedulerGapStatus.missingDays.length > 0 ? 'warning' : 'secondary'}>
                  Пробел за 30д: заполнено {schedulerGapStatus.existingDays}/{schedulerGapStatus.totalDays}, отсутствует {schedulerGapStatus.missingDays.length}
                </Text>
              ) : null}
              {backfillJobStatus?.exists ? (
                <Text type={backfillJobStatus.status === 'failed' ? 'danger' : 'secondary'}>
                  Backfill #{backfillJobStatus.id || 'n/a'} [{backfillJobStatus.mode === 'heavy' ? 'жесткий' : 'мягкий'}]: {backfillJobStatus.status || 'unknown'}; обработано {backfillJobStatus.processed_days || 0}/{Math.max(1, Number(backfillJobStatus.missing_days || 0))}; создано {backfillJobStatus.created_runs || 0}; пропущено {backfillJobStatus.skipped_days || 0}; ETA {backfillJobStatus.eta_seconds || 0}с
                </Text>
              ) : null}
              {backfillJobStatus?.error ? <Text type="danger">Ошибка backfill: {backfillJobStatus.error}</Text> : null}
            </Space>
            {backfillJobStatus?.exists ? (
              <div style={{ marginTop: 10, maxWidth: 520 }}>
                <Progress
                  percent={Math.max(0, Math.min(100, Number(backfillJobStatus.progress_percent || 0)))}
                  status={backfillJobStatus.status === 'failed' ? 'exception' : backfillJobStatus.status === 'done' ? 'success' : 'active'}
                  format={(percent) => `${Number(percent || 0).toFixed(1)}%`}
                />
              </div>
            ) : null}
            {schedulerRunNowLoading ? (
              <div style={{ marginTop: 12, maxWidth: 420 }}>
                <Text type="secondary">Sweep выполняется... прошло {schedulerRunElapsedSec}с</Text>
                <Progress
                  percent={Math.min(95, Math.max(5, schedulerRunElapsedSec * 2))}
                  status="active"
                  showInfo={false}
                  strokeColor="#1677ff"
                />
              </div>
            ) : null}
          </Col>
          <Col xs={24} md={10}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Размер main.db">
                {observability?.files?.mainDb?.sizeBytes ?? 0} bytes
              </Descriptions.Item>
              <Descriptions.Item label="Размер research.db">
                {observability?.files?.researchDb?.sizeBytes ?? 0} bytes
              </Descriptions.Item>
              <Descriptions.Item label="Строк в main.db">
                {observability?.rowCounts?.totals?.main ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="Строк в research.db">
                {observability?.rowCounts?.totals?.research ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="Отставание последнего sweep (ч)">
                {observability?.freshness?.latestSweepLagHours ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Последний sweep">
                {observability?.freshness?.latestSweep?.name || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Срез на момент (UTC)">
                {observability?.atUtc || '—'}
              </Descriptions.Item>
            </Descriptions>
          </Col>
        </Row>
      </Card>

      <Card
        title="Полный Historical Sweep (heavy pipeline)"
        style={{ marginTop: 16 }}
        extra={
          <Space>
            <Tag color={statusColor(String(fullHistoricalSweepStatus?.status || 'idle'))}>
              {fullHistoricalSweepStatus?.status || 'idle'}
            </Tag>
            <Tag color={fullHistoricalSweepMode === 'heavy' ? 'red' : 'default'}>
              {fullHistoricalSweepMode === 'heavy' ? 'heavy' : 'light'}
            </Tag>
          </Space>
        }
      >
        <Space wrap>
          <span>From:</span>
          <Input type="date" style={{ width: 150 }} value={fullHistoricalDateFrom} onChange={(e) => setFullHistoricalDateFrom(e.target.value)} />
          <span>To:</span>
          <Input type="date" style={{ width: 150 }} value={fullHistoricalDateTo} onChange={(e) => setFullHistoricalDateTo(e.target.value)} />
          <Input
            style={{ width: 90 }}
            value={fullHistoricalInterval}
            onChange={(e) => setFullHistoricalInterval(e.target.value)}
            placeholder="4h,1h"
          />
          <Select
            value={fullHistoricalSweepMode}
            style={{ width: 150 }}
            options={[
              { value: 'light', label: 'Режим: light' },
              { value: 'heavy', label: 'Режим: heavy' },
            ]}
            onChange={(value) => setFullHistoricalSweepMode(value)}
          />
          <Button type="primary" loading={fullHistoricalSweepLoading} onClick={() => void startFullHistoricalSweep()}>
            Запустить full sweep
          </Button>
          <Button danger loading={fullHistoricalSweepLoading} onClick={() => void abortFullHistoricalSweep()}>
            Остановить full sweep
          </Button>
          <Button onClick={() => void fetchFullHistoricalSweepStatus()}>
            Обновить статус
          </Button>
        </Space>

        <Space direction="vertical" size={2} style={{ marginTop: 12 }}>
          <Text type="secondary">
            Конфиг: {fullHistoricalSweepStatus?.details?.config?.apiKeyName || 'BTDD_D1'}; {fullHistoricalSweepStatus?.details?.config?.dateFrom || fullHistoricalDateFrom || '—'} → {fullHistoricalSweepStatus?.details?.config?.dateTo || fullHistoricalDateTo || 'latest'}; {fullHistoricalSweepStatus?.details?.config?.interval || fullHistoricalInterval || '4h'}
          </Text>
          {fullHistoricalSweepStatus?.exists ? (
            <Text type={fullHistoricalSweepStatus.status === 'failed' ? 'danger' : 'secondary'}>
              Job #{fullHistoricalSweepStatus.id || 'n/a'}: обработано {fullHistoricalSweepStatus.details?.processedRuns || fullHistoricalSweepStatus.processed_days || 0}/{fullHistoricalSweepStatus.details?.totalRuns || 0}; успех {fullHistoricalSweepStatus.details?.successRuns || fullHistoricalSweepStatus.created_runs || 0}; ошибок {fullHistoricalSweepStatus.details?.failedRuns || fullHistoricalSweepStatus.skipped_days || 0}
            </Text>
          ) : (
            <Text type="secondary">Полный historical sweep ещё не запускался.</Text>
          )}
          {fullHistoricalSweepStatus?.status === 'running' ? (
            <Text type="secondary">
              В работе: {formatDurationCompact(fullHistoricalElapsedSec)}; темп {fullHistoricalRunsPerSec > 0 ? `${fullHistoricalRunsPerSec.toFixed(2)} runs/sec` : 'собираем оценку'}; ETA {fullHistoricalEtaSec > 0 ? formatDurationCompact(fullHistoricalEtaSec) : '—'}
            </Text>
          ) : null}
          {fullHistoricalSweepStatus?.details?.resumedFromCheckpoint ? (
            <Text type="warning">
              Resume from checkpoint: да; пропущено уже готовых runs {fullHistoricalSweepStatus.details?.skippedFromCheckpoint || 0}
            </Text>
          ) : null}
          {fullHistoricalSweepStatus?.details?.logFilePath ? (
            <Text type="secondary">Лог: {fullHistoricalSweepStatus.details.logFilePath}</Text>
          ) : null}
          {fullHistoricalSweepStatus?.details?.sweepFilePath ? (
            <Text type="secondary">Sweep JSON: {fullHistoricalSweepStatus.details.sweepFilePath}</Text>
          ) : null}
          {fullHistoricalSweepStatus?.details?.catalogFilePath ? (
            <Text type="secondary">Catalog JSON: {fullHistoricalSweepStatus.details.catalogFilePath}</Text>
          ) : null}
          {fullHistoricalSweepStatus?.details?.researchImport?.sweepRunId ? (
            <Text type="secondary">
              Импорт в Research: sweep #{fullHistoricalSweepStatus.details.researchImport.sweepRunId}, imported {fullHistoricalSweepStatus.details.researchImport.imported || 0}, skipped {fullHistoricalSweepStatus.details.researchImport.skipped || 0}
            </Text>
          ) : null}
          {fullHistoricalSweepStatus?.error ? <Text type="danger">Ошибка: {fullHistoricalSweepStatus.error}</Text> : null}
        </Space>

        {fullHistoricalSweepStatus?.exists ? (
          <div style={{ marginTop: 10, maxWidth: 640 }}>
            <Progress
              percent={Math.max(0, Math.min(100, Number(fullHistoricalSweepStatus.progress_percent || 0)))}
              status={fullHistoricalSweepStatus.status === 'failed' ? 'exception' : fullHistoricalSweepStatus.status === 'done' ? 'success' : 'active'}
              format={(percent) => `${Number(percent || 0).toFixed(1)}%`}
            />
          </div>
        ) : null}
      </Card>

      <Divider />

      <Card title="Что это в Research: Sweep Runs и Профили стратегий" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size={8}>
          <Alert
            type="info"
            showIcon
            message="Коротко: Sweep Runs = массовый поиск кандидатов. Профили стратегий = выбранные кандидаты с метриками, из которых собираются офферы и TS."
          />
          <Text>
            <strong>Sweep Runs</strong> — это массовые backtest-прогоны по сетке параметров. Мы перебираем много комбинаций,
            считаем PF/DD/WR/trades и формируем shortlist в офферы и TS.
          </Text>
          <Text>
            <strong>Профили стратегий</strong> — это готовые режимы риска/частоты (например conservative, balanced, HF),
            которые помогают быстро собирать продуктовые конфигурации без ручного подбора каждого параметра.
          </Text>
          <Text>
            Практический поток: запустили Sweep → получили кандидатов → опубликовали офферы в витрину → собрали TS для Strategy Client/Algofund.
          </Text>
          <Text type="secondary">
            Упрощённо: Sweep = "откуда берутся кандидаты", Профили = "как из кандидатов собрать понятные продукты".
          </Text>
        </Space>
      </Card>

      <Card
        title="Запросы пар на backtest -> задачи sweep"
        extra={
          <Space>
            <Button onClick={() => void fetchTasks()} loading={tasksLoading}>Обновить</Button>
            <Button onClick={() => void syncTasks()} loading={taskSyncLoading}>Подтянуть из клиентских запросов</Button>
            <Button type="primary" onClick={() => setManualSweepModalOpen(true)}>
              Новый sweep по парам/датам
            </Button>
          </Space>
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <span>Период:</span>
          <Input
            type="date"
            style={{ width: 150 }}
            value={taskDateFrom}
            onChange={(e) => setTaskDateFrom(e.target.value)}
          />
          <span>до</span>
          <Input
            type="date"
            style={{ width: 150 }}
            value={taskDateTo}
            onChange={(e) => setTaskDateTo(e.target.value)}
          />
          <Input
            style={{ width: 90 }}
            value={taskInterval}
            onChange={(e) => setTaskInterval(e.target.value)}
            placeholder="1h"
          />
          <Select
            value={sweepMode}
            style={{ width: 140 }}
            options={[
              { value: 'light', label: 'Режим sweep: мягкий' },
              { value: 'heavy', label: 'Режим sweep: жесткий' },
            ]}
            onChange={(value) => setSweepMode(value)}
          />
          <Checkbox checked={taskMarkDone} onChange={(e) => setTaskMarkDone(e.target.checked)}>
            Пометить выполненными после запуска
          </Checkbox>
          <Button type="primary" loading={taskRunLoading} onClick={() => void runSweepFromTasks()}>
            Запустить sweep по выбранным
          </Button>
          <Button onClick={() => void markTasks('done')}>Пометить выполненными</Button>
          <Button onClick={() => void markTasks('ignored')}>Игнорировать</Button>
          <Button onClick={() => void markTasks('new')}>Сбросить в new</Button>
        </Space>

        <Table
          dataSource={tasks}
          rowKey="id"
          loading={tasksLoading}
          size="small"
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <Empty description="Пока задач нет. Синхронизируйте клиентские запросы." /> }}
          columns={[
            {
              title: '',
              width: 44,
              render: (_: unknown, row: ResearchSweepTask) => (
                <Checkbox
                  checked={row.is_selected === 1}
                  onChange={(e) => void updateSelection(row.id, e.target.checked)}
                />
              ),
            },
            { title: 'ID', dataIndex: 'id', width: 65 },
            {
              title: 'Рынок',
              render: (_: unknown, row: ResearchSweepTask) => [row.base_symbol, row.quote_symbol].filter(Boolean).join('/') || row.base_symbol,
            },
            { title: 'Интервал', dataIndex: 'interval', width: 80 },
            {
              title: 'Клиент',
              render: (_: unknown, row: ResearchSweepTask) => row.tenant_name || `#${row.tenant_id || '—'}`,
            },
            {
              title: 'Статус',
              dataIndex: 'status',
              width: 110,
              render: (v: string) => <Tag color={statusColor(v)}>{v}</Tag>,
            },
            {
              title: 'Запрос',
              dataIndex: 'request_status',
              width: 110,
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: 'Запрошено',
              dataIndex: 'requested_at',
              width: 120,
              render: (v: string | null) => (v || '').slice(0, 10) || '—',
            },
            {
              title: 'Последний sweep',
              dataIndex: 'last_sweep_run_id',
              width: 90,
              render: (v: number | null) => (v ? `#${v}` : '—'),
            },
            {
              title: 'Заметка',
              dataIndex: 'note',
              render: (v: string) => v || '—',
            },
          ]}
        />
      </Card>

      <Card
        title="Задача high-frequency системы (офферы + TS под ритм сделок)"
        style={{ marginTop: 16 }}
      >
        <Space wrap>
          <Select
            value={hfApiKeyName || undefined}
            style={{ width: 220 }}
            placeholder="API key"
            options={apiKeys.map((row) => ({ value: row.name, label: row.name }))}
            onChange={(value) => setHfApiKeyName(value)}
          />
          <span>Цель по сделкам/день:</span>
          <InputNumber
            min={1}
            max={50}
            value={hfTargetTradesPerDay}
            onChange={(value) => setHfTargetTradesPerDay(Math.max(1, Math.min(50, Number(value || 10))))}
          />
          <Select
            value={sweepMode}
            style={{ width: 150 }}
            options={[
              { value: 'light', label: 'Режим: мягкий' },
              { value: 'heavy', label: 'Режим: жесткий' },
            ]}
            onChange={(value) => setSweepMode(value)}
          />
          <Button type="primary" loading={hfGenerateLoading} onClick={() => void generateHighFrequencySystem()}>
            Собрать TS + preview
          </Button>
        </Space>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          Создаёт новую торговую систему из sweep-кандидатов с фокусом на ритм сделок и ограничениями по PF/DD. Мягкий режим бережнее по нагрузке, жесткий расширяет перебор.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
          Важно: эта задача использует последний завершённый historical sweep artifact. Если heavy sweep ещё идёт, его частичные результаты сюда ещё не попадают.
        </Paragraph>
      </Card>

      <Divider />

      {/* Sweep section */}
      <SweepPanel onSweepSelect={handleSweepSelect} />

      <Divider />

      {/* BT vs RT Daily Snapshots */}
      <Modal
        title="Create Sweep From Pairs"
        open={manualSweepModalOpen}
        onCancel={() => setManualSweepModalOpen(false)}
        onOk={() => void runManualSweep()}
        okText="Run sweep"
        confirmLoading={manualSweepLoading}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input.TextArea
            rows={5}
            value={manualMarketsText}
            onChange={(e) => setManualMarketsText(e.target.value)}
            placeholder={'BTC/USDT\nETH/USDT\nSOL/USDT'}
          />
          <Space wrap>
            <span>From:</span>
            <Input type="date" style={{ width: 150 }} value={manualDateFrom} onChange={(e) => setManualDateFrom(e.target.value)} />
            <span>To:</span>
            <Input type="date" style={{ width: 150 }} value={manualDateTo} onChange={(e) => setManualDateTo(e.target.value)} />
            <Input
              style={{ width: 90 }}
              value={manualInterval}
              onChange={(e) => setManualInterval(e.target.value)}
              placeholder="1h"
            />
          </Space>
          <Input
            value={manualSweepName}
            onChange={(e) => setManualSweepName(e.target.value)}
            placeholder="Sweep name (optional)"
          />
          <Input
            value={manualSweepDescription}
            onChange={(e) => setManualSweepDescription(e.target.value)}
            placeholder="Description (optional)"
          />
          <Input.TextArea
            rows={2}
            value={manualSweepNote}
            onChange={(e) => setManualSweepNote(e.target.value)}
            placeholder="Note (optional)"
          />
          <Text type="secondary">
            Enter one market per line or separate by comma/semicolon. Date range and interval are stored in sweep config.
          </Text>
        </Space>
      </Modal>

      {/* BT vs RT Daily Snapshots */}
      <Card
        title="BT vs RT — Сравнение лайва с бектестом"
        style={{ marginTop: 24 }}
        extra={
          <Space>
            <InputNumber
              min={1}
              max={365}
              value={btRtDays}
              onChange={(v) => setBtRtDays(Number(v ?? 30))}
              addonBefore="дней"
              style={{ width: 120 }}
            />
            <Input
              placeholder="API key (опционально)"
              value={btRtApiKey}
              onChange={(e) => setBtRtApiKey(e.target.value)}
              style={{ width: 180 }}
            />
            <Button onClick={() => void fetchBtRtSnapshots()} loading={btRtLoading}>Обновить</Button>
            <Button type="primary" onClick={() => void runBtRtSweep()} loading={btRtRunLoading}>Запустить sweep сегодня</Button>
          </Space>
        }
      >
        <Table<BtRtSnapshot>
          dataSource={btRtRows}
          rowKey="id"
          loading={btRtLoading}
          size="small"
          pagination={{ pageSize: 50 }}
          columns={[
            { title: 'Дата', dataIndex: 'snapshot_date', width: 110 },
            { title: 'Клиент', dataIndex: 'api_key_name', width: 160, ellipsis: true },
            { title: 'Система', dataIndex: 'system_name', ellipsis: true },
            {
              title: 'RT доходн.%',
              dataIndex: 'rt_return_pct',
              width: 100,
              render: (v: number | null) => v != null ? (
                <Tag color={v >= 0 ? 'success' : 'error'}>{v.toFixed(2)}%</Tag>
              ) : '—',
            },
            {
              title: 'BT доходн.%',
              dataIndex: 'bt_total_return_pct',
              width: 100,
              render: (v: number | null) => v != null ? `${v.toFixed(2)}%` : '—',
            },
            {
              title: 'RT DD%',
              dataIndex: 'rt_drawdown_pct',
              width: 80,
              render: (v: number | null) => v != null ? <Text type={Math.abs(v) > 15 ? 'danger' : 'secondary'}>{v.toFixed(1)}%</Text> : '—',
            },
            {
              title: 'BT max DD%',
              dataIndex: 'bt_max_dd_pct',
              width: 90,
              render: (v: number | null) => v != null ? `${v.toFixed(1)}%` : '—',
            },
            {
              title: 'Входы/Выходы',
              width: 100,
              render: (_: unknown, row: BtRtSnapshot) => `${row.rt_entries ?? 0}/${row.rt_exits ?? 0}`,
            },
            {
              title: 'Дрейф',
              dataIndex: 'drift_flag',
              width: 100,
              render: (v: string | null, row: BtRtSnapshot) => {
                const color = v === 'critical' ? 'red' : v === 'warn' ? 'orange' : 'default';
                return (
                  <Tooltip title={`critical: ${row.drift_alerts_critical ?? 0}, warn: ${row.drift_alerts_warn ?? 0}, avg: ${row.drift_avg_pct?.toFixed(1) ?? '?'}%`}>
                    <Tag color={color}>{v || 'ok'}</Tag>
                  </Tooltip>
                );
              },
            },
          ]}
        />
      </Card>

    </div>
  );
}
