import React, { useMemo, useState } from 'react';
import { Button, Modal, Space, Table, Tag, Typography } from 'antd';
import EquitySparkline from './EquitySparkline';
import {
  formatStorefrontNumber,
  formatStorefrontPercent,
  LinePoint,
  metricTone,
} from './storefrontMetrics';

export type PortfolioMemberView = {
  role: string;
  systemName: string;
  weight?: number;
  op?: number;
  lot?: number;
};

export type PortfolioCardData = {
  id: number | string;
  setKey: string;
  displayLabel: string;
  description?: string;
  isPersonal?: boolean;
  memberCount?: number;
  ret?: number;
  dd?: number;
  capital?: number;
  members?: PortfolioMemberView[];
  equityPoints?: number[];
};

type Props = {
  portfolio: PortfolioCardData;
  connected?: boolean;
  chartSeries?: LinePoint[];
  onConnect?: () => void;
  connectLoading?: boolean;
};

const PortfolioCard: React.FC<Props> = ({
  portfolio,
  connected = false,
  chartSeries = [],
  onConnect,
  connectLoading = false,
}) => {
  const [open, setOpen] = useState(false);
  const retTone = metricTone(Number(portfolio.ret || 0), 'return');
  const ddTone = metricTone(Number(portfolio.dd || 0), 'drawdown');
  const hasChart = chartSeries.length > 1;
  const members = useMemo(() => portfolio.members || [], [portfolio.members]);

  return (
    <>
      <article className={`storefront-card storefront-card--ts${connected ? ' storefront-card--selected' : ''}`}>
        <div className="storefront-card__head">
          <div className="storefront-card__title-row">
            <Typography.Text strong className="storefront-card__title">
              {portfolio.displayLabel}
            </Typography.Text>
          </div>
          <div className="storefront-card__meta">
            <Tag className="storefront-card__pill storefront-card__pill--accent">Портфель</Tag>
            {portfolio.isPersonal ? <Tag className="storefront-card__pill">personal</Tag> : null}
            {portfolio.memberCount ? (
              <Tag className="storefront-card__pill">{portfolio.memberCount} TS</Tag>
            ) : null}
          </div>
        </div>

        <div className="storefront-card__metrics">
          <div className={`storefront-metric storefront-metric--${retTone}`}>
            <span className="storefront-metric__label">Return</span>
            <span className="storefront-metric__value">{formatStorefrontPercent(portfolio.ret)}</span>
          </div>
          <div className={`storefront-metric storefront-metric--${ddTone}`}>
            <span className="storefront-metric__label">Max DD</span>
            <span className="storefront-metric__value">{formatStorefrontPercent(portfolio.dd)}</span>
          </div>
          <div className="storefront-metric">
            <span className="storefront-metric__label">Cap BT</span>
            <span className="storefront-metric__value">
              {portfolio.capital != null ? `$${formatStorefrontNumber(portfolio.capital / 1000)}k` : '—'}
            </span>
          </div>
        </div>

        {hasChart ? (
          <div className="storefront-card__chart">
            <EquitySparkline points={chartSeries} />
          </div>
        ) : null}

        <div className="storefront-card__footer">
          <Space wrap>
            <Button size="small" onClick={() => setOpen(true)}>Состав</Button>
            {onConnect ? (
              <Button size="small" type="primary" loading={connectLoading} onClick={onConnect}>
                {connected ? 'Подключено' : 'Подключить'}
              </Button>
            ) : null}
          </Space>
        </div>
      </article>

      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={portfolio.displayLabel}
        width={720}
      >
        <Typography.Paragraph type="secondary">
          Портфель = несколько независимых TS (свой OP/lot у каждого). Margin общий на ключе.
        </Typography.Paragraph>
        <Table
          size="small"
          pagination={false}
          rowKey={(r) => `${r.role}-${r.systemName}`}
          dataSource={members}
          columns={[
            { title: 'Роль', dataIndex: 'role', width: 80 },
            { title: 'Trading system', dataIndex: 'systemName', ellipsis: true },
            {
              title: 'Weight',
              dataIndex: 'weight',
              width: 80,
              render: (v) => (v != null ? Number(v).toFixed(2) : '—'),
            },
            {
              title: 'OP',
              dataIndex: 'op',
              width: 60,
              render: (v) => (v != null ? v : '—'),
            },
            {
              title: 'Lot%',
              dataIndex: 'lot',
              width: 70,
              render: (v) => (v != null ? v : '—'),
            },
          ]}
        />
        {hasChart ? (
          <div style={{ marginTop: 16 }}>
            <Typography.Text strong>Total equity (BT)</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <EquitySparkline points={chartSeries} height={120} />
            </div>
          </div>
        ) : null}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          Return {formatStorefrontPercent(portfolio.ret)} · Max DD {formatStorefrontPercent(portfolio.dd)}
          {portfolio.description ? ` · ${portfolio.description}` : ''}
        </Typography.Paragraph>
      </Modal>
    </>
  );
};

export default PortfolioCard;
