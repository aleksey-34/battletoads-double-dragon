import React, { useEffect, useState } from 'react';
import { Card, Spin, Alert } from 'antd';
import axios from 'axios';

const Logs: React.FC = () => {
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
      const res = await axios.get('http://localhost:3001/api/logs');
      setLogs(res.data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Logs</h1>
      <Card>
        {loading ? (
          <Spin />
        ) : logs.length > 0 ? (
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {logs.join('\n')}
          </pre>
        ) : (
          <Alert type="info" message="No logs available" showIcon />
        )}
      </Card>
    </div>
  );
};

export default Logs;