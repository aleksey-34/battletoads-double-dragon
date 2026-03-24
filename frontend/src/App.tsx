import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, FloatButton, Tag, Button, Space, Select, Typography, ConfigProvider } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import trTR from 'antd/locale/tr_TR';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import TradingSystems from './pages/TradingSystems';
import Positions from './pages/Positions';
import Login from './pages/Login';
import ClientAuth from './pages/ClientAuth';
import ClientCabinet from './pages/ClientCabinet';
import Logs from './pages/Logs';
import Research from './pages/Research';
import SaaS from './pages/SaaS';
import AdminDocs from './pages/AdminDocs';
import { I18nProvider, useI18n, UILanguage } from './i18n';
import './App.css';

const { Header, Content } = Layout;

type AuthState = 'checking' | 'ok' | 'missing' | 'invalid' | 'error';

const CLIENT_SESSION_STORAGE_KEY = 'clientSessionToken';

function AppShell() {
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [adminAuthState, setAdminAuthState] = useState<AuthState>('checking');
  const [clientAuthState, setClientAuthState] = useState<AuthState>('checking');
  const [authCheckLoading, setAuthCheckLoading] = useState(false);
  const isClientRoute = location.pathname.startsWith('/client') || location.pathname.startsWith('/cabinet');
  const isClientAuthRoute = location.pathname.startsWith('/client/login') || location.pathname.startsWith('/client/register');
  const isClientCabinetRoute = location.pathname.startsWith('/cabinet');
  const isClientSaasSurface = location.pathname.startsWith('/saas/strategy-client') || location.pathname.startsWith('/saas/algofund');

  const menuItems = isClientSaasSurface || isClientRoute
    ? []
    : [
        { key: '1', label: <Link to="/">{t('nav.dashboard', 'Dashboard')}</Link> },
        { key: '2', label: <Link to="/settings">{t('nav.settings', 'Settings')}</Link> },
        { key: '3', label: <Link to="/positions">{t('nav.positions', 'Positions')}</Link> },
        { key: '4', label: <Link to="/logs">{t('nav.logs', 'Logs')}</Link> },
        { key: '7', label: <Link to="/saas">{t('nav.saas', 'SaaS')}</Link> },
        { key: '8', label: <Link to="/research">{t('nav.research', 'Research')}</Link> },
        { key: '9', label: <Link to="/admin-docs">{t('nav.docs', 'Docs')}</Link> },
      ];

  const selectedMenuKey = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return '2';
    if (location.pathname.startsWith('/positions')) return '3';
    if (location.pathname.startsWith('/logs')) return '4';
    if (location.pathname.startsWith('/saas')) return '7';
    if (location.pathname.startsWith('/research')) return '8';
    if (location.pathname.startsWith('/admin-docs')) return '9';
    return '1';
  }, [location.pathname]);

  const currentSectionLabel = useMemo(() => {
    if (location.pathname.startsWith('/settings')) return t('nav.settings', 'Settings');
    if (location.pathname.startsWith('/positions')) return t('nav.positions', 'Positions');
    if (location.pathname.startsWith('/logs')) return t('nav.logs', 'Logs');
    if (location.pathname.startsWith('/trading-systems')) return t('nav.tradingSystems', 'Trading Systems');
    if (location.pathname.startsWith('/saas/admin')) return 'SaaS Admin';
    if (location.pathname.startsWith('/saas/strategy-client')) return 'SaaS Strategy';
    if (location.pathname.startsWith('/saas/algofund')) return 'SaaS Algofund';
    if (location.pathname.startsWith('/saas')) return t('nav.saas', 'SaaS');
    if (location.pathname.startsWith('/research')) return t('nav.research', 'Research');
    if (location.pathname.startsWith('/admin-docs')) return t('nav.docs', 'Docs');
    if (location.pathname.startsWith('/client/login')) return 'Client Login';
    if (location.pathname.startsWith('/client/register')) return 'Client Register';
    if (location.pathname.startsWith('/cabinet')) return 'Client Cabinet';
    if (location.pathname.startsWith('/login')) return 'Login';
    return t('nav.dashboard', 'Dashboard');
  }, [location.pathname, t]);

  useEffect(() => {
    document.title = `BT_bot_${currentSectionLabel}`;
  }, [currentSectionLabel]);

  const checkAdminAuth = async () => {
    const password = localStorage.getItem('password');

    if (!password) {
      setAdminAuthState('missing');
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
      setAdminAuthState('ok');
      if (location.pathname === '/login') {
        navigate('/');
      }
    } catch (error: any) {
      if (Number(error?.response?.status || 0) === 401) {
        setAdminAuthState('invalid');
      } else {
        setAdminAuthState('error');
      }
    } finally {
      setAuthCheckLoading(false);
    }
  };

  const checkClientAuth = async () => {
    const token = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);

    if (!token) {
      setClientAuthState('missing');
      if (isClientCabinetRoute) {
        navigate('/client/login');
      }
      return;
    }

    setAuthCheckLoading(true);
    try {
      await axios.get('/api/auth/client/me', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      setClientAuthState('ok');
      if (isClientAuthRoute) {
        navigate('/cabinet');
      }
    } catch (error: any) {
      if (Number(error?.response?.status || 0) === 401) {
        setClientAuthState('invalid');
      } else {
        setClientAuthState('error');
      }
    } finally {
      setAuthCheckLoading(false);
    }
  };

  useEffect(() => {
    if (isClientRoute) {
      void checkClientAuth();
    } else {
      void checkAdminAuth();
    }

    const syncAuth = () => {
      if (isClientRoute) {
        void checkClientAuth();
        return;
      }
      void checkAdminAuth();
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
    if (isClientRoute) {
      localStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);
      setClientAuthState('missing');
      window.dispatchEvent(new Event('auth-changed'));
      navigate('/client/login');
      return;
    }

    localStorage.removeItem('password');
    delete axios.defaults.headers.common.Authorization;
    setAdminAuthState('missing');
    window.dispatchEvent(new Event('auth-changed'));
    navigate('/login');
  };

  const effectiveAuthState = isClientRoute ? clientAuthState : adminAuthState;

  const statusTag = (() => {
    if (effectiveAuthState === 'ok') {
      return <Tag color="success">{isClientRoute ? t('client.session.active', 'Client session: active') : t('session.active', 'Session: active')}</Tag>;
    }
    if (effectiveAuthState === 'missing') {
      return <Tag color="default">{isClientRoute ? t('client.session.missing', 'Client session: missing') : t('session.missing', 'Session: missing')}</Tag>;
    }
    if (effectiveAuthState === 'invalid') {
      return <Tag color="error">{isClientRoute ? t('client.session.invalid', 'Client session: invalid') : t('session.invalid', 'Session: invalid password')}</Tag>;
    }
    if (effectiveAuthState === 'error') {
      return <Tag color="warning">{isClientRoute ? t('client.session.error', 'Client session: backend unavailable') : t('session.backendUnavailable', 'Session: backend unavailable')}</Tag>;
    }
    return <Tag color="processing">{t('session.checking', 'Session: checking')}</Tag>;
  })();

  return (
    <Layout style={{ minHeight: '100vh' }} className="app-root-layout">
      <Header style={{ color: 'white', paddingInline: 16 }}>
        <div className="app-header-row">
          <Space size={10} align="center">
            <img src="/favicon.svg" alt="BattleToads icon" style={{ width: 22, height: 22, display: 'block' }} />
            <Typography.Text className="app-brand-title">{t('app.title', 'BattleToads Control')}</Typography.Text>
          </Space>
          <Tag color="blue">Section: {currentSectionLabel}</Tag>
          {menuItems.length > 0 ? (
            <Menu className="app-main-menu" theme="dark" mode="horizontal" selectedKeys={[selectedMenuKey]} items={menuItems} />
          ) : (
            <div style={{ flex: 1 }} />
          )}
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
            <Button
              size="small"
              onClick={() => {
                if (isClientRoute) {
                  void checkClientAuth();
                } else {
                  void checkAdminAuth();
                }
              }}
              loading={authCheckLoading}
            >
              {t('action.check', 'Check')}
            </Button>
            {effectiveAuthState === 'ok' ? (
              <Button size="small" danger onClick={handleLogout}>{t('action.logout', 'Logout')}</Button>
            ) : (
              <Button
                size="small"
                type="primary"
                onClick={() => navigate(isClientRoute ? '/client/login' : '/login')}
              >
                {t('action.login', 'Login')}
              </Button>
            )}
          </Space>
        </div>
      </Header>
      <Content style={{ padding: '20px' }}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/client/login" element={<ClientAuth initialMode="login" />} />
          <Route path="/client/register" element={<ClientAuth initialMode="register" />} />
          <Route path="/cabinet" element={<ClientCabinet />} />
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/backtest" element={<Navigate to="/saas" replace />} />
          <Route path="/trading-systems" element={<Navigate to="/saas/admin?adminTab=offer-ts" replace />} />
          <Route path="/trading-systems-workbench" element={<TradingSystems />} />
          <Route path="/saas" element={<SaaS surfaceMode="admin" />} />
          <Route path="/saas/admin" element={<SaaS initialTab="admin" surfaceMode="admin" />} />
          <Route path="/saas/strategy-client" element={<SaaS initialTab="strategy-client" surfaceMode="strategy-client" />} />
          <Route path="/saas/algofund" element={<SaaS initialTab="algofund" surfaceMode="algofund" />} />
          <Route path="/research" element={<Research />} />
          <Route path="/admin-docs" element={<AdminDocs />} />
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