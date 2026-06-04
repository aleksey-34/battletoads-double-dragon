#!/usr/bin/env node
/**
 * Merge missing offerIds from sweep evaluated rows into latest client catalog JSON.
 * Usage:
 *   node scripts/sync_catalog_offers_from_sweep.mjs offer_synth_stat_arb_zscore_222635 ...
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = path.join(root, 'results');
const require = createRequire(import.meta.url);
const {
  augmentCatalogWithForcedOfferIds,
  clearCatalogAndSweepCache,
} = require(path.join(root, 'backend/dist/saas/service.js'));

const offerIds = process.argv.slice(2).map((s) => String(s || '').trim()).filter(Boolean);
if (offerIds.length === 0) {
  console.error('Usage: node scripts/sync_catalog_offers_from_sweep.mjs <offerId> ...');
  process.exit(1);
}

const latestByPattern = (pattern) => {
  const files = fs.readdirSync(resultsDir)
    .filter((f) => pattern.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(resultsDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0] ? path.join(resultsDir, files[0].f) : '';
};

const sweepPath = process.env.SWEEP_JSON || latestByPattern(/_historical_sweep_.*\.json$/i);
const catalogPath = process.env.CATALOG_JSON || latestByPattern(/_client_catalog_.*\.json$/i);

if (!sweepPath || !fs.existsSync(sweepPath)) {
  console.error('Sweep JSON not found');
  process.exit(1);
}
if (!catalogPath || !fs.existsSync(catalogPath)) {
  console.error('Catalog JSON not found');
  process.exit(1);
}

const sweep = JSON.parse(fs.readFileSync(sweepPath, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const rows = Array.isArray(sweep.evaluated) ? sweep.evaluated : [];

const before = new Set([
  ...(catalog.clientCatalog?.mono || []).map((o) => o.offerId),
  ...(catalog.clientCatalog?.synth || []).map((o) => o.offerId),
]);

const next = augmentCatalogWithForcedOfferIds(catalog, rows, offerIds);
const after = new Set([
  ...(next.clientCatalog?.mono || []).map((o) => o.offerId),
  ...(next.clientCatalog?.synth || []).map((o) => o.offerId),
]);

const added = offerIds.filter((id) => !before.has(id) && after.has(id));
fs.writeFileSync(catalogPath, JSON.stringify(next, null, 2));
clearCatalogAndSweepCache();

console.log(`Catalog updated: ${catalogPath}`);
console.log(`Added ${added.length}/${offerIds.length}: ${added.join(', ')}`);
console.log(`synth=${(next.clientCatalog?.synth || []).length} mono=${(next.clientCatalog?.mono || []).length}`);
