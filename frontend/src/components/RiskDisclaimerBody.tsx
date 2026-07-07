import React from 'react';
import { Typography } from 'antd';
import { RiskDisclaimerContent } from '../content/riskDisclaimer';
import { useI18n } from '../i18n';

type RiskDisclaimerBodyProps = {
  content: RiskDisclaimerContent;
  compact?: boolean;
};

const RiskDisclaimerBody: React.FC<RiskDisclaimerBodyProps> = ({ content, compact = false }) => {
  const { t } = useI18n();

  return (
  <div className={`risk-disclaimer-body${compact ? ' risk-disclaimer-body--compact' : ''}`}>
    <Typography.Paragraph type="secondary" style={{ marginBottom: compact ? 12 : 16 }}>
      {content.intro}
    </Typography.Paragraph>
    <Typography.Text type="secondary" style={{ display: 'block', marginBottom: compact ? 16 : 20, fontSize: 13 }}>
      {`${t('legal.risk.updatedAt', 'Обновлено')}: ${content.updatedAt}`}
    </Typography.Text>

    {content.sections.map((section) => (
      <section key={section.title} className="risk-disclaimer-section">
        <Typography.Title level={5} style={{ marginTop: compact ? 12 : 16, marginBottom: 8 }}>
          {section.title}
        </Typography.Title>
        {section.paragraphs.map((paragraph) => (
          <Typography.Paragraph key={paragraph} style={{ marginBottom: 8 }}>
            {paragraph}
          </Typography.Paragraph>
        ))}
        {section.bullets?.length ? (
          <ul className="risk-disclaimer-list">
            {section.bullets.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
      </section>
    ))}

    <Typography.Paragraph style={{ marginTop: 16, marginBottom: 0 }} type="secondary">
      {content.closing}
    </Typography.Paragraph>
  </div>
  );
};

export default RiskDisclaimerBody;
