import React from 'react';
import ReactDOM from 'react-dom/client';
import axios from 'axios';
import './index.css';
import App from './App';

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

  return config;
});

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);