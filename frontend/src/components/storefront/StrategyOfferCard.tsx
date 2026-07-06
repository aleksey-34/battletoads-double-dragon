import React from 'react';
import { Button, Checkbox, Space, Tag, Tooltip, Typography } from 'antd';
import ChartComponent from '../ChartComponent';
import {
  formatStorefrontNumber,
  formatStorefrontPercent,
  LinePoint,
  metricTone,
} from './storefrontMetrics';

export type StrategyOfferCardData = {
  id: string;
  title: string;
  description?: string;
  market: string;
  mode: string;
  interval?: string;
  marketType?: string;
  ret?: number;
  dd?: number;
  pf?: number;
  trades?: number;
};

type StrategyOfferCardProps = {
  offer: StrategyOfferCardData;
  selected?: boolean;
  portfolioMode?: boolean;
  chartSeries?: LinePoint[];
  onToggleSelect?: (checked: boolean) => void;
  onOpenDetail?: () => void;
  onConnect?: () => void;
};

const StrategyOfferCard: React.FC<StrategyOfferCardProps> = ({
  offer,
  selected = false,
  portfolioMode = false,
  chartSeries = [],
  onToggleSelect,
  onOpenDetail,
  onConnect,
}) => {
  const hasChart = chartSeries.length > 1;
  const retTone = metricTone(Number(offer.ret || 0), 'return');
  const ddTone = metricTone(Number(offer.dd || 0), 'drawdown');
  const pfTone = metricTone(Number(offer.pf || 0), 'pf');
  const marketTypeLabel = String(offer.marketType || 'futures') === 'spot' ? 'Спот' : 'Фьючерсы';

  return (
    <article className={`storefront-card${selected ? ' storefront-card--selected' : ''}`}>
      <div className="storefront-card__head">
        <div className="storefront-card__title-row">
          {portfolioMode ? (
            <Checkbox
              checked={selected}
              onChange={(event) => {
                event.stopPropagation();
                onToggleSelect?.(event.target.checked);
              }}
            />
          ) : null}
          <Tooltip title={offer.description || undefined} placement="topLeft">
            <Typography.Text strong className="storefront-card__title">
              {offer.title}
            </Typography.Text>
          </Tooltip>
        </div>
        <div className="storefront-card__meta">
          <Tag className="storefront-card__pill">{marketTypeLabel}</Tag>
          <Tag className="storefront-card__pill">{offer.mode.toUpperCase()}</Tag>
          <Tag className="storefront-card__pill">{offer.market}</Tag>
          {offer.interval ? <Tag className="storefront-card__pill">{offer.interval}</Tag> : null}
        </div>
      </div>

      <div className="storefront-card__metrics">
        <div className={`storefront-metric storefront-metric--${retTone}`}>
          <span className="storefront-metric__label">Return</span>
          <span className="storefront-metric__value">{formatStorefrontPercent(offer.ret)}</span>
        </div>
        <div className={`storefront-metric storefront-metric--${ddTone}`}>
          <span className="storefront-metric__label">Max DD</span>
          <span className="storefront-metric__value">{formatStorefrontPercent(offer.dd)}</span>
        </div>
        <div className={`storefront-metric storefront-metric--${pfTone}`}>
          <span className="storefront-metric__label">PF</span>
          <span className="storefront-metric__value">{formatStorefrontNumber(offer.pf)}</span>
        </div>
        {offer.trades ? (
          <div className="storefront-metric storefront-metric--neutral">
            <span className="storefront-metric__label">Trades</span>
            <span className="storefront-metric__value">{formatStorefrontNumber(offer.trades, 0)}</span>
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
          {selected ? <Tag color="gold">В портфеле</Tag> : null}
          <Button size="small" onClick={onOpenDetail}>Подробнее</Button>
          {portfolioMode && !selected ? (
            <Button size="small" type="primary" className="storefront-card__cta" onClick={onConnect}>
              Подключить
            </Button>
          ) : null}
        </Space>
      </div>
    </article>
  );
};

export default StrategyOfferCard;
