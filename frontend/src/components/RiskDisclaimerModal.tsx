import React from 'react';
import { Modal } from 'antd';
import { useI18n } from '../i18n';
import { getRiskDisclaimerContent } from '../content/riskDisclaimer';
import RiskDisclaimerBody from './RiskDisclaimerBody';

type RiskDisclaimerModalProps = {
  open: boolean;
  onClose: () => void;
};

const RiskDisclaimerModal: React.FC<RiskDisclaimerModalProps> = ({ open, onClose }) => {
  const { language, t } = useI18n();
  const content = getRiskDisclaimerContent(language);

  return (
    <Modal
      title={content.title}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
      className="risk-disclaimer-modal"
      destroyOnClose
    >
      <RiskDisclaimerBody content={content} compact />
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <a href="/legal/risks" target="_blank" rel="noopener noreferrer">
          {t('client.auth.riskDisclaimerOpenPage', 'Открыть на отдельной странице')}
        </a>
      </div>
    </Modal>
  );
};

export default RiskDisclaimerModal;
