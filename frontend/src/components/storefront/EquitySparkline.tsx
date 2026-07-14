import React, { useMemo } from 'react';
import type { LinePoint } from './storefrontMetrics';

type EquitySparklineProps = {
  points: LinePoint[];
  height?: number;
  className?: string;
};

const downsample = (values: number[], maxPoints: number): number[] => {
  if (values.length <= maxPoints) {
    return values;
  }
  const out: number[] = [];
  const step = (values.length - 1) / Math.max(maxPoints - 1, 1);
  for (let i = 0; i < maxPoints; i += 1) {
    out.push(values[Math.round(i * step)]);
  }
  return out;
};

/** Lightweight SVG equity preview for storefront cards — avoids mounting lightweight-charts N times. */
const EquitySparkline: React.FC<EquitySparklineProps> = ({ points, height = 112, className }) => {
  const path = useMemo(() => {
    const values = (Array.isArray(points) ? points : [])
      .map((point) => Number(point?.value))
      .filter((value) => Number.isFinite(value));
    if (values.length < 2) {
      return null;
    }
    const series = downsample(values, 48);
    const min = Math.min(...series);
    const max = Math.max(...series);
    const span = max - min || 1;
    const width = 100;
    const padY = 4;
    const usableH = Math.max(height - padY * 2, 8);
    const coords = series.map((value, index) => {
      const x = (index / Math.max(series.length - 1, 1)) * width;
      const y = padY + (1 - (value - min) / span) * usableH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });
    return `M ${coords.join(' L ')}`;
  }, [points, height]);

  if (!path) {
    return <div className={className || 'storefront-card__chart-empty'}>Бэктест не загружен</div>;
  }

  const rising = Number(points[points.length - 1]?.value) >= Number(points[0]?.value);
  const stroke = rising ? '#3f9c6c' : '#c44c4c';

  return (
    <svg
      className={className || 'storefront-sparkline'}
      viewBox={`0 0 100 ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
      role="img"
      aria-label="Equity preview"
    >
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

export default EquitySparkline;
