import React, { useEffect, useState } from 'react';
import { Card, Spin, Alert, Table, Tag, Typography } from 'antd';
import axios from 'axios';
import { useI18n } from '../i18n';

type ParsedLogRow = {
  key: string;
  timestamp: string;
  level: string;
  message: string;
  service: string;
  raw: string;
};

const formatLogTimestamp = (raw: string): string => {
  const value = String(raw || '').trim();
  if (!value) {
    return '-';
  }

  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

const parseLogLine = (line: string, index: number): ParsedLogRow => {
  const raw = String(line || '').trim();
  if (!raw) {
    return {
      key: `raw-${index}`,
      timestamp: '-',
      level: 'info',
      message: '',
      service: '',
      raw,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      key: String(parsed?.timestamp || parsed?.time || `json-${index}`),
      timestamp: formatLogTimestamp(String(parsed?.timestamp || parsed?.time || '')),
      level: String(parsed?.level || 'info').toLowerCase(),
      message: String(parsed?.message || ''),
      service: String(parsed?.service || ''),
      raw,
    };
  } catch {
    return {
      key: `raw-${index}`,
      timestamp: '-',
      level: 'raw',
      message: raw,
      service: '',
      raw,
    };
  }
};

const Logs: React.FC = () => {
  const { t } = useI18n();
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    const password = localStorage.getItem('password');
    if (!password) {
      window.location.href = '/login';
      return;
    }
    axios.defaults.headers.common['Authorization'] = `Bearer ${password}`;

    fetchLogs();
  }, []);

  const fetchLogs = async () => {
    try {
      const res = await axios.get('/api/logs');
      setLogs(res.data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const rows: ParsedLogRow[] = logs
    .map((line, index) => parseLogLine(line, index))
    .filter((row) => String(row.message || '').trim().length > 0)
    .reverse();

  const levelColor = (level: string): string => {
    if (level === 'error') return 'red';
    if (level === 'warn' || level === 'warning') return 'gold';
    if (level === 'info') return 'blue';
    return 'default';
  };

  return (
    <div className="battletoads-form-shell">
      <h1>{t('logs.title', 'Logs')}</h1>
      <Card className="battletoads-card">
        {loading ? (
          <Spin tip={t('logs.loading', 'Loading logs...')} />
        ) : logs.length > 0 ? (
          <Table
            dataSource={rows}
            pagination={{ pageSize: 25, showSizeChanger: true }}
            size="small"
            scroll={{ x: 980 }}
            columns={[
              {
                title: t('logs.col.time', 'Date/Time'),
                dataIndex: 'timestamp',
                key: 'timestamp',
                width: 190,
              },
              {
                title: t('logs.col.level', 'Level'),
                dataIndex: 'level',
                key: 'level',
                width: 100,
                render: (value: string) => <Tag color={levelColor(String(value || ''))}>{String(value || '').toUpperCase()}</Tag>,
              },
              {
                title: t('logs.col.service', 'Service'),
                dataIndex: 'service',
                key: 'service',
                width: 140,
                render: (value: string) => <Typography.Text type="secondary">{value || '-'}</Typography.Text>,
              },
              {
                title: t('logs.col.message', 'Message'),
                dataIndex: 'message',
                key: 'message',
                render: (value: string, row: ParsedLogRow) => (
                  <Typography.Text style={{ whiteSpace: 'pre-wrap' }} title={row.raw}>
                    {value}
                  </Typography.Text>
                ),
              },
            ]}
          />
        ) : (
          <Alert type="info" message={t('logs.empty', 'No logs available')} showIcon />
        )}
      </Card>
    </div>
  );
};

export default Logs;