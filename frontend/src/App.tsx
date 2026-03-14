import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Link, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, FloatButton, Tag, Button, Space, Select, Typography, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import trTR from 'antd/locale/tr_TR';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Positions from './pages/Positions';
import Login from './pages/Login';
import Logs from './pages/Logs';
import Backtest from './pages/Backtest';
import SaaS from './pages/SaaS';
import { I18nProvider, useI18n, UILanguage } from './i18n';
import './App.css';

const { Header, Content } = Layout;

type AuthState = 'checking' | 'ok' | 'missing' | 'invalid' | 'error';

function AppShell() {
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [authCheckLoading, setAuthCheckLoading] = useState(false);

  const menuItems = [
    { key: '1', label: <Link to="/">{t('nav.dashboard', 'Dashboard')}</Link> },
    { key: '2', label: <Link to="/settings">{t('nav.settings', 'Settings')}</Link> },
    { key: '3', label: <Link to="/positions">{t('nav.positions', 'Positions')}</Link> },
    { key: '4', label: <Link to="/logs">{t('nav.logs', 'Logs')}</Link> },
    { key: '5', label: <Link to="/backtest">{t('nav.backtest', 'Backtest')}</Link> },
    { key: '6', label: <Link to="/saas">{t('nav.saas', 'SaaS')}</Link> },
  ];

  const selectedMenuKey = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return '2';
    if (location.pathname.startsWith('/positions')) return '3';
    if (location.pathname.startsWith('/logs')) return '4';
    if (location.pathname.startsWith('/backtest')) return '5';
    if (location.pathname.startsWith('/saas')) return '6';
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
    if (authState === 'ok') return <Tag color="success">{t('session.active', 'Session: active')}</Tag>;
    if (authState === 'missing') return <Tag color="default">{t('session.missing', 'Session: missing')}</Tag>;
    if (authState === 'invalid') return <Tag color="error">{t('session.invalid', 'Session: invalid password')}</Tag>;
    if (authState === 'error') return <Tag color="warning">{t('session.backendUnavailable', 'Session: backend unavailable')}</Tag>;
    return <Tag color="processing">{t('session.checking', 'Session: checking')}</Tag>;
  })();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ color: 'white', paddingInline: 16 }}>
        <div className="app-header-row">
          <Typography.Text className="app-brand-title">{t('app.title', 'BattleToads Control')}</Typography.Text>
          <Menu className="app-main-menu" theme="dark" mode="horizontal" selectedKeys={[selectedMenuKey]} items={menuItems} />
          <Space className="app-account-menu" size={8}>
            <Select
              value={language}
              onChange={(value) => setLanguage(value as UILanguage)}
              size="small"
              className="app-language-select"
              options={[
                { value: 'ru', label: t('language.ru', 'Russian') },
                { value: 'en', label: t('language.en', 'English') },
                { value: 'tr', label: t('language.tr', 'Turkish') },
              ]}
            />
            {statusTag}
            <Button size="small" onClick={() => void checkAuth()} loading={authCheckLoading}>{t('action.check', 'Check')}</Button>
            {authState === 'ok' ? (
              <Button size="small" danger onClick={handleLogout}>{t('action.logout', 'Logout')}</Button>
            ) : (
              <Button size="small" type="primary" onClick={() => navigate('/login')}>{t('action.login', 'Login')}</Button>
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
          <Route path="/saas" element={<SaaS />} />
          <Route path="/saas/admin" element={<SaaS initialTab="admin" />} />
          <Route path="/saas/strategy-client" element={<SaaS initialTab="strategy-client" />} />
          <Route path="/saas/algofund" element={<SaaS initialTab="algofund" />} />
        </Routes>
      </Content>
      <FloatButton.BackTop visibilityHeight={280} />
    </Layout>
  );
}

function AppWithProviders() {
  const { language } = useI18n();

  const antdLocale = useMemo(() => {
    if (language === 'ru') return ruRU;
    if (language === 'tr') return trTR;
    return enUS;
  }, [language]);

  return (
    <ConfigProvider locale={antdLocale}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppShell />
      </Router>
    </ConfigProvider>
  );
}

function App() {
  return (
    <I18nProvider>
      <AppWithProviders />
    </I18nProvider>
  );
}

export default App;