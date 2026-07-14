import React, { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import axios from 'axios';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Layout, Menu, FloatButton, Tag, Button, Space, Select, Typography, ConfigProvider, theme, Spin } from 'antd';
import enUS from 'antd/locale/en_US';
import ruRU from 'antd/locale/ru_RU';
import trTR from 'antd/locale/tr_TR';
import Login from './pages/Login';
import ClientAuth from './pages/ClientAuth';
import Landing from './pages/Landing';
import { I18nProvider, useI18n, UILanguage } from './i18n';
import './App.css';

// Heavy admin/client surfaces are code-split to keep the public bundle small.
const Whitepaper = lazy(() => import('./pages/Whitepaper'));
const RiskDisclaimer = lazy(() => import('./pages/RiskDisclaimer'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Settings = lazy(() => import('./pages/Settings'));
const TradingSystems = lazy(() => import('./pages/TradingSystems'));
const Positions = lazy(() => import('./pages/Positions'));
const PartnerCabinet = lazy(() => import('./pages/PartnerCabinet'));
const PartnerLogin = lazy(() => import('./pages/PartnerCabinet').then((m) => ({ default: m.PartnerLogin })));
const ClientCabinet = lazy(() => import('./pages/ClientCabinet'));
const TvAlertsCabinet = lazy(() => import('./pages/TvAlertsCabinet'));
const Logs = lazy(() => import('./pages/Logs'));
const Research = lazy(() => import('./pages/Research'));
const SaaS = lazy(() => import('./pages/SaaS'));
const AdminDocs = lazy(() => import('./pages/AdminDocs'));

const { Header, Content, Sider } = Layout;

type AuthState = 'checking' | 'ok' | 'missing' | 'invalid' | 'error';
type ColorTheme = 'anthracite' | 'classic' | 'neon' | 'fire' | 'light';

const CLIENT_SESSION_STORAGE_KEY = 'clientSessionToken';
const ADMIN_PASSWORD_STORAGE_KEY = 'password';

const isValidColorTheme = (value: string | null): value is ColorTheme => (
  value === 'anthracite' || value === 'classic' || value === 'neon' || value === 'fire' || value === 'light'
);

const resolveColorTheme = (saved: string | null): ColorTheme => {
  if (saved === 'zignaly') {
    return 'anthracite';
  }
  return isValidColorTheme(saved) ? saved : 'anthracite';
};

const isAuthStorageKey = (key: string | null): boolean => (
  key === null || key === ADMIN_PASSWORD_STORAGE_KEY || key === CLIENT_SESSION_STORAGE_KEY
);

const isAdminRouteAllowed = (state: AuthState): boolean => state === 'ok' || state === 'error';

const isClientRouteAllowed = (state: AuthState): boolean => state === 'ok' || state === 'error';
// Build marker: force fresh asset hash to bypass stale CDN cache.

function AppShell() {
  const { language, setLanguage, t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [adminAuthState, setAdminAuthState] = useState<AuthState>('checking');
  const [clientAuthState, setClientAuthState] = useState<AuthState>('checking');
  const [authCheckLoading, setAuthCheckLoading] = useState(false);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
    const saved = localStorage.getItem('btddColorTheme');
    return resolveColorTheme(saved);
  });
  const isClientRoute = location.pathname.startsWith('/client') || location.pathname.startsWith('/cabinet');
  const isTvAlertsCabinetRoute = location.pathname.startsWith('/cabinet/tv-alerts');
  const isClientAuthRoute = location.pathname.startsWith('/client/login') || location.pathname.startsWith('/client/register');
  const isClientCabinetRoute = location.pathname.startsWith('/cabinet');
  const isClientSaasSurface = false;

  useEffect(() => {
    document.body.classList.remove('theme-anthracite', 'theme-classic', 'theme-neon', 'theme-fire', 'theme-light');
    document.body.classList.add(`theme-${colorTheme}`);
    document.body.setAttribute('data-btdd-theme', colorTheme);
    document.documentElement.setAttribute('data-btdd-theme', colorTheme);
  }, [colorTheme]);

  useEffect(() => {
    (window as any).__BTDD_BUILD = '2026-04-14-light-fix-1';
  }, []);

  const handleColorThemeChange = (t: ColorTheme) => {
    setColorTheme(t);
    localStorage.setItem('btddColorTheme', t);
    window.dispatchEvent(new Event('theme-changed'));
  };

  const menuRouteByKey: Record<string, string> = {
    '1': '/dashboard',
    '2': '/settings',
    '3': '/positions',
    '4': '/logs',
    '7': '/saas',
    '8': '/research',
    '9': '/admin-docs',
  };

  const menuItems = isClientSaasSurface || isClientRoute
    ? []
    : [
        { key: '1', label: t('nav.dashboard', 'Dashboard') },
        { key: '2', label: t('nav.settings', 'Settings') },
        { key: '3', label: t('nav.positions', 'Positions') },
        { key: '4', label: t('nav.logs', 'Logs') },
        { key: '7', label: t('nav.saas', 'SaaS') },
        { key: '8', label: t('nav.research', 'Research') },
        { key: '9', label: t('nav.docs', 'Docs') },
      ];

  const handleMenuClick = ({ key }: { key: string }) => {
    const route = menuRouteByKey[key];
    if (!route || route === location.pathname) {
      return;
    }
    navigate(route);
  };

  const selectedMenuKey = useMemo(() => {
    if (location.pathname.startsWith('/dashboard')) return '1';
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
    if (location.pathname.startsWith('/saas')) return 'SaaS Admin';
    if (location.pathname.startsWith('/research')) return t('nav.research', 'Research');
    if (location.pathname.startsWith('/admin-docs')) return t('nav.docs', 'Docs');
    if (location.pathname.startsWith('/client/login')) return 'Client Login';
    if (location.pathname.startsWith('/client/register')) return 'Client Register';
    if (location.pathname.startsWith('/cabinet/tv-alerts')) return 'TradingView Alerts';
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
      await axios.get('/api/saas/admin/ping');
      setAdminAuthState('ok');
      if (location.pathname === '/login') {
        navigate('/dashboard');
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
      // Do not auto-redirect from /client/login or /client/register — user may switch account or use admin login.
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

    const onStorage = (event: StorageEvent) => {
      if (!isAuthStorageKey(event.key)) {
        return;
      }
      syncAuth();
    };

    window.addEventListener('auth-changed', syncAuth);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('auth-changed', syncAuth);
      window.removeEventListener('storage', onStorage);
    };
    // Re-check only when switching client/admin surfaces, not on every menu click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClientRoute]);

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

  const showAdminSidebar = menuItems.length > 0;

  return (
    <Layout style={{ minHeight: '100vh' }} className="app-root-layout">
      <Header style={{ color: 'white', paddingInline: 16 }}>
        <div className="app-header-row">
          <Space size={10} align="center" style={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
            <img src="/favicon.svg" alt="BattleToads icon" style={{ width: 22, height: 22, display: 'block' }} />
            <Typography.Text className="app-brand-title">{t('app.title', 'BattleToads Control')}</Typography.Text>
          </Space>
          <Tag color="blue">Section: {currentSectionLabel}</Tag>
          {!showAdminSidebar ? (
            menuItems.length > 0 ? (
              <Menu
                className="app-main-menu"
                theme="dark"
                mode="horizontal"
                selectedKeys={[selectedMenuKey]}
                items={menuItems}
                onClick={handleMenuClick}
              />
            ) : (
              <div style={{ flex: 1 }} />
            )
          ) : (
            <div style={{ flex: 1 }} />
          )}
          <Space className="app-account-menu" size={8}>
            <Select
              value={colorTheme}
              onChange={handleColorThemeChange}
              size="small"
              style={{ width: 100 }}
              options={[
                { value: 'anthracite', label: '⬛ Anthracite' },
                { value: 'classic', label: '🔵 Classic' },
                { value: 'neon', label: '🟢 Neon' },
                { value: 'fire', label: '🟠 Fire' },
                { value: 'light', label: '⚪ Light' },
              ]}
            />
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
            {(effectiveAuthState === 'ok' || effectiveAuthState === 'error') ? (
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
      <Layout className="app-shell-body">
        {showAdminSidebar ? (
          <Sider
            className="app-sidebar"
            width={220}
            breakpoint="lg"
            collapsedWidth={0}
          >
            <Menu
              className="app-sidebar-menu"
              theme="dark"
              mode="inline"
              selectedKeys={[selectedMenuKey]}
              items={menuItems}
              onClick={handleMenuClick}
            />
          </Sider>
        ) : null}
        <Content className="app-content-shell">
        <Suspense fallback={<div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spin size="large" /></div>}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/client/login" element={<ClientAuth initialMode="login" />} />
          <Route path="/client/register" element={<ClientAuth initialMode="register" />} />
          <Route path="/cabinet/tv-alerts" element={
            isClientRouteAllowed(clientAuthState) ? <TvAlertsCabinet /> :
            clientAuthState === 'checking' ? null :
            <Navigate to="/client/login" replace />
          } />
          <Route path="/cabinet" element={
            isClientRouteAllowed(clientAuthState) ? <ClientCabinet /> :
            clientAuthState === 'checking' ? null :
            <Navigate to="/client/login" replace />
          } />
          <Route path="/" element={
            adminAuthState === 'ok' ? <Navigate to="/saas" replace /> : <Navigate to="/login" replace />
          } />
          <Route path="/dashboard" element={isAdminRouteAllowed(adminAuthState) ? <Dashboard /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/settings" element={isAdminRouteAllowed(adminAuthState) ? <Settings /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/partner/login" element={<PartnerLogin />} />
          <Route path="/partner" element={<PartnerCabinet />} />
          <Route path="/positions" element={isAdminRouteAllowed(adminAuthState) ? <Positions /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/logs" element={isAdminRouteAllowed(adminAuthState) ? <Logs /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/backtest" element={<Navigate to="/saas" replace />} />
          <Route path="/trading-systems" element={<Navigate to="/saas/admin?adminTab=offer-ts" replace />} />
          <Route path="/trading-systems-workbench" element={isAdminRouteAllowed(adminAuthState) ? <TradingSystems /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/saas" element={isAdminRouteAllowed(adminAuthState) ? <SaaS surfaceMode="admin" /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/saas/admin" element={isAdminRouteAllowed(adminAuthState) ? <SaaS initialTab="admin" surfaceMode="admin" /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/saas/strategy-client" element={<Navigate to="/saas/admin?adminTab=strategy-client" replace />} />
          <Route path="/saas/algofund" element={<Navigate to="/saas/admin?adminTab=algofund" replace />} />
          <Route path="/saas/copytrading" element={<Navigate to="/saas/admin?adminTab=copytrading" replace />} />
          <Route path="/research" element={isAdminRouteAllowed(adminAuthState) ? <Research /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
          <Route path="/admin-docs" element={isAdminRouteAllowed(adminAuthState) ? <AdminDocs /> : adminAuthState === 'checking' ? null : <Navigate to="/login" replace />} />
        </Routes>
        </Suspense>
        </Content>
      </Layout>
      <FloatButton.BackTop visibilityHeight={280} />
    </Layout>
  );
}

function AppWithProviders() {
  const { language } = useI18n();
  const [currentTheme, setCurrentTheme] = useState<ColorTheme>(() => {
    const saved = localStorage.getItem('btddColorTheme');
    return resolveColorTheme(saved);
  });

  useEffect(() => {
    const sync = () => {
      const saved = localStorage.getItem('btddColorTheme');
      setCurrentTheme(resolveColorTheme(saved));
    };
    window.addEventListener('storage', sync);
    window.addEventListener('theme-changed', sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('theme-changed', sync); };
  }, []);

  const isLight = currentTheme === 'light';
  const isAnthracite = currentTheme === 'anthracite';

  const antdLocale = useMemo(() => {
    if (language === 'ru') return ruRU;
    if (language === 'tr') return trTR;
    return enUS;
  }, [language]);

  return (
    <ConfigProvider locale={antdLocale} theme={{
      algorithm: isLight ? theme.defaultAlgorithm : theme.darkAlgorithm,
      token: isLight ? {
        colorPrimary: '#6366f1',
        colorBgBase: '#f8f9fc',
        colorBgContainer: '#ffffff',
        colorBgElevated: '#f1f3f9',
        colorBorder: '#e2e5f0',
        colorText: '#0f172a',
        colorTextSecondary: '#475569',
        borderRadius: 10,
        fontFamily: "'Inter', 'Segoe UI', 'Trebuchet MS', sans-serif",
      } : isAnthracite ? {
        colorPrimary: '#f0c419',
        colorBgBase: '#0a0a0a',
        colorBgContainer: '#141414',
        colorBgElevated: '#1c1c1c',
        colorBorder: '#2a2a2a',
        colorText: '#f3f3f3',
        colorTextSecondary: '#a8a8a8',
        borderRadius: 12,
        fontFamily: "'Inter', 'Segoe UI', 'Trebuchet MS', sans-serif",
      } : {
        colorPrimary: '#f5a623',
        colorBgBase: '#0a0a12',
        colorBgContainer: '#16162a',
        colorBgElevated: '#1c1c36',
        colorBorder: '#2a2a48',
        colorText: '#e0e0f0',
        colorTextSecondary: '#8888aa',
        borderRadius: 10,
        fontFamily: "'Inter', 'Segoe UI', 'Trebuchet MS', sans-serif",
      },
    }}>
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/landing" element={<Landing />} />
          <Route path="/whitepaper" element={<Whitepaper />} />
          <Route path="/legal/risks" element={<RiskDisclaimer />} />
          <Route path="*" element={<AppShell />} />
        </Routes>
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