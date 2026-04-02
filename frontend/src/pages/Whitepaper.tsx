import React, { useEffect, useState } from 'react';
import { Spin } from 'antd';

const WhitepaperPage: React.FC = () => {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/whitepaper.html')
      .then(r => r.text())
      .then(t => { setHtml(t); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a12',
      color: '#e0e0f0',
      padding: '40px 16px',
    }}>
      <div
        className="docs-markdown-body"
        style={{ maxWidth: 860, margin: '0 auto' }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <div style={{ textAlign: 'center', marginTop: 40, paddingBottom: 40 }}>
        <a href="/" style={{ color: '#4096ff', fontSize: 16 }}>← Вернуться на главную</a>
      </div>
    </div>
  );
};

export default WhitepaperPage;
