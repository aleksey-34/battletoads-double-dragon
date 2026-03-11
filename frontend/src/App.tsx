import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, FloatButton, Tag, Button, Space } from 'antd';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Positions from './pages/Positions';
import Login from './pages/Login';
import Logs from './pages/Logs';
import Backtest from './pages/Backtest';
import './App.css';

const { Header, Content } = Layout;

type AuthState = 'checking' | 'ok' | 'missing' | 'invalid' | 'error';

function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [authCheckLoading, setAuthCheckLoading] = useState(false);

  const menuItems = [
    { key: '1', label: <Link to="/">Dashboard</Link> },
    { key: '2', label: <Link to="/settings">Settings</Link> },
    { key: '3', label: <Link to="/positions">Positions</Link> },
    { key: '4', label: <Link to="/logs">Logs</Link> },
    { key: '5', label: <Link to="/backtest">Backtest</Link> },
  ];

  const selectedMenuKey = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return '2';
    if (location.pathname.startsWith('/positions')) return '3';
    if (location.pathname.startsWith('/logs')) return '4';
    if (location.pathname.startsWith('/backtest')) return '5';
    return '1';
  }, [location.pathname]);

  const checkAuth = async () => {
    const password = localStorage.getItem('password');

    if (!password) {
      setAuthState('missing');
      delete axios.defaults.headers.common.Authorization;
      if (location.pathname !== '/login') {
        navigate('/login');
      }
      return;
    }

    setAuthCheckLoading(true);
    axios.defaults.headers.common.Authorization = `Bearer ${password}`;

    try {
      await axios.get('/api/api-keys');
      setAuthState('ok');
      if (location.pathname === '/login') {
        navigate('/');
      }
    } catch (error: any) {
      if (Number(error?.response?.status || 0) === 401) {
        setAuthState('invalid');
      } else {
        setAuthState('error');
      }
    } finally {
      setAuthCheckLoading(false);
    }
  };

  useEffect(() => {
    void checkAuth();
    const syncAuth = () => {
      void checkAuth();
    };

    window.addEventListener('auth-changed', syncAuth);
    window.addEventListener('storage', syncAuth);
    return () => {
      window.removeEventListener('auth-changed', syncAuth);
      window.removeEventListener('storage', syncAuth);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const handleLogout = () => {
    localStorage.removeItem('password');
    delete axios.defaults.headers.common.Authorization;
    setAuthState('missing');
    window.dispatchEvent(new Event('auth-changed'));
    navigate('/login');
  };

  const statusTag = (() => {
    if (authState === 'ok') return <Tag color="success">Session: active</Tag>;
    if (authState === 'missing') return <Tag color="default">Session: missing</Tag>;
    if (authState === 'invalid') return <Tag color="error">Session: invalid password</Tag>;
    if (authState === 'error') return <Tag color="warning">Session: backend unavailable</Tag>;
    return <Tag color="processing">Session: checking</Tag>;
  })();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ color: 'white', paddingInline: 16 }}>
        <div className="app-header-row">
          <Menu className="app-main-menu" theme="dark" mode="horizontal" selectedKeys={[selectedMenuKey]} items={menuItems} />
          <Space className="app-account-menu" size={8}>
            {statusTag}
            <Button size="small" onClick={() => void checkAuth()} loading={authCheckLoading}>Check</Button>
            {authState === 'ok' ? (
              <Button size="small" danger onClick={handleLogout}>Logout</Button>
            ) : (
              <Button size="small" type="primary" onClick={() => navigate('/login')}>Login</Button>
            )}
          </Space>
        </div>
      </Header>
      <Content style={{ padding: '20px' }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/backtest" element={<Backtest />} />
        </Routes>
      </Content>
      <FloatButton.BackTop visibilityHeight={280} />
    </Layout>
  );
}

function App() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AppShell />
    </Router>
  );
}

export default App;