import type { LandingDemoTrade } from './types';

const W = 400;
const H = 200;
const PAD = { t: 14, r: 8, b: 14, l: 8 };

function nearestBarIndex(candles: number[][], ts: number): number {
  let best = 0;
  let bestDiff = Infinity;
  candles.forEach((c, i) => {
    const d = Math.abs(c[0] - ts);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  });
  return best;
}

function barAt(candles: number[][], ts: number) {
  const idx = nearestBarIndex(candles, ts);
  return { idx, bar: candles[idx] };
}

export function buildCoinChartSvg(trade: LandingDemoTrade): string {
  const candles = trade.candles || [];
  if (candles.length < 2) return '';

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const lows = candles.map((c) => c[3]);
  const highs = candles.map((c) => c[2]);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const range = Math.max(1e-9, maxP - minP);
  const xStep = plotW / Math.max(1, candles.length - 1);
  const bodyW = Math.max(1.4, Math.min(5.5, xStep * 0.62));
  const y = (p: number) => PAD.t + ((maxP - p) / range) * plotH;
  const isLong = trade.side === 'long';
  const pathCls = isLong ? 'long' : 'short';

  const defs = `<defs>
    <marker id="arrowLong" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="#4ade80"/>
    </marker>
    <marker id="arrowShort" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="#f87171"/>
    </marker>
  </defs>`;

  const grid = `<g class="chart-grid">
    <line x1="${PAD.l}" y1="${PAD.t + plotH * 0.25}" x2="${W - PAD.r}" y2="${PAD.t + plotH * 0.25}"/>
    <line x1="${PAD.l}" y1="${PAD.t + plotH * 0.5}" x2="${W - PAD.r}" y2="${PAD.t + plotH * 0.5}"/>
    <line x1="${PAD.l}" y1="${PAD.t + plotH * 0.75}" x2="${W - PAD.r}" y2="${PAD.t + plotH * 0.75}"/>
  </g>`;

  const bodies = candles.map((c, i) => {
    const [, o, h, l, cl] = c;
    const x = PAD.l + i * xStep;
    const up = cl >= o;
    const cls = up ? 'up' : 'down';
    const yO = y(o);
    const yC = y(cl);
    const yH = y(h);
    const yL = y(l);
    const top = Math.min(yO, yC);
    const hBody = Math.max(1, Math.abs(yC - yO));
    return `<line class="coin-wick ${cls}" x1="${x}" y1="${yH}" x2="${x}" y2="${yL}"/>
      <rect class="coin-body ${cls}" x="${x - bodyW / 2}" y="${top}" width="${bodyW}" height="${hBody}" rx="0.4"/>`;
  }).join('');

  const entry = trade.markers.find((m) => m.type === 'entry');
  const exit = trade.markers.find((m) => m.type === 'exit');
  let pathArrow = '';
  let markers = '';

  if (entry && exit) {
    const inBar = barAt(candles, entry.ts);
    const outBar = barAt(candles, exit.ts);
    const xIn = PAD.l + inBar.idx * xStep;
    const xOut = PAD.l + outBar.idx * xStep;
    const yIn = y(inBar.bar[4]);
    const yOut = y(outBar.bar[4]);
    const arrowId = isLong ? 'arrowLong' : 'arrowShort';
    pathArrow = `<line class="trade-path ${pathCls}" x1="${xIn}" y1="${yIn}" x2="${xOut}" y2="${yOut}" marker-end="url(#${arrowId})"/>`;
    markers = `
      <g class="coin-marker entry ${pathCls}">
        <circle cx="${xIn}" cy="${yIn}" r="9" stroke-width="2.5"/>
        <text x="${xIn}" y="${yIn + 4}" text-anchor="middle">IN</text>
      </g>
      <g class="coin-marker exit ${pathCls}">
        <circle cx="${xOut}" cy="${yOut}" r="9" stroke-width="2.5"/>
        <text x="${xOut}" y="${yOut + 4}" text-anchor="middle">OUT</text>
      </g>`;
  }

  return defs + grid + bodies + pathArrow + markers;
}
