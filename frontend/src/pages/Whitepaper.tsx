import React, { useEffect, useState } from 'react';
import { Spin } from 'antd';
import { useI18n, UILanguage } from '../i18n';

const WP_FILES: Record<UILanguage, string> = {
  ru: '/whitepaper-ru.html',
  en: '/whitepaper.html',
  tr: '/whitepaper-tr.html',
};

const BACK_LABEL: Record<UILanguage, string> = {
  ru: '← На главную',
  en: '← Back to Home',
  tr: '← Ana Sayfa',
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

  return (
    <div style={{
      minHeight: '100vh',
      background: '#0a0a12',
      color: '#e6e6f0',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    }}>
      <style dangerouslySetInnerHTML={{ __html: `
        html, body { overflow-x: hidden; }
        .wp-topbar {
          position: sticky; top: 0; z-index: 50;
          background: rgba(10,10,18,0.92);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .wp-topbar-inner {
          max-width: 1080px; margin: 0 auto;
          padding: 12px 20px;
          display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
        }
        .wp-brand { font-weight: 800; font-size: 16px; letter-spacing: -0.3px; color: #e6e6f0; text-decoration: none; }
        .wp-brand span { color: #4096ff; }
        .wp-lang { display: flex; gap: 6px; }
        .wp-lang button {
          min-height: 36px; min-width: 44px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.12);
          color: #aab; border-radius: 8px;
          padding: 6px 12px; font-size: 13px; cursor: pointer; font-weight: 600;
          transition: all .15s;
        }
        .wp-lang button:hover { color: #e6e6f0; border-color: rgba(255,255,255,0.25); }
        .wp-lang button.active {
          background: rgba(64,150,255,0.18);
          border-color: #4096ff; color: #4096ff;
        }
        .wp-back { color: #aab; font-size: 13px; text-decoration: none; }
        .wp-back:hover { color: #4096ff; }

        .docs-markdown-body {
          max-width: 860px; margin: 0 auto;
          padding: 32px 20px 80px;
          font-size: 16px; line-height: 1.7;
        }
        .docs-markdown-body h1 {
          font-size: 32px; font-weight: 800; margin: 0 0 8px;
          letter-spacing: -0.5px; color: #fff;
        }
        .docs-markdown-body h2 {
          font-size: 24px; font-weight: 700; margin: 48px 0 16px;
          padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.08);
          color: #fff;
        }
        .docs-markdown-body h3 {
          font-size: 19px; font-weight: 700; margin: 32px 0 12px; color: #fff;
        }
        .docs-markdown-body h4 {
          font-size: 16px; font-weight: 700; margin: 20px 0 8px; color: #e6e6f0;
        }
        .docs-markdown-body p { margin: 0 0 14px; }
        .docs-markdown-body ul, .docs-markdown-body ol { padding-left: 22px; margin: 0 0 16px; }
        .docs-markdown-body li { margin-bottom: 6px; }
        .docs-markdown-body a { color: #4096ff; text-decoration: none; }
        .docs-markdown-body a:hover { text-decoration: underline; }
        .docs-markdown-body strong { color: #fff; font-weight: 700; }
        .docs-markdown-body hr {
          border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 36px 0;
        }
        .docs-markdown-body code {
          background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 4px; padding: 1px 6px; font-size: 13px;
          font-family: 'JetBrains Mono', Menlo, Consolas, monospace;
        }
        .docs-markdown-body pre {
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px; padding: 16px; overflow-x: auto;
          font-size: 13px; line-height: 1.5;
        }
        .docs-markdown-body pre code { background: none; border: 0; padding: 0; }

        .docs-markdown-body table {
          display: block; overflow-x: auto; max-width: 100%;
          border-collapse: collapse; margin: 16px 0;
          font-size: 14px;
        }
        .docs-markdown-body thead { background: rgba(64,150,255,0.08); }
        .docs-markdown-body th, .docs-markdown-body td {
          padding: 10px 14px; border: 1px solid rgba(255,255,255,0.08);
          text-align: left; vertical-align: top;
        }
        .docs-markdown-body th { font-weight: 700; color: #fff; }
        .docs-markdown-body tbody tr:nth-child(even) { background: rgba(255,255,255,0.02); }

        /* Architecture diagram */
        .arch-diagram {
          margin: 18px 0 24px;
          padding: 20px;
          border: 1px solid rgba(64,150,255,0.25);
          border-radius: 14px;
          background: linear-gradient(180deg, rgba(64,150,255,0.04) 0%, rgba(255,255,255,0.02) 100%);
        }
        .arch-title {
          text-align: center; font-weight: 800; color: #4096ff;
          letter-spacing: 1px; font-size: 13px; text-transform: uppercase;
          margin-bottom: 18px;
        }
        .arch-row { display: grid; gap: 12px; }
        .arch-row-3 { grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
        .arch-card {
          background: rgba(10,10,20,0.6);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px;
          padding: 14px 16px;
        }
        .arch-card h4 { margin: 0 0 8px; font-size: 14px; color: #fff; font-weight: 700; }
        .arch-db {
          display: inline-block; font-family: 'JetBrains Mono', Menlo, monospace;
          background: rgba(64,150,255,0.12); color: #4096ff;
          border: 1px solid rgba(64,150,255,0.3);
          border-radius: 5px; padding: 2px 8px; font-size: 12px; margin-bottom: 10px;
        }
        .arch-card ul {
          margin: 0; padding-left: 18px; font-size: 13px; color: #c8c8d8; line-height: 1.7;
        }
        .arch-card ul li { margin: 0; }
        .arch-api {
          margin-top: 14px; text-align: center;
          background: rgba(10,10,20,0.6);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 10px; padding: 12px 16px;
        }
        .arch-api h4 { margin: 0 0 6px; font-size: 14px; color: #fff; font-weight: 700; }
        .arch-api code {
          background: none; border: 0; padding: 0;
          font-size: 12px; color: #4096ff; font-family: 'JetBrains Mono', Menlo, monospace;
        }

        @media (max-width: 600px) {
          .docs-markdown-body { font-size: 15px; padding: 20px 14px 60px; }
          .docs-markdown-body h1 { font-size: 26px; }
          .docs-markdown-body h2 { font-size: 21px; margin-top: 36px; }
          .docs-markdown-body h3 { font-size: 17px; }
          .wp-topbar-inner { padding: 10px 14px; }
          .wp-brand { font-size: 15px; }
          .wp-lang button { padding: 6px 10px; font-size: 12px; min-width: 40px; }
        }
      ` }} />

      <div className="wp-topbar">
        <div className="wp-topbar-inner">
          <a href="/" className="wp-brand">BTDD<span>.</span></a>
          <div className="wp-lang" role="group" aria-label="Language">
            {(['ru', 'en', 'tr'] as UILanguage[]).map((lng) => (
              <button
                key={lng}
                onClick={() => setLanguage(lng)}
                className={language === lng ? 'active' : ''}
                aria-pressed={language === lng}
              >
                {lng.toUpperCase()}
              </button>
            ))}
          </div>
          <a href="/" className="wp-back">{BACK_LABEL[language]}</a>
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
      ) : (
        <div
          className="docs-markdown-body"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      <div style={{ textAlign: 'center', paddingBottom: 40 }}>
        <a href="/" style={{ color: '#4096ff', fontSize: 16, textDecoration: 'none' }}>{BACK_LABEL[language]}</a>
      </div>
    </div>
  );
};

export default WhitepaperPage;
