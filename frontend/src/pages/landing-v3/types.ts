export type LandingTradeMarker = {
  ts: number;
  price: number;
  type: 'entry' | 'exit';
  side: string;
};

export type LandingDemoTrade = {
  id: string;
  symbol: string;
  short: string;
  side: 'long' | 'short';
  pnlPct: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  interval: string;
  candles: number[][];
  markers: LandingTradeMarker[];
};

export type LandingDemoPayload = {
  generatedAt: string;
  rotateAfter?: string;
  trades: LandingDemoTrade[];
};

export type VitrineTile = {
  name: string;
  ret: string;
  meta: string;
  stroke: string;
  sparkPath: string;
};
