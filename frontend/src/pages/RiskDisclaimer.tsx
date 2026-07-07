import React from 'react';
import { useI18n, UILanguage } from '../i18n';
import { getRiskDisclaimerContent } from '../content/riskDisclaimer';
import RiskDisclaimerBody from '../components/RiskDisclaimerBody';

const BACK_LABEL: Record<UILanguage, string> = {
  ru: '← На главную',
  en: '← Back to Home',
  tr: '← Ana Sayfa',
};

const REGISTER_LABEL: Record<UILanguage, string> = {
  ru: 'Регистрация',
  en: 'Register',
  tr: 'Kayit',
};

const RiskDisclaimerPage: React.FC = () => {
  const { language, setLanguage } = useI18n();
  const content = getRiskDisclaimerContent(language);

  return (
    <div className="risk-disclaimer-page">
      <style dangerouslySetInnerHTML={{ __html: `
        .risk-disclaimer-page {
          min-height: 100vh;
          background: #0a0a12;
          color: #e6e6f0;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .risk-disclaimer-topbar {
          position: sticky; top: 0; z-index: 50;
          background: rgba(10,10,18,0.92);
          backdrop-filter: blur(10px);
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }
        .risk-disclaimer-topbar-inner {
          max-width: 860px; margin: 0 auto;
          padding: 12px 20px;
          display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
        }
        .risk-disclaimer-brand { font-weight: 800; font-size: 16px; color: #e6e6f0; text-decoration: none; }
        .risk-disclaimer-brand span { color: #f5a623; }
        .risk-disclaimer-lang { display: flex; gap: 6px; }
        .risk-disclaimer-lang button {
          min-height: 36px; min-width: 44px;
          background: rgba(255,255,255,0.04);
          border: 1px solid rgba(255,255,255,0.12);
          color: #aab; border-radius: 8px;
          padding: 6px 12px; font-size: 13px; cursor: pointer; font-weight: 600;
        }
        .risk-disclaimer-lang button.active {
          background: rgba(245,166,35,0.18);
          border-color: #f5a623; color: #f5a623;
        }
        .risk-disclaimer-main {
          max-width: 860px; margin: 0 auto;
          padding: 32px 20px 80px;
        }
        .risk-disclaimer-main h1 {
          margin: 0 0 8px;
          font-size: 32px;
          font-weight: 800;
          color: #fff;
        }
        .risk-disclaimer-actions {
          display: flex; gap: 16px; flex-wrap: wrap;
          margin-top: 28px; padding-top: 20px;
          border-top: 1px solid rgba(255,255,255,0.08);
        }
        .risk-disclaimer-actions a {
          color: #f5a623; text-decoration: none; font-size: 14px;
        }
        .risk-disclaimer-body .ant-typography { color: #d8d8ea !important; }
        .risk-disclaimer-body .ant-typography.ant-typography-secondary { color: #9a9ab8 !important; }
        .risk-disclaimer-body h5.ant-typography { color: #fff !important; }
        .risk-disclaimer-list {
          margin: 0 0 12px;
          padding-left: 22px;
          color: #d8d8ea;
          line-height: 1.65;
        }
        .risk-disclaimer-list li { margin-bottom: 6px; }
      ` }} />

      <div className="risk-disclaimer-topbar">
        <div className="risk-disclaimer-topbar-inner">
          <a href="/" className="risk-disclaimer-brand">BTDD<span>.</span></a>
          <div className="risk-disclaimer-lang" role="group" aria-label="Language">
            {(['ru', 'en', 'tr'] as UILanguage[]).map((lng) => (
              <button
                key={lng}
                type="button"
                onClick={() => setLanguage(lng)}
                className={language === lng ? 'active' : ''}
                aria-pressed={language === lng}
              >
                {lng.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="risk-disclaimer-main">
        <h1>{content.title}</h1>
        <RiskDisclaimerBody content={content} />
        <div className="risk-disclaimer-actions">
          <a href="/">{BACK_LABEL[language]}</a>
          <a href="/client/register">{REGISTER_LABEL[language]}</a>
          <a href="/whitepaper">Whitepaper</a>
        </div>
      </main>
    </div>
  );
};

export default RiskDisclaimerPage;
