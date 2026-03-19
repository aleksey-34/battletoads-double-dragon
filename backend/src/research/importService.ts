import fs from 'fs';
import path from 'path';
import { importSweepCandidates, registerSweepRun } from './profileService';

type ImportCandidatesResult = {
  sweepRunId: number;
  imported: number;
  skipped: number;
  candidates: number;
  source: {
    catalogFilePath: string;
    sweepFilePath?: string;
  };
};

const readJsonFile = (filePath: string): any => {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON: ${resolved} (${(error as Error).message})`);
  }
};

const parseMarket = (market: string): { base_symbol: string; quote_symbol?: string } => {
  const normalized = String(market || '').trim();
  if (!normalized) {
    return { base_symbol: '' };
  }
  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/');
    return {
      base_symbol: String(base || '').trim(),
      quote_symbol: String(quote || '').trim() || undefined,
    };
  }
  return { base_symbol: normalized };
};

const buildCandidatesFromCatalogJson = (catalog: any): Array<{
  name: string;
  strategy_type: string;
  market_mode: string;
  base_symbol: string;
  quote_symbol?: string;
  interval: string;
  config: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}> => {
  const offers = [
    ...(catalog?.clientCatalog?.mono || []),
    ...(catalog?.clientCatalog?.synth || []),
  ];

  const out: Array<{
    name: string;
    strategy_type: string;
    market_mode: string;
    base_symbol: string;
    quote_symbol?: string;
    interval: string;
    config: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  }> = [];

  for (const offer of offers) {
    const market = parseMarket(String(offer?.strategy?.market || ''));
    if (!market.base_symbol) {
      continue;
    }

    const strategyType = String(offer?.strategy?.type || 'DD_BattleToads');
    const marketMode = String(offer?.strategy?.mode || 'mono') === 'mono' ? 'mono' : 'synthetic';
    const params = offer?.strategy?.params || {};
    const interval = String(params?.interval || '1h');

    out.push({
      name: String(offer?.offerId || offer?.titleRu || `${market.base_symbol}-${strategyType}`),
      strategy_type: strategyType,
      market_mode: marketMode,
      base_symbol: market.base_symbol,
      quote_symbol: market.quote_symbol,
      interval,
      config: {
        name: String(offer?.strategy?.name || ''),
        strategy_type: strategyType,
        market_mode: marketMode,
        base_symbol: market.base_symbol,
        quote_symbol: market.quote_symbol,
        interval,
        ...params,
      },
      metrics: {
        ret: Number(offer?.metrics?.ret || 0),
        pf: Number(offer?.metrics?.pf || 0),
        dd: Number(offer?.metrics?.dd || 0),
        wr: Number(offer?.metrics?.wr || 0),
        trades: Number(offer?.metrics?.trades || 0),
        score: Number(offer?.metrics?.score || 0),
      },
    });
  }

  return out;
};

/**
 * Import candidates into an EXISTING sweep run from its catalog_file_path.
 * Used by the "Import" button in the Sweep Runs table (no candidates body needed).
 */
export const importCandidatesFromSweepCatalog = async (
  sweepRunId: number,
  catalogFilePath: string
): Promise<{ imported: number; skipped: number; candidates: number }> => {
  const catalog = readJsonFile(catalogFilePath);
  const candidates = buildCandidatesFromCatalogJson(catalog);
  const result = await importSweepCandidates(sweepRunId, candidates);
  return { imported: result.imported, skipped: result.skipped, candidates: candidates.length };
};

export const importHistoricalArtifactsToResearch = async (input: {
  catalogFilePath: string;
  sweepFilePath?: string;
  sweepName?: string;
  description?: string;
}): Promise<ImportCandidatesResult> => {
  const catalog = readJsonFile(input.catalogFilePath);
  const sweep = input.sweepFilePath ? readJsonFile(input.sweepFilePath) : null;

  const sweepName = String(input.sweepName || '').trim() || `manual_import_${new Date().toISOString().slice(0, 10)}`;

  const sweepRunId = await registerSweepRun({
    name: sweepName,
    description: String(input.description || '').trim() || 'Manual import from historical artifacts',
    artifactFilePath: input.sweepFilePath ? path.resolve(input.sweepFilePath) : undefined,
    catalogFilePath: path.resolve(input.catalogFilePath),
    resultSummary: {
      source: 'manual_import',
      sweepTimestamp: sweep?.timestamp || null,
      sweepCounts: sweep?.counts || null,
      catalogTimestamp: catalog?.timestamp || null,
    },
    config: {
      source: 'manual_import',
      apiKeyName: catalog?.apiKeyName || sweep?.apiKeyName || null,
    },
  });

  const candidates = buildCandidatesFromCatalogJson(catalog);
  const imported = await importSweepCandidates(sweepRunId, candidates);

  return {
    sweepRunId,
    imported: imported.imported,
    skipped: imported.skipped,
    candidates: candidates.length,
    source: {
      catalogFilePath: path.resolve(input.catalogFilePath),
      sweepFilePath: input.sweepFilePath ? path.resolve(input.sweepFilePath) : undefined,
    },
  };
};
