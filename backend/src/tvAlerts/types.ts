export type TvLotMode = 'usdt' | 'percent_deposit';

export type TvSignalConflictMode = 'wait_close' | 'accept_new' | 'close_and_open';

export type TvExitLegMode = 'percent' | 'trailing';

export type TvMaType = 'sma' | 'ema';

export type TvExitLeg = {
  id: string;
  kind: 'tp' | 'sl';
  mode: TvExitLegMode;
  /** % move from entry (TP/SL) or trail distance (trailing) */
  percent: number;
  /** % of position to close at this leg */
  closePercent: number;
  /** Ladder/grid offset from entry in % (optional) */
  priceOffsetPercent?: number;
  /** Trailing: MA length for software monitor */
  maLength?: number;
  maType?: TvMaType;
};

export type TvAlertConfig = {
  exitLegs: TvExitLeg[];
  marketType?: 'swap' | 'spot';
  closeOnOppositeSignal?: boolean;
};

export type TvAlertRow = {
  id: number;
  tenant_id: number;
  name: string;
  slug: string;
  webhook_secret: string;
  symbol: string;
  exchange: string;
  api_key_name: string;
  enabled: number | boolean;
  lot_mode: TvLotMode;
  lot_value: number;
  leverage: number;
  config_json: string;
  created_at?: string;
  updated_at?: string;
};

export type TvAlertProfileRow = {
  tenant_id: number;
  default_api_key_name: string;
  default_exchange: string;
  enabled: number | boolean;
  signal_conflict_mode: TvSignalConflictMode;
  global_settings_json: string;
};

export type TvPositionRow = {
  id: number;
  alert_id: number;
  tenant_id: number;
  api_key_name: string;
  symbol: string;
  side: 'Buy' | 'Sell';
  status: 'open' | 'closed' | 'pending';
  entry_price: number;
  qty: string;
  remaining_qty: string;
  state_json: string;
  opened_at?: string;
  closed_at?: string;
};

export type ParsedTvSignal = {
  action: 'long' | 'short' | 'close' | 'close_long' | 'close_short' | 'flat';
  symbol?: string;
  qty?: string;
  price?: number;
  raw: Record<string, unknown>;
};

export const defaultTvAlertConfig = (): TvAlertConfig => ({
  exitLegs: [],
  marketType: 'swap',
  closeOnOppositeSignal: true,
});

export const parseTvAlertConfig = (raw: unknown): TvAlertConfig => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    const exitLegs = Array.isArray((parsed as TvAlertConfig).exitLegs)
      ? (parsed as TvAlertConfig).exitLegs
      : [];
    return {
      ...defaultTvAlertConfig(),
      ...(parsed as TvAlertConfig),
      exitLegs,
    };
  } catch {
    return defaultTvAlertConfig();
  }
};
