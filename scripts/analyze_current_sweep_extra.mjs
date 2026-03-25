import fs from 'fs';

const inputPath = process.argv[2] || 'logs/diag/latest_vps_sweep.json';
const outputPath = process.argv[3] || 'logs/diag/sweep_extra_insights_2026-03-25.json';

const d = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const rows = (d.evaluated || []).map((r) => ({
  ...r,
  score: Number(r.score || 0),
  ret: Number(r.totalReturnPercent || 0),
  pf: Number(r.profitFactor || 0),
  dd: Number(r.maxDrawdownPercent || 0),
  tr: Number(r.tradesCount || 0),
}));

const robust = rows.filter((r) => Boolean(r.robust));
const selectedIds = new Set((d.selectedMembers || []).map((x) => Number(x.strategyId || 0)));
const robustNotSelected = robust.filter((r) => !selectedIds.has(Number(r.strategyId || 0)));

const countBy = (arr, key) => arr.reduce((acc, item) => {
  const k = String(item[key] || 'unknown');
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});

const topAlternativesNotSelected = [...robustNotSelected]
  .sort((a, b) => b.score - a.score)
  .slice(0, 20)
  .map((r) => ({
    id: r.strategyId,
    type: r.strategyType,
    mode: r.marketMode,
    market: r.market,
    ret: Number(r.ret.toFixed(3)),
    pf: Number(r.pf.toFixed(3)),
    dd: Number(r.dd.toFixed(3)),
    trades: r.tr,
    score: Number(r.score.toFixed(3)),
    length: r.length,
    takeProfitPercent: r.takeProfitPercent,
    detectionSource: r.detectionSource,
    interval: r.interval,
  }));

const pickDiversifiedGreedy = (pool, maxMembers = 6) => {
  const out = [];
  const usedMarkets = new Set();
  const usedTypes = new Set();
  let rest = [...pool].sort((a, b) => b.score - a.score);

  while (out.length < maxMembers && rest.length > 0) {
    rest.sort((a, b) => {
      const aValue = a.score + (usedMarkets.has(a.market) ? 0 : 4) + (usedTypes.has(a.strategyType) ? 0 : 2);
      const bValue = b.score + (usedMarkets.has(b.market) ? 0 : 4) + (usedTypes.has(b.strategyType) ? 0 : 2);
      return bValue - aValue;
    });

    const chosen = rest.shift();
    if (!chosen) {
      break;
    }

    out.push(chosen);
    usedMarkets.add(chosen.market);
    usedTypes.add(chosen.strategyType);
    rest = rest.filter((r) => Number(r.strategyId || 0) !== Number(chosen.strategyId || 0));
  }

  return out;
};

const diversifiedTsGreedy = pickDiversifiedGreedy(robust, 6).map((r) => ({
  id: r.strategyId,
  type: r.strategyType,
  mode: r.marketMode,
  market: r.market,
  ret: Number(r.ret.toFixed(3)),
  pf: Number(r.pf.toFixed(3)),
  dd: Number(r.dd.toFixed(3)),
  trades: r.tr,
  score: Number(r.score.toFixed(3)),
}));

const familyKey = (r) => [r.strategyType, r.marketMode, r.market, r.interval].join('|');
const familyMap = new Map();
for (const r of robust) {
  const key = familyKey(r);
  const next = familyMap.get(key) || [];
  next.push(r);
  familyMap.set(key, next);
}

const familyFrequencyVariability = [...familyMap.entries()]
  .map(([family, list]) => {
    const sorted = [...list].sort((a, b) => a.tr - b.tr);
    const low = sorted[0];
    const mid = sorted[Math.floor(sorted.length / 2)];
    const high = sorted[sorted.length - 1];

    return {
      family,
      count: sorted.length,
      low: {
        id: low.strategyId,
        trades: low.tr,
        ret: Number(low.ret.toFixed(3)),
        pf: Number(low.pf.toFixed(3)),
        dd: Number(low.dd.toFixed(3)),
      },
      mid: {
        id: mid.strategyId,
        trades: mid.tr,
        ret: Number(mid.ret.toFixed(3)),
        pf: Number(mid.pf.toFixed(3)),
        dd: Number(mid.dd.toFixed(3)),
      },
      high: {
        id: high.strategyId,
        trades: high.tr,
        ret: Number(high.ret.toFixed(3)),
        pf: Number(high.pf.toFixed(3)),
        dd: Number(high.dd.toFixed(3)),
      },
      deltaTrades: high.tr - low.tr,
      deltaRet: Number((high.ret - low.ret).toFixed(3)),
      deltaDd: Number((high.dd - low.dd).toFixed(3)),
    };
  })
  .filter((x) => x.count >= 3)
  .sort((a, b) => Math.abs(b.deltaTrades) - Math.abs(a.deltaTrades))
  .slice(0, 20);

const out = {
  counts: {
    evaluated: rows.length,
    robust: robust.length,
    selectedMembers: (d.selectedMembers || []).length,
  },
  byType: countBy(robust, 'strategyType'),
  byMode: countBy(robust, 'marketMode'),
  portfolioSummary: d?.portfolioResults?.[0]?.summary || null,
  topAlternativesNotSelected,
  diversifiedTsGreedy,
  familyFrequencyVariability,
};

fs.writeFileSync(outputPath, JSON.stringify(out, null, 2));

console.log(JSON.stringify({
  saved: outputPath,
  topAlternativesPreview: topAlternativesNotSelected.slice(0, 5),
  diversifiedTsGreedy,
}, null, 2));
