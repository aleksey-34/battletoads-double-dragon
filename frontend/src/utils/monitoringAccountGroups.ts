/**
 * Group flat per-API-key monitoring rows under an account (tenant) parent.
 * Parent shows summed equity / UPNL / trades; children are individual keys.
 */

export type MonitoringLeafMetrics = {
  apiKeyName: string;
  exchange: string;
  tenantLabel: string;
  tenantSlug?: string;
  equityUsd: number | null;
  unrealizedPnl: number | null;
  pnlNetUsd: number | null;
  drawdownPercent: number | null;
  recordedAt: string | null;
  trades24h: number;
  lastTradeAt: string | null;
  loadError?: string | null;
};

export type MonitoringAccountGroupRow = MonitoringLeafMetrics & {
  key: string;
  rowKind: 'account' | 'apiKey';
  accountLabel: string;
  keyCount: number;
  children?: MonitoringAccountGroupRow[];
};

const normToken = (value: string): string =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Treat "icopy1" / "icopy1-api" / "ICopy1" as the same label family. */
export const namesLookSame = (account: string, apiKey: string): boolean => {
  const a = normToken(account);
  const k = normToken(apiKey).replace(/api$/, '');
  if (!a || !k) return false;
  return a === k || a.includes(k) || k.includes(a);
};

/** Demo copy-trading fleet (admin grouping). Keys may lack tenantDisplayName. */
export const COPY_TRADING_ALIASES: Array<{ label: string; keys: string[] }> = [
  { label: 'icopy1', keys: ['icopy1-api', 'icopy1'] },
  { label: 'ARcopy1', keys: ['arcopy1', 'ARcopy1'] },
  { label: 'Acopy1', keys: ['Copy_Alex1', 'Acopy1', 'acopy1'] },
];

const copyAliasByKey = new Map<string, string>();
for (const alias of COPY_TRADING_ALIASES) {
  for (const key of alias.keys) {
    copyAliasByKey.set(normToken(key), alias.label);
  }
}

export const resolveCopyTradingLabel = (apiKeyName: string, displayName?: string): string | null => {
  const fromKey = copyAliasByKey.get(normToken(apiKeyName));
  if (fromKey) return fromKey;
  const fromName = copyAliasByKey.get(normToken(displayName || ''));
  return fromName || null;
};

export const isCopyTradingKey = (apiKeyName: string, displayName?: string): boolean => {
  return Boolean(resolveCopyTradingLabel(apiKeyName, displayName));
};

const sumNullable = (values: Array<number | null | undefined>): number | null => {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(Number(v))) continue;
    sum += Number(v);
    any = true;
  }
  return any ? sum : null;
};

const maxNullable = (values: Array<number | null | undefined>): number | null => {
  let max: number | null = null;
  for (const v of values) {
    if (v == null || !Number.isFinite(Number(v))) continue;
    max = max == null ? Number(v) : Math.max(max, Number(v));
  }
  return max;
};

const latestIso = (values: Array<string | null | undefined>): string | null => {
  let best: string | null = null;
  let bestMs = -1;
  for (const v of values) {
    const s = String(v || '').trim();
    if (!s) continue;
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) continue;
    if (ms >= bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  return best;
};

export const groupMonitoringByAccount = (
  leaves: MonitoringLeafMetrics[],
): MonitoringAccountGroupRow[] => {
  const groups = new Map<string, MonitoringLeafMetrics[]>();

  for (const leaf of leaves) {
    const copyLabel = resolveCopyTradingLabel(leaf.apiKeyName, leaf.tenantLabel);
    const slug = String(leaf.tenantSlug || '').trim();
    const label = String(leaf.tenantLabel || '').trim();
    const groupKey = copyLabel
      ? `copy:${normToken(copyLabel)}`
      : slug
        ? `slug:${slug}`
        : label && label !== 'без привязки'
          ? `label:${normToken(label)}`
          : `key:${leaf.apiKeyName}`;
    const bucket = groups.get(groupKey) || [];
    bucket.push(leaf);
    groups.set(groupKey, bucket);
  }

  const out: MonitoringAccountGroupRow[] = [];
  for (const [groupKey, members] of Array.from(groups.entries())) {
    const sorted = [...members].sort((a, b) => a.apiKeyName.localeCompare(b.apiKeyName));
    const first = sorted[0];
    const copyLabel = resolveCopyTradingLabel(first.apiKeyName, first.tenantLabel);
    const accountLabel = copyLabel
      || (String(first.tenantLabel || '').trim() && first.tenantLabel !== 'без привязки'
        ? first.tenantLabel
        : first.apiKeyName);
    const exchanges = Array.from(new Set(sorted.map((m) => m.exchange).filter(Boolean)));
    const children: MonitoringAccountGroupRow[] = sorted.map((m) => ({
      ...m,
      key: `api:${m.apiKeyName}`,
      rowKind: 'apiKey',
      accountLabel,
      keyCount: 1,
    }));

    out.push({
      key: groupKey,
      rowKind: 'account',
      accountLabel,
      apiKeyName: sorted.length === 1 ? sorted[0].apiKeyName : `${sorted.length} API`,
      exchange: exchanges.length === 1 ? exchanges[0] : 'mixed',
      tenantLabel: accountLabel,
      tenantSlug: first.tenantSlug,
      equityUsd: sumNullable(sorted.map((m) => m.equityUsd)),
      unrealizedPnl: sumNullable(sorted.map((m) => m.unrealizedPnl)),
      pnlNetUsd: sumNullable(sorted.map((m) => m.pnlNetUsd)),
      drawdownPercent: maxNullable(sorted.map((m) => m.drawdownPercent)),
      recordedAt: latestIso(sorted.map((m) => m.recordedAt)),
      trades24h: sorted.reduce((s, m) => s + Math.max(0, Number(m.trades24h) || 0), 0),
      lastTradeAt: latestIso(sorted.map((m) => m.lastTradeAt)),
      keyCount: sorted.length,
      children,
    });
  }

  return out.sort((a, b) => a.accountLabel.localeCompare(b.accountLabel, 'ru'));
};
