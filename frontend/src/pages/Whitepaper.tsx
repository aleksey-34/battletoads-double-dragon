import React, { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { useI18n, UILanguage } from '../i18n';

const WP_FILES: Record<UILanguage, string> = {
  ru: '/whitepaper-ru.html',
  en: '/whitepaper.html',
  tr: '/whitepaper-tr.html',
};

const BACK_LABEL: Record<UILanguage, string> = {
  ru: '← Вернуться на главную',
  en: '← Back to Home',
  tr: '← Ana Sayfaya Dön',
};

const WhitepaperPage: React.FC = () => {
  const { language, setLanguage } = useI18n();
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(WP_FILES[language] || WP_FILES.en)
      .then(r => r.text())
      .then(t => { setHtml(t); setLoading(false); })
      .catch(() => setLoading(false));
  }, [language]);

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
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', gap: 8 }}>
          {(['ru', 'en', 'tr'] as UILanguage[]).map((lng) => (
            <button
              key={lng}
              onClick={() => setLanguage(lng)}
              style={{
                background: language === lng ? 'rgba(22,119,255,0.3)' : 'rgba(255,255,255,0.06)',
                border: language === lng ? '1px solid #4096ff' : '1px solid rgba(255,255,255,0.12)',
                color: language === lng ? '#4096ff' : '#778899',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: language === lng ? 700 : 400,
              }}
            >
              {lng.toUpperCase()}
            </button>
          ))}
        </div>
        <a href="/" style={{ color: '#4096ff', fontSize: 16 }}>{BACK_LABEL[language]}</a>
      </div>
    </div>
  );
};

export default WhitepaperPage;
