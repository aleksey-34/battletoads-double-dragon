import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Select, message, Card, List, Popconfirm, Switch, InputNumber, Alert, Tag, Space, Typography } from 'antd';
import axios from 'axios';
import { useI18n } from '../i18n';

const { Option } = Select;

type ApiKeyRecord = {
  id: number;
  name: string;
  exchange: string;
  api_key: string;
  secret: string;
  passphrase?: string;
  speed_limit: number;
  testnet?: boolean;
  demo?: boolean;
};

type UpdateCommit = {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
};

type UpdateStatus = {
  configured: boolean;
  updateEnabled: boolean;
  repoDir: string;
  appDir: string;
  branch: string;
  originUrl: string;
  localHash: string;
  remoteHash: string;
  ahead: number;
  behind: number;
  dirtyCount: number;
  updateAvailable: boolean;
  latestCommit: UpdateCommit | null;
  pendingCommits: UpdateCommit[];
  message?: string;
};

type UpdateJob = {
  unit: string;
  exists: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  result: string;
  execMainStatus: string;
  startedAt: string;
  exitedAt: string;
  logs: string;
};

type UpdateRequestEvent = {
  id: string;
  at: string;
  level: 'info' | 'success' | 'error';
  message: string;
  details?: string;
};

const UPDATE_REQUEST_LOG_KEY = 'btdd_update_request_log_v1';
const MAX_UPDATE_REQUEST_LOG = 20;

const readUpdateRequestLog = (): UpdateRequestEvent[] => {
  try {
    const raw = localStorage.getItem(UPDATE_REQUEST_LOG_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || ''),
        at: String(item.at || ''),
        level: (item.level === 'success' || item.level === 'error' ? item.level : 'info') as 'info' | 'success' | 'error',
        message: String(item.message || ''),
        details: item.details ? String(item.details) : undefined,
      }))
      .filter((item) => Boolean(item.id) && Boolean(item.at) && Boolean(item.message));
  } catch {
    return [];
  }
};

const extractApiErrorMessage = (error: any, fallback: string): string => {
  const apiError = error?.response?.data?.error;
  if (typeof apiError === 'string' && apiError.trim()) {
    return apiError.trim();
  }

  const apiText = error?.response?.data;
  if (typeof apiText === 'string' && apiText.trim()) {
    return apiText.trim();
  }

  const messageText = error?.message;
  if (typeof messageText === 'string' && messageText.trim()) {
    return messageText.trim();
  }

  return fallback;
};

const Settings: React.FC = () => {
  const { t } = useI18n();
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [updateLoading, setUpdateLoading] = useState<boolean>(false);
  const [updateRunLoading, setUpdateRunLoading] = useState<boolean>(false);
  const [jobLoading, setJobLoading] = useState<boolean>(false);
  const [updateRequestLog, setUpdateRequestLog] = useState<UpdateRequestEvent[]>(() => readUpdateRequestLog());
  const [form] = Form.useForm();

  const appendUpdateRequestLog = (event: Omit<UpdateRequestEvent, 'id' | 'at'>) => {
    const nextEvent: UpdateRequestEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...event,
    };

    setUpdateRequestLog((prev) => {
      const next = [nextEvent, ...prev].slice(0, MAX_UPDATE_REQUEST_LOG);
      try {
        localStorage.setItem(UPDATE_REQUEST_LOG_KEY, JSON.stringify(next));
      } catch {
        // Ignore localStorage quota or access errors.
      }
      return next;
    });
  };

  const clearUpdateRequestLog = () => {
    setUpdateRequestLog([]);
    try {
      localStorage.removeItem(UPDATE_REQUEST_LOG_KEY);
    } catch {
      // Ignore localStorage access errors.
    }
  };

  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }

    axios.defaults.headers.common.Authorization = `Bearer ${password}`;
    fetchApiKeys();
    void fetchUpdateStatus(true);
    void fetchUpdateJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const activeState = String(updateJob?.activeState || '').toLowerCase();
    if (activeState !== 'active' && activeState !== 'activating') {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchUpdateJob();
      void fetchUpdateStatus(false);
    }, 5000);

    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateJob?.activeState]);

  const fetchApiKeys = async () => {
    try {
      const res = await axios.get('http://localhost:3001/api/api-keys');
      setApiKeys(res.data);
    } catch (error) {
      console.error(error);
    }
  };

  const fetchUpdateStatus = async (refreshRemote: boolean = true) => {
    setUpdateLoading(true);
    try {
      const res = await axios.get('http://localhost:3001/api/system/update/status', {
        params: {
          refresh: refreshRemote ? 1 : 0,
        },
      });
      setUpdateStatus(res.data as UpdateStatus);
    } catch (error: any) {
      console.error(error);
      message.error(extractApiErrorMessage(error, t('settings.msg.statusLoadError', 'Failed to load git update status')));
    } finally {
      setUpdateLoading(false);
    }
  };

  const fetchUpdateJob = async () => {
    setJobLoading(true);
    try {
      const res = await axios.get('http://localhost:3001/api/system/update/job');
      setUpdateJob(res.data as UpdateJob);
    } catch (error: any) {
      console.error(error);
      message.error(extractApiErrorMessage(error, t('settings.msg.jobLoadError', 'Failed to load git update job status')));
    } finally {
      setJobLoading(false);
    }
  };

  const runGitUpdate = async () => {
    setUpdateRunLoading(true);
    appendUpdateRequestLog({
      level: 'info',
      message: 'Install from Git clicked',
      details: 'Request sent to /api/system/update/run',
    });

    try {
      const res = await axios.post('http://localhost:3001/api/system/update/run');
      const started = Boolean(res?.data?.started);
      const unit = String(res?.data?.unit || 'btdd-git-update');
      const backendMessage = String(res?.data?.message || '').trim();

      if (!started) {
        const text = backendMessage || t('settings.update.upToDate', 'Up to date');
        message.info(text);
        appendUpdateRequestLog({
          level: 'info',
          message: text,
          details: `Unit: ${unit}`,
        });
      } else {
        message.success(t('settings.msg.runStarted', 'Update started ({unit}). Backend may restart during deploy.', { unit }));
        appendUpdateRequestLog({
          level: 'success',
          message: `Update started (${unit})`,
          details: backendMessage || undefined,
        });
      }

      setTimeout(() => {
        void fetchUpdateJob();
        void fetchUpdateStatus(true);
      }, 1200);
    } catch (error: any) {
      console.error(error);
      const errorText = extractApiErrorMessage(error, t('settings.msg.runError', 'Failed to start git update'));
      const status = Number(error?.response?.status);
      const method = String(error?.config?.method || '').toUpperCase();
      const url = String(error?.config?.url || '');
      const errorCode = String(error?.code || '');
      const responseData = error?.response?.data;
      const backendErrorText = typeof responseData?.error === 'string'
        ? responseData.error
        : typeof responseData === 'string'
          ? responseData
          : '';

      const detailsParts: string[] = [];
      if (Number.isFinite(status)) {
        detailsParts.push(`HTTP ${status}`);
      }
      if (method || url) {
        detailsParts.push(`${method || 'REQUEST'} ${url || '/api/system/update/run'}`);
      }
      if (errorCode) {
        detailsParts.push(`code=${errorCode}`);
      }
      if (backendErrorText && backendErrorText !== errorText) {
        detailsParts.push(backendErrorText);
      }

      message.error(errorText);
      appendUpdateRequestLog({
        level: 'error',
        message: errorText,
        details: detailsParts.join(' | ') || undefined,
      });

      setTimeout(() => {
        void fetchUpdateJob();
        void fetchUpdateStatus(false);
      }, 800);
    } finally {
      setUpdateRunLoading(false);
    }
  };

  const deleteApiKey = async (id: number) => {
    try {
      await axios.delete(`http://localhost:3001/api/api-keys/${id}`);
      message.success(t('settings.msg.apiKeyDeleted', 'API Key deleted'));
      fetchApiKeys();
    } catch (error) {
      message.error(t('settings.msg.apiKeyDeleteError', 'Error deleting API Key'));
    }
  };

  const editApiKey = (key: ApiKeyRecord) => {
    setEditingKey(key);
    form.setFieldsValue({
      ...key,
      passphrase: key.passphrase || '',
      testnet: Boolean(key.testnet),
      demo: Boolean(key.demo),
      speed_limit: key.speed_limit || 10,
    });
  };

  const onFinishApiKey = async (values: any) => {
    try {
      const payload = {
        ...values,
        passphrase: values.passphrase || '',
        speed_limit: Number(values.speed_limit) || 10,
        testnet: Boolean(values.testnet),
        demo: Boolean(values.demo),
      };

      if (editingKey) {
        await axios.put(`http://localhost:3001/api/api-keys/${editingKey.id}`, payload);
        message.success(t('settings.msg.apiKeyUpdated', 'API Key updated'));
        setEditingKey(null);
        form.resetFields();
      } else {
        await axios.post('http://localhost:3001/api/api-keys', payload);
        message.success(t('settings.msg.apiKeyAdded', 'API Key added'));
      }
      fetchApiKeys();
    } catch (error) {
      message.error(t('settings.msg.apiKeySaveError', 'Error saving API Key'));
    }
  };

  return (
    <div className="battletoads-form-shell">
      <Card className="battletoads-card" title={editingKey ? t('settings.form.editApiKey', 'Edit API Key') : t('settings.form.addApiKey', 'Add API Key')}>
        <Form className="battletoads-form" form={form} onFinish={onFinishApiKey} initialValues={{ exchange: 'Bybit', passphrase: '', speed_limit: 10, testnet: false, demo: false }}>
          <Form.Item label={t('settings.form.name', 'Name')} name="name" rules={[{ required: true }]}>
            <Input placeholder={t('settings.form.name', 'Name')} />
          </Form.Item>
          <Form.Item label={t('settings.form.exchange', 'Exchange')} name="exchange" rules={[{ required: true }]}>
            <Select placeholder={t('settings.form.exchange', 'Exchange')}>
              <Option value="Bybit">Bybit</Option>
              <Option value="Bitget">Bitget Futures</Option>
              <Option value="BingX">BingX Futures</Option>
            </Select>
          </Form.Item>
          <Form.Item label={t('settings.form.apiKey', 'API Key')} name="api_key" rules={[{ required: true }]}>
            <Input placeholder={t('settings.form.apiKey', 'API Key')} />
          </Form.Item>
          <Form.Item label={t('settings.form.secret', 'Secret')} name="secret" rules={[{ required: true }]}>
            <Input.Password placeholder={t('settings.form.secret', 'Secret')} />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const exchange = String(form.getFieldValue('exchange') || '');
              const needsPassphrase = exchange === 'Bitget';

              return (
                <Form.Item
                  label="Passphrase"
                  name="passphrase"
                  rules={needsPassphrase ? [{ required: true, message: t('settings.form.passphraseRequiredBitget', 'Passphrase is required for Bitget') }] : []}
                >
                  <Input.Password placeholder={t('settings.form.passphrase', 'Passphrase (required for Bitget, optional otherwise)')} />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item label="RPS" name="speed_limit" rules={[{ required: false }]}>
            <InputNumber min={1} max={200} style={{ width: '100%' }} placeholder={t('settings.form.speedLimit', 'Speed Limit (req/sec), default 10')} />
          </Form.Item>
          <Form.Item name="testnet" valuePropName="checked" label={t('settings.form.testnet', 'Testnet')}>
            <Switch />
          </Form.Item>
          <Form.Item name="demo" valuePropName="checked" label={t('settings.form.demo', 'Demo Trading (api-demo.bybit.com)')}>
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit">{editingKey ? t('settings.form.update', 'Update') : t('settings.form.add', 'Add')}</Button>
          {editingKey && <Button onClick={() => { setEditingKey(null); form.resetFields(); }}>{t('settings.form.cancel', 'Cancel')}</Button>}
        </Form>
      </Card>
      <Card className="battletoads-card" title={t('settings.list.title', 'API Keys List')} style={{ marginTop: 16 }}>
        <List
          dataSource={apiKeys}
          renderItem={item => (
            <List.Item
              actions={[
                <Button onClick={() => editApiKey(item)}>{t('settings.list.edit', 'Edit')}</Button>,
                <Popconfirm
                  title={t('settings.list.deleteConfirm', 'Delete this API key?')}
                  onConfirm={() => deleteApiKey(item.id)}
                  okText={t('settings.list.yes', 'Yes')}
                  cancelText={t('settings.list.no', 'No')}
                >
                  <Button danger>{t('settings.list.delete', 'Delete')}</Button>
                </Popconfirm>
              ]}
            >
              <div
                style={{
                  width: '100%',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <Typography.Text strong>{item.name}</Typography.Text>
                </div>

                <Space size={6} wrap>
                  <Tag>{item.exchange}</Tag>
                  <Tag color={item.testnet ? 'gold' : 'default'}>{t('settings.list.testnet', 'Testnet')}: {item.testnet ? 'On' : 'Off'}</Tag>
                  <Tag color={item.demo ? 'blue' : 'default'}>{t('settings.list.demo', 'Demo')}: {item.demo ? 'On' : 'Off'}</Tag>
                </Space>
              </div>
            </List.Item>
          )}
        />
      </Card>

      <Card className="battletoads-card" title={t('settings.update.title', 'Git Update (VPS)')} style={{ marginTop: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Button loading={updateLoading} onClick={() => { void fetchUpdateStatus(true); }}>
            {t('settings.update.check', 'Check updates')}
          </Button>
          <Button loading={jobLoading} onClick={() => { void fetchUpdateJob(); }}>
            {t('settings.update.refreshJob', 'Refresh job')}
          </Button>
          <Button
            type="primary"
            loading={updateRunLoading}
            disabled={!updateStatus?.configured || !updateStatus?.updateEnabled || !updateStatus?.updateAvailable}
            onClick={() => { void runGitUpdate(); }}
          >
            {t('settings.update.install', 'Install from Git')}
          </Button>

          {updateStatus
            ? (
              <Tag color={updateStatus.updateAvailable ? 'gold' : 'green'}>
                {updateStatus.updateAvailable
                  ? t('settings.update.available', 'Update available ({count})', { count: updateStatus.behind })
                  : t('settings.update.upToDate', 'Up to date')}
              </Tag>
            )
            : null}

          {updateStatus && !updateStatus.updateEnabled ? <Tag color="red">{t('settings.update.disabled', 'Update API disabled')}</Tag> : null}
        </Space>

        {!updateStatus ? <Alert type="info" showIcon message={t('settings.update.loading', 'Loading update status...')} style={{ marginBottom: 10 }} /> : null}

        {updateStatus && !updateStatus.configured
          ? <Alert type="warning" showIcon message={updateStatus.message || 'Git repository is not configured on this server.'} style={{ marginBottom: 10 }} />
          : null}

        {updateStatus && updateStatus.configured ? (
          <div style={{ marginBottom: 10, fontSize: 13 }}>
            <div><strong>Origin:</strong> {updateStatus.originUrl || '-'}</div>
            <div><strong>Branch:</strong> {updateStatus.branch || '-'}</div>
            <div><strong>Repo dir:</strong> {updateStatus.repoDir || '-'}</div>
            <div><strong>Local commit:</strong> {updateStatus.localHash || '-'}</div>
            <div><strong>Remote commit:</strong> {updateStatus.remoteHash || '-'}</div>
            <div><strong>Ahead/Behind:</strong> {updateStatus.ahead} / {updateStatus.behind}</div>
            <div><strong>Dirty files:</strong> {updateStatus.dirtyCount}</div>
          </div>
        ) : null}

        {updateStatus && updateStatus.pendingCommits && updateStatus.pendingCommits.length > 0 ? (
          <Card size="small" title={t('settings.update.whatsNew', "What's new in Git")} style={{ marginBottom: 10 }}>
            <List
              size="small"
              dataSource={updateStatus.pendingCommits}
              renderItem={(commit) => (
                <List.Item>
                  <List.Item.Meta
                    title={`${commit.shortHash} - ${commit.subject}`}
                    description={`${commit.date} (${commit.hash})`}
                  />
                </List.Item>
              )}
            />
          </Card>
        ) : null}

        <Card
          size="small"
          title="Update Request Log (UI)"
          style={{ marginBottom: 10 }}
          extra={(
            <Button size="small" onClick={clearUpdateRequestLog} disabled={updateRequestLog.length === 0}>
              Clear
            </Button>
          )}
        >
          {updateRequestLog.length === 0
            ? <Alert type="info" showIcon message="No captured update request errors yet." />
            : (
              <List
                size="small"
                dataSource={updateRequestLog}
                renderItem={(event) => {
                  const tagColor = event.level === 'success' ? 'green' : event.level === 'error' ? 'red' : 'blue';
                  const atLabel = Number.isFinite(Date.parse(event.at))
                    ? new Date(event.at).toLocaleString()
                    : event.at;

                  return (
                    <List.Item>
                      <List.Item.Meta
                        title={<Space><Tag color={tagColor}>{event.level.toUpperCase()}</Tag><span>{event.message}</span></Space>}
                        description={event.details ? `${atLabel} | ${event.details}` : atLabel}
                      />
                    </List.Item>
                  );
                }}
              />
            )}
        </Card>

        {updateJob ? (
          <Card size="small" title={t('settings.update.job', 'Update Job')}>
            <div style={{ fontSize: 13 }}>
              <div><strong>Unit:</strong> {updateJob.unit}</div>
              <div><strong>State:</strong> {updateJob.activeState} / {updateJob.subState}</div>
              <div><strong>Result:</strong> {updateJob.result}</div>
              <div><strong>Started:</strong> {updateJob.startedAt || '-'}</div>
              <div><strong>Exited:</strong> {updateJob.exitedAt || '-'}</div>
            </div>
            <pre
              style={{
                marginTop: 8,
                background: '#f7f7f7',
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                padding: 10,
                maxHeight: 240,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
              }}
            >
              {updateJob.logs || 'No logs yet'}
            </pre>
          </Card>
        ) : null}
      </Card>
    </div>
  );
};

export default Settings;