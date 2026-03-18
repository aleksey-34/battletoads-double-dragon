import React, { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
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
  const [registerForm] = Form.useForm();

  const fetchSweeps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get<{ sweeps: SweepRun[] }>('/api/research/sweeps');
      setSweeps(res.data.sweeps || []);
    } catch {
      message.error('Failed to load sweep runs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void fetchSweeps(); }, [fetchSweeps]);

  const handleRegister = async (values: { name: string; description: string; catalogPath: string }) => {
    try {
      await axios.post('/api/research/sweeps', {
        name: values.name,
        description: values.description,
        catalog_file_path: values.catalogPath,
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
        </Space>
      ),
    },
  ];

  return (
    <Card
      title="Sweep Runs"
      extra={
        <Button type="primary" size="small" onClick={() => setRegisterModal(true)}>
          + Register sweep
        </Button>
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
        Manage strategy profiles from sweep runs. Preview candidates, publish the best ones to the runtime circuit, build client presets.
      </Paragraph>

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
