import React, { useMemo, useState } from 'react';
import { Button, Modal, Space, Table, Tag, Typography } from 'antd';
import EquitySparkline from './EquitySparkline';
import {
  formatStorefrontNumber,
  formatStorefrontPercent,
  LinePoint,
  metricTone,
  syntheticEquitySeriesFromMetrics,
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

export type ConnectedClientBadge = {
  label: string;
  active?: boolean;
};

type Props = {
  portfolio: PortfolioCardData;
  connected?: boolean;
  chartSeries?: LinePoint[];
  /** Count only — full client list lives in the connect modal (same as TS cards). */
  clientCount?: number;
  activeCount?: number;
  extraBadges?: React.ReactNode;
  bodyExtra?: React.ReactNode;
  footerExtra?: React.ReactNode;
  onOpenDetail?: () => void;
  /** Client cabinet: connect current user to this portfolio. */
  onConnect?: () => void;
  /** Admin vitrine: open multi-client connect/disconnect modal. */
  onConnectClients?: () => void;
  connectLoading?: boolean;
};

const PortfolioCard: React.FC<Props> = ({
  portfolio,
  connected = false,
  chartSeries = [],
  clientCount = 0,
  activeCount = 0,
  extraBadges = null,
  bodyExtra = null,
  footerExtra = null,
  onOpenDetail,
  onConnect,
  onConnectClients,
  connectLoading = false,
}) => {
  const [open, setOpen] = useState(false);
  const retTone = metricTone(Number(portfolio.ret || 0), 'return');
  const ddTone = metricTone(Number(portfolio.dd || 0), 'drawdown');
  const hasMetrics = Number.isFinite(Number(portfolio.ret)) || Number.isFinite(Number(portfolio.dd));
  const resolvedSeries = useMemo(() => {
    if (Array.isArray(chartSeries) && chartSeries.length > 1) return chartSeries;
    if (!hasMetrics) return [] as LinePoint[];
    return syntheticEquitySeriesFromMetrics({
      capital: portfolio.capital,
      ret: portfolio.ret,
      dd: portfolio.dd,
      periodDays: 850,
      points: 64,
    });
  }, [chartSeries, hasMetrics, portfolio.capital, portfolio.ret, portfolio.dd]);
  const hasChart = resolvedSeries.length > 1;
  const chartIsSynthetic = hasChart && !(Array.isArray(chartSeries) && chartSeries.length > 1);
  const members = useMemo(() => portfolio.members || [], [portfolio.members]);
  const clients = Math.max(0, Number(clientCount || 0));
  const actives = Math.max(0, Number(activeCount || 0));

  return (
    <>
      <article className={`storefront-card storefront-card--portfolio${connected ? ' storefront-card--selected' : ''}`}>
        <div className="storefront-card__head">
          <div className="storefront-card__title-row">
            <Typography.Text strong className="storefront-card__title">
              {portfolio.displayLabel}
            </Typography.Text>
          </div>
          <div className="storefront-card__meta">
            <Tag className="storefront-card__pill storefront-card__pill--portfolio">Портфель</Tag>
            {portfolio.isPersonal ? <Tag className="storefront-card__pill">personal</Tag> : null}
            {portfolio.memberCount ? (
              <Tag className="storefront-card__pill">{portfolio.memberCount} книг TS</Tag>
            ) : null}
            <Tag color={clients > 0 ? 'cyan' : 'default'}>clients {clients}</Tag>
            <Tag color={actives > 0 ? 'green' : 'default'}>active {actives}</Tag>
            {extraBadges}
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

        <div className="storefront-card__chart">
          {hasChart ? (
            <>
              <EquitySparkline points={resolvedSeries} height={112} />
              {chartIsSynthetic ? (
                <div className="storefront-card__chart-note" style={{ fontSize: 10, opacity: 0.55, marginTop: 2 }}>
                  кривая approx по Ret/DD
                </div>
              ) : null}
            </>
          ) : (
            <div className="storefront-card__chart-empty">
              {hasMetrics ? 'Кривая BT не сохранена' : 'Бэктест не загружен'}
            </div>
          )}
        </div>

        {bodyExtra}

        <div className="storefront-card__footer">
          <Space wrap size={6} direction="vertical" style={{ width: '100%' }}>
            <Space wrap size={6}>
              {connected ? <Tag color="success">Подключён</Tag> : null}
              <Button size="small" onClick={() => setOpen(true)}>Состав</Button>
              {onOpenDetail ? (
                <Button size="small" onClick={onOpenDetail}>Бэктест</Button>
              ) : null}
              {onConnectClients ? (
                <Button
                  size="small"
                  type="primary"
                  className="storefront-card__cta"
                  loading={connectLoading}
                  onClick={onConnectClients}
                >
                  Подключить клиентов
                </Button>
              ) : null}
              {!onConnectClients && onConnect && !connected ? (
                <Button
                  size="small"
                  type="primary"
                  className="storefront-card__cta"
                  loading={connectLoading}
                  onClick={onConnect}
                >
                  Подключить
                </Button>
              ) : null}
              {!onConnectClients && onConnect && connected ? (
                <Tag color="success">Подключено</Tag>
              ) : null}
            </Space>
            {footerExtra}
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
            <Typography.Text strong>
              Total equity (BT){chartIsSynthetic ? ' · approx' : ''}
            </Typography.Text>
            <div style={{ marginTop: 8 }}>
              <EquitySparkline points={resolvedSeries} height={120} />
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
