import React, { useEffect, useState } from 'react';
import { Form, Input, Button, Select, message, Card, List, Popconfirm, Switch, InputNumber, Alert, Tag, Space, Typography } from 'antd';
import axios from 'axios';

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

const Settings: React.FC = () => {
  const [apiKeys, setApiKeys] = useState<ApiKeyRecord[]>([]);
  const [editingKey, setEditingKey] = useState<ApiKeyRecord | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateJob, setUpdateJob] = useState<UpdateJob | null>(null);
  const [updateLoading, setUpdateLoading] = useState<boolean>(false);
  const [updateRunLoading, setUpdateRunLoading] = useState<boolean>(false);
  const [jobLoading, setJobLoading] = useState<boolean>(false);
  const [form] = Form.useForm();

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
      message.error(error?.response?.data?.error || 'Failed to load git update status');
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
      message.error(error?.response?.data?.error || 'Failed to load git update job status');
    } finally {
      setJobLoading(false);
    }
  };

  const runGitUpdate = async () => {
    setUpdateRunLoading(true);
    try {
      const res = await axios.post('http://localhost:3001/api/system/update/run');
      const unit = String(res?.data?.unit || 'btdd-git-update');
      message.success(`Update started (${unit}). Backend may restart during deploy.`);

      setTimeout(() => {
        void fetchUpdateJob();
        void fetchUpdateStatus(true);
      }, 1200);
    } catch (error: any) {
      console.error(error);
      message.error(error?.response?.data?.error || 'Failed to start git update');
    } finally {
      setUpdateRunLoading(false);
    }
  };

  const deleteApiKey = async (id: number) => {
    try {
      await axios.delete(`http://localhost:3001/api/api-keys/${id}`);
      message.success('API Key deleted');
      fetchApiKeys();
    } catch (error) {
      message.error('Error deleting API Key');
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
        message.success('API Key updated');
        setEditingKey(null);
        form.resetFields();
      } else {
        await axios.post('http://localhost:3001/api/api-keys', payload);
        message.success('API Key added');
      }
      fetchApiKeys();
    } catch (error) {
      message.error('Error saving API Key');
    }
  };

  return (
    <div>
      <Card title={editingKey ? "Edit API Key" : "Add API Key"}>
        <Form form={form} onFinish={onFinishApiKey} initialValues={{ exchange: 'Bybit', passphrase: '', speed_limit: 10, testnet: false, demo: false }}>
          <Form.Item name="name" rules={[{ required: true }]}>
            <Input placeholder="Name" />
          </Form.Item>
          <Form.Item name="exchange" rules={[{ required: true }]}>
            <Select placeholder="Exchange">
              <Option value="Bybit">Bybit</Option>
              <Option value="Bitget">Bitget Futures</Option>
              <Option value="BingX">BingX Futures</Option>
            </Select>
          </Form.Item>
          <Form.Item name="api_key" rules={[{ required: true }]}>
            <Input placeholder="API Key" />
          </Form.Item>
          <Form.Item name="secret" rules={[{ required: true }]}>
            <Input.Password placeholder="Secret" />
          </Form.Item>
          <Form.Item shouldUpdate noStyle>
            {() => {
              const exchange = String(form.getFieldValue('exchange') || '');
              const needsPassphrase = exchange === 'Bitget';

              return (
                <Form.Item
                  name="passphrase"
                  rules={needsPassphrase ? [{ required: true, message: 'Passphrase is required for Bitget' }] : []}
                >
                  <Input.Password placeholder="Passphrase (required for Bitget, optional otherwise)" />
                </Form.Item>
              );
            }}
          </Form.Item>
          <Form.Item name="speed_limit" rules={[{ required: false }]}>
            <InputNumber min={1} max={200} style={{ width: '100%' }} placeholder="Speed Limit (req/sec), default 10" />
          </Form.Item>
          <Form.Item name="testnet" valuePropName="checked" label="Testnet">
            <Switch />
          </Form.Item>
          <Form.Item name="demo" valuePropName="checked" label="Demo Trading (api-demo.bybit.com)">
            <Switch />
          </Form.Item>
          <Button type="primary" htmlType="submit">{editingKey ? 'Update' : 'Add'}</Button>
          {editingKey && <Button onClick={() => { setEditingKey(null); form.resetFields(); }}>Cancel</Button>}
        </Form>
      </Card>
      <Card title="API Keys List" style={{ marginTop: 16 }}>
        <List
          dataSource={apiKeys}
          renderItem={item => (
            <List.Item
              actions={[
                <Button onClick={() => editApiKey(item)}>Edit</Button>,
                <Popconfirm
                  title="Delete this API key?"
                  onConfirm={() => deleteApiKey(item.id)}
                  okText="Yes"
                  cancelText="No"
                >
                  <Button danger>Delete</Button>
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
                  <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    ID #{item.id}
                  </Typography.Text>
                </div>

                <Space size={6} wrap>
                  <Tag>{item.exchange}</Tag>
                  <Tag color={item.testnet ? 'gold' : 'default'}>Testnet: {item.testnet ? 'On' : 'Off'}</Tag>
                  <Tag color={item.demo ? 'blue' : 'default'}>Demo: {item.demo ? 'On' : 'Off'}</Tag>
                </Space>
              </div>
            </List.Item>
          )}
        />
      </Card>

      <Card title="Git Update (VPS)" style={{ marginTop: 16 }}>
        <Space wrap style={{ marginBottom: 12 }}>
          <Button loading={updateLoading} onClick={() => { void fetchUpdateStatus(true); }}>
            Check updates
          </Button>
          <Button loading={jobLoading} onClick={() => { void fetchUpdateJob(); }}>
            Refresh job
          </Button>
          <Button
            type="primary"
            loading={updateRunLoading}
            disabled={!updateStatus?.configured || !updateStatus?.updateEnabled}
            onClick={() => { void runGitUpdate(); }}
          >
            Install from Git
          </Button>

          {updateStatus
            ? (
              <Tag color={updateStatus.updateAvailable ? 'gold' : 'green'}>
                {updateStatus.updateAvailable ? `Update available (${updateStatus.behind})` : 'Up to date'}
              </Tag>
            )
            : null}

          {updateStatus && !updateStatus.updateEnabled ? <Tag color="red">Update API disabled</Tag> : null}
        </Space>

        {!updateStatus ? <Alert type="info" showIcon message="Loading update status..." style={{ marginBottom: 10 }} /> : null}

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
          <Card size="small" title="What's new in Git" style={{ marginBottom: 10 }}>
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

        {updateJob ? (
          <Card size="small" title="Update Job">
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