/**
 * Closed-bar auto-cycle watermark. RAM map is fast; DB persist (see persistProcessedClosedBar)
 * makes it survive runtime restart so the same wick bar cannot re-enter.
 */
export const processedClosedBarByStrategy = new Map<string, number>();

export const closedBarDedupeKey = (apiKeyName: string, strategyId: number): string =>
  `${apiKeyName}:${strategyId}`;

export const clearProcessedClosedBarMemory = (): void => {
  processedClosedBarByStrategy.clear();
};

/** Seed RAM from DB so a runtime restart does not re-fire the same closed bar. */
export const hydrateProcessedClosedBarMemory = (key: string, persistedMs: number): void => {
  const n = Number(persistedMs) || 0;
  if (n <= 0 || !key) return;
  const cur = Number(processedClosedBarByStrategy.get(key) || 0);
  if (n > cur) processedClosedBarByStrategy.set(key, n);
};

export const rememberProcessedClosedBar = (key: string, barTimeMs: number): void => {
  const n = Number(barTimeMs) || 0;
  if (n <= 0 || !key) return;
  const cur = Number(processedClosedBarByStrategy.get(key) || 0);
  if (n >= cur) processedClosedBarByStrategy.set(key, n);
};

export const isClosedBarAlreadyProcessed = (key: string, barTimeMs: number): boolean => {
  const n = Number(barTimeMs) || 0;
  if (n <= 0 || !key) return false;
  return Number(processedClosedBarByStrategy.get(key) || 0) === n;
};
