import React from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './index.css';
import App from './App';

const DASHBOARD_PASSWORD_STORAGE_KEY = 'password';
const CLIENT_SESSION_STORAGE_KEY = 'clientSessionToken';

const isClientApiRequest = (url: string): boolean => /\/api\/(client|auth\/client)(\/|$)/i.test(url);

const normalizeBase = (value: string): string => {
  if (!value) {
    return '/api';
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return '/api';
  }

  return trimmed.replace(/\/+$/, '');
};

const apiBase = normalizeBase(
  process.env.REACT_APP_API_BASE_URL || (process.env.NODE_ENV === 'production' ? '/api' : 'http://localhost:3001/api')
);

const LOCAL_API_PREFIX = 'http://localhost:3001/api';

axios.interceptors.request.use((config) => {
  if (!config.url) {
    return config;
  }

  const url = String(config.url);

  if (url.startsWith(LOCAL_API_PREFIX)) {
    const suffix = url.slice(LOCAL_API_PREFIX.length);
    config.url = `${apiBase}${suffix}`;
    return config;
  }

  if (url.startsWith('/api') && apiBase !== '/api') {
    config.url = `${apiBase}${url.slice('/api'.length)}`;
  }

  const normalizedUrl = String(config.url || '');
  const isClientApi = isClientApiRequest(normalizedUrl);

  (config as any).headers = (config as any).headers || {};
  const headers = (config as any).headers as any;

  if (isClientApi) {
    const clientToken = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (clientToken) {
      headers.Authorization = `Bearer ${clientToken}`;
      if (headers.authorization) {
        delete headers.authorization;
      }
    } else {
      if (headers.Authorization) {
        delete headers.Authorization;
      }
      if (headers.authorization) {
        delete headers.authorization;
      }
    }

    return config;
  }

  const password = localStorage.getItem(DASHBOARD_PASSWORD_STORAGE_KEY);
  if (password) {
    if (!headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${password}`;
    }
  }

  return config;
});

axios.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = Number(error?.response?.status || 0);
    const url = String(error?.config?.url || '');
    const isClientApi = isClientApiRequest(url);

    if (status === 401 && url.includes('/api')) {
      if (isClientApi) {
        localStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);

        const path = String(window.location.pathname || '');
        const inClientAuthScreen = path.startsWith('/client/login') || path.startsWith('/client/register');
        if (!inClientAuthScreen) {
          window.location.href = '/client/login';
        }

        return Promise.reject(error);
      }

      localStorage.removeItem(DASHBOARD_PASSWORD_STORAGE_KEY);
      delete axios.defaults.headers.common.Authorization;

      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }

    return Promise.reject(error);
  }
);

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);