import React from 'react';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import ChartComponent from '../ChartComponent';
import {
  formatStorefrontNumber,
  formatStorefrontPercent,
  LinePoint,
  metricTone,
} from './storefrontMetrics';

export type TradingSystemCardData = {
  id: string | number;
  name: string;
  displayLabel?: string;
  hint?: string;
  marketType?: string;
  ret?: number;
  dd?: number;
  pf?: number;
  trades?: number;
  sharpe?: number;
  periodDays?: number;
  membersCount?: number;
  marketCount?: number;
  maxPerMarket?: number;
};

type TradingSystemCardProps = {
  system: TradingSystemCardData;
  connected?: boolean;
  riskMultiplier?: number | null;
  chartSeries?: LinePoint[];
  onOpenDetail?: () => void;
  onConnect?: () => void;
  connectLoading?: boolean;
};

const TradingSystemCard: React.FC<TradingSystemCardProps> = ({
  system,
  connected = false,
  riskMultiplier = null,
  chartSeries = [],
  onOpenDetail,
  onConnect,
  connectLoading = false,
}) => {
  const title = system.displayLabel?.trim() || system.name;
  const hasChart = chartSeries.length > 1;
  const retTone = metricTone(Number(system.ret || 0), 'return');
  const ddTone = metricTone(Number(system.dd || 0), 'drawdown');
  const pfTone = metricTone(Number(system.pf || 0), 'pf');
  const marketTypeLabel = String(system.marketType || 'futures') === 'spot' ? 'Спот' : 'Фьючерсы';

  return (
    <article className={`storefront-card storefront-card--ts${connected ? ' storefront-card--selected' : ''}`}>
      <div className="storefront-card__head">
        <div className="storefront-card__title-row">
          <Tooltip title={system.hint || undefined} placement="topLeft">
            <Typography.Text strong className="storefront-card__title">
              {title}
            </Typography.Text>
          </Tooltip>
        </div>
        <div className="storefront-card__meta">
          <Tag className="storefront-card__pill">{marketTypeLabel}</Tag>
          {system.periodDays ? <Tag className="storefront-card__pill">{Math.round(system.periodDays)}d</Tag> : null}
          {system.membersCount ? (
            <Tag className="storefront-card__pill storefront-card__pill--accent">
              {system.membersCount} стратегий
            </Tag>
          ) : null}
          {system.marketCount ? (
            <Tag className="storefront-card__pill">
              {system.marketCount} рынков{system.maxPerMarket ? ` · max ${system.maxPerMarket}` : ''}
            </Tag>
          ) : null}
        </div>
      </div>

      <div className="storefront-card__metrics">
        <div className={`storefront-metric storefront-metric--${retTone}`}>
          <span className="storefront-metric__label">Return</span>
          <span className="storefront-metric__value">{formatStorefrontPercent(system.ret)}</span>
        </div>
        <div className={`storefront-metric storefront-metric--${ddTone}`}>
          <span className="storefront-metric__label">Max DD</span>
          <span className="storefront-metric__value">{formatStorefrontPercent(system.dd)}</span>
        </div>
        <div className={`storefront-metric storefront-metric--${pfTone}`}>
          <span className="storefront-metric__label">PF</span>
          <span className="storefront-metric__value">{formatStorefrontNumber(system.pf)}</span>
        </div>
        {system.sharpe != null ? (
          <div className="storefront-metric storefront-metric--neutral">
            <span className="storefront-metric__label">Sharpe</span>
            <span className="storefront-metric__value">{formatStorefrontNumber(system.sharpe)}</span>
          </div>
        ) : null}
      </div>

      <div className="storefront-card__chart">
        {hasChart ? (
          <ChartComponent data={chartSeries} type="line" fixedHeight={112} compact />
        ) : (
          <div className="storefront-card__chart-empty">Бэктест не загружен</div>
        )}
      </div>

      <div className="storefront-card__footer">
        <Space wrap size={6}>
          {connected ? <Tag color="success">Подключена</Tag> : null}
          {riskMultiplier != null && Number.isFinite(riskMultiplier) && riskMultiplier > 0 ? (
            <Tag color="blue">Риск {formatStorefrontNumber(riskMultiplier)}x</Tag>
          ) : null}
          {system.trades ? (
            <Tag className="storefront-card__pill">{formatStorefrontNumber(system.trades, 0)} сд.</Tag>
          ) : null}
          <Button size="small" onClick={onOpenDetail}>Подробнее</Button>
          {!connected ? (
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
        </Space>
      </div>
    </article>
  );
};

export default TradingSystemCard;
