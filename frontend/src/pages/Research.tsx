import React, { useCallback, useEffect, useState } from 'react';
import {
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
  const [taskInterval, setTaskInterval] = useState('1h');
  const [taskDateFrom, setTaskDateFrom] = useState('');
  const [taskDateTo, setTaskDateTo] = useState('');
  const [taskMarkDone, setTaskMarkDone] = useState(true);

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

  const fetchTasks = useCallback(async () => {
    setTasksLoading(true);
    try {
      const res = await axios.get<{ tasks: ResearchSweepTask[] }>('/api/research/tasks/backtest-requests', {
        params: { limit: 500 },
      });
      setTasks(res.data?.tasks || []);
    } catch {
      message.error('Failed to load sweep tasks');
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
      });
      message.success(`Task sweep finished: #${res.data?.sweepRunId || 'n/a'}, imported ${res.data?.imported || 0}`);
      await Promise.all([fetchTasks(), fetchScheduler(), fetchProfiles()]);
    } catch (e: any) {
      message.error(e?.response?.data?.error || 'Task sweep failed');
    } finally {
      setTaskRunLoading(false);
    }
  };

  const markTasks = async (status: 'done' | 'ignored' | 'new') => {
    const selectedIds = tasks.filter((row) => row.is_selected === 1).map((row) => row.id);
    if (!selectedIds.length) {
      message.warning('Select tasks first');
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

  // ── Fetch API keys for publish modal ───────────────────────────────────────
  useEffect(() => {
    axios.get<ApiKeyRecord[]>('/api/api-keys').then(r => setApiKeys(r.data || [])).catch(() => {});
  }, []);

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
      <Title level={3}>Research Circuit</Title>
      <Paragraph type="secondary">
        Manage strategy profiles from sweep runs. Sweep is the auto-selection/data pipeline for presets and offers; manual Trading Systems are configured separately in the Trading Systems menu.
      </Paragraph>

      <Card
        title="Research Scheduler (daily incremental sweep)"
        loading={schedulerLoading}
        extra={
          <Space>
            <Tag color={schedulerJob?.is_enabled ? 'success' : 'default'}>
              {schedulerJob?.is_enabled ? 'enabled' : 'disabled'}
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
              <span>Time (UTC):</span>
              <InputNumber min={0} max={23} value={scheduleHourUtc} onChange={(v) => setScheduleHourUtc(Number(v ?? 0))} />
              <span>:</span>
              <InputNumber min={0} max={59} value={scheduleMinuteUtc} onChange={(v) => setScheduleMinuteUtc(Number(v ?? 0))} />
              <Button onClick={() => void saveScheduler()} loading={schedulerSaving}>Save</Button>
              <Button onClick={() => void toggleScheduler(!(schedulerJob?.is_enabled === 1))} loading={schedulerSaving}>
                {schedulerJob?.is_enabled === 1 ? 'Disable' : 'Enable'}
              </Button>
              <Button type="primary" onClick={() => void runSchedulerNow()} loading={schedulerRunNowLoading}>
                Run now
              </Button>
            </Space>
            <Space direction="vertical" size={2} style={{ marginTop: 12 }}>
              <Text type="secondary">Next run: {schedulerJob?.next_run_at || '—'}</Text>
              <Text type="secondary">Last run: {schedulerJob?.last_run_at || '—'}</Text>
              <Text type="secondary">Run count: {schedulerJob?.run_count ?? 0}</Text>
              {schedulerJob?.last_error ? <Text type="danger">Last error: {schedulerJob.last_error}</Text> : null}
            </Space>
            {schedulerRunNowLoading ? (
              <div style={{ marginTop: 12, maxWidth: 420 }}>
                <Text type="secondary">Sweep is running... elapsed {schedulerRunElapsedSec}s</Text>
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
              <Descriptions.Item label="main.db size">
                {observability?.files?.mainDb?.sizeBytes ?? 0} bytes
              </Descriptions.Item>
              <Descriptions.Item label="research.db size">
                {observability?.files?.researchDb?.sizeBytes ?? 0} bytes
              </Descriptions.Item>
              <Descriptions.Item label="main rows total">
                {observability?.rowCounts?.totals?.main ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="research rows total">
                {observability?.rowCounts?.totals?.research ?? 0}
              </Descriptions.Item>
              <Descriptions.Item label="latest sweep lag (hours)">
                {observability?.freshness?.latestSweepLagHours ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label="latest sweep">
                {observability?.freshness?.latestSweep?.name || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Observed at (UTC)">
                {observability?.atUtc || '—'}
              </Descriptions.Item>
            </Descriptions>
          </Col>
        </Row>
      </Card>

      <Divider />

      <Card
        title="Backtest Pair Requests -> Sweep Tasks"
        extra={
          <Space>
            <Button onClick={() => void fetchTasks()} loading={tasksLoading}>Refresh</Button>
            <Button onClick={() => void syncTasks()} loading={taskSyncLoading}>Sync from client requests</Button>
          </Space>
        }
      >
        <Space wrap style={{ marginBottom: 12 }}>
          <span>Period:</span>
          <Input
            type="date"
            style={{ width: 150 }}
            value={taskDateFrom}
            onChange={(e) => setTaskDateFrom(e.target.value)}
          />
          <span>to</span>
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
          <Checkbox checked={taskMarkDone} onChange={(e) => setTaskMarkDone(e.target.checked)}>
            Mark done after run
          </Checkbox>
          <Button type="primary" loading={taskRunLoading} onClick={() => void runSweepFromTasks()}>
            Run sweep from selected
          </Button>
          <Button onClick={() => void markTasks('done')}>Mark done</Button>
          <Button onClick={() => void markTasks('ignored')}>Mark ignored</Button>
          <Button onClick={() => void markTasks('new')}>Reset to new</Button>
        </Space>

        <Table
          dataSource={tasks}
          rowKey="id"
          loading={tasksLoading}
          size="small"
          pagination={{ pageSize: 12 }}
          locale={{ emptyText: <Empty description="No tasks yet. Sync from client requests." /> }}
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
              title: 'Market',
              render: (_: unknown, row: ResearchSweepTask) => [row.base_symbol, row.quote_symbol].filter(Boolean).join('/') || row.base_symbol,
            },
            { title: 'Interval', dataIndex: 'interval', width: 80 },
            {
              title: 'Tenant',
              render: (_: unknown, row: ResearchSweepTask) => row.tenant_name || `#${row.tenant_id || '—'}`,
            },
            {
              title: 'Status',
              dataIndex: 'status',
              width: 110,
              render: (v: string) => <Tag color={statusColor(v)}>{v}</Tag>,
            },
            {
              title: 'Request',
              dataIndex: 'request_status',
              width: 110,
              render: (v: string) => <Tag>{v}</Tag>,
            },
            {
              title: 'Requested',
              dataIndex: 'requested_at',
              width: 120,
              render: (v: string | null) => (v || '').slice(0, 10) || '—',
            },
            {
              title: 'Last sweep',
              dataIndex: 'last_sweep_run_id',
              width: 90,
              render: (v: number | null) => (v ? `#${v}` : '—'),
            },
            {
              title: 'Note',
              dataIndex: 'note',
              render: (v: string) => v || '—',
            },
          ]}
        />
      </Card>

      <Divider />

      {/* Sweep section */}
      <SweepPanel onSweepSelect={handleSweepSelect} />

      <Divider />

      {/* Profile filters */}
      <Card
        title={
          <Space>
            <span>Strategy Profiles</span>
            <Badge count={total} showZero style={{ backgroundColor: '#1677ff' }} />
          </Space>
        }
        extra={
          <Space>
            {filterSweepId != null && (
              <Tag closable onClose={() => handleSweepSelect(null)} color="blue">
                Sweep #{filterSweepId}
              </Tag>
            )}
            <Select
              allowClear
              placeholder="Filter by status"
              style={{ width: 150 }}
              value={filterStatus || undefined}
              onChange={(v) => setFilterStatus(v ?? '')}
              options={[
                { value: 'candidate', label: 'Candidate' },
                { value: 'published', label: 'Published' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <Button size="small" onClick={() => void fetchProfiles()}>Refresh</Button>
          </Space>
        }
      >
        <Table
          dataSource={profiles}
          rowKey="id"
          columns={columns}
          loading={loadingProfiles}
          size="small"
          pagination={{
            current: page,
            pageSize,
            total,
            onChange: (p) => setPage(p),
            showTotal: (t) => `${t} profiles`,
          }}
          locale={{ emptyText: <Empty description="No profiles found. Import candidates from a sweep run." /> }}
          rowClassName={(row) => row.status === 'published' ? 'ant-table-row-green' : ''}
        />
      </Card>

      {/* Publish modal */}
      <Modal
        title={`Publish Profile #${publishModal?.profile.id} to Runtime`}
        open={!!publishModal}
        onCancel={() => setPublishModal(null)}
        onOk={() => void handlePublish()}
        okText="Publish"
        confirmLoading={publishLoading}
      >
        {publishModal && (
          <>
            <Paragraph>
              Publishing <Text strong>{publishModal.profile.name}</Text> will create (or update) a strategy entry in the main database with <Text code>is_runtime=1</Text>.
            </Paragraph>
            <Form layout="vertical">
              <Form.Item label="Target API Key (runtime exchange account)">
                <Select
                  value={publishApiKey}
                  onChange={setPublishApiKey}
                  options={apiKeys.map(k => ({ value: k.name, label: `${k.name} (${k.exchange})` }))}
                  placeholder="Select API key"
                />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      {/* Preview result modal */}
      <PreviewResultModal
        job={previewJobResult}
        onClose={() => setPreviewJobResult(null)}
      />
    </div>
  );
}
