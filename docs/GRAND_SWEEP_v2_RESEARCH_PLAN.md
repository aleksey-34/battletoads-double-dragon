# Grand Sweep v2 Research Plan (2026-03-26)

## Overview
Параллельный исследовательский блок для расширения фундаментальности выбора стратегий.
Запущен на максимальной нагрузке VPS одновременно с `HIGH-TRADE CURATED TS v1`.

## Four Research Contours

### Contour A: Liquidity Synthetic Pairs (90d window)
**Goal:** Найти синтетические пары с высокой корреляционной стабильностью и частой торговлей.

- **Parameters:**
  - Top 20 liquid pairs: BTC/ETH/BNB/SOL/DOGE + crosses
  - Strategy: `stat_arb_zscore`
  - Config:
    - `zscore` levels: [1.2, 1.5, 2.0]
    - `lookback`: [20, 40, 80]
  - Total runs: ~540
  - Backtest window: 90 дней

- **Success Criteria:**
  - PF ≥ 1.15
  - DD ≤ 22
  - Trades/day ≥ 1.5
  - Cointegration score ≥ 0.9

- **ETA:** ~1.5–2 hours

- **Output:** 
  - New synthetic TS candidates
  - Liquidity score rankings
  - Pair correlation matrix

---

### Contour B: HF Short Timeframe (60d window)
**Goal:** Валидация high-frequency стратегий на 15m и 30m с короче горизонтом.

- **Parameters:**
  - Top 30 monosymbol pairs
  - Strategies: DD_BattleToads, zz_breakout
  - Timeframes: [15m, 30m]
  - Backtest window: 60 дней
  - Total runs: ~360
  - Config:
    - Initial balance: 10k
    - Slippage: 0.05%
    - Commission: 0.04%

- **Success Criteria:**
  - PF ≥ 1.05 (softer than usual for HF)
  - DD ≤ 25
  - Win rate ≥ 50%
  - Stability across 4 quarterly windows (min 3/4 profitable)

- **ETA:** ~2–3 hours

- **Output:**
  - HF monosymbol universe ranked
  - 15m vs 30m performance compare
  - Daily P&L distributions

---

### Contour C: Regime Robustness Rescore (existing 3100 candidates)
**Goal:** Переранжировать существующий пул по режимной устойчивости без новых прогонов.

- **Method:**
  - Load sweep 2026-03-20 candidates (3099 robust)
  - Segment period: Jan(bull)–Mar, Apr–Jul(chop), Aug–Sep(crunch)
  - Compute `regime_score = weighted PF per segment`
  - Weights: equal or by volatility

- **Success Criteria:**
  - Top-30 by regime_score
  - Minimum 2/3 regimes with PF > 1.0

- **ETA:** ~5–15 minutes (pure analytics)

- **Output:**
  - Top-30 regime-robust TS members
  - Regime sensitivity heatmap
  - Draft TS v2 (updated members)

---

### Contour D: Multi-TF Correlation Check (top 100)
**Goal:** Anti-duplication filter для finalists.

- **Method:**
  - Top-100 candidates by PF/trades
  - Compute pairwise equity curve correlation (ρ)
  - Group by (ρ > 0.75) → cluster
  - Per cluster keep best-diversified member

- **Success Criteria:**
  - Output: ~35–50 non-redundant finalists
  - Within-cluster ρ < 0.75 enforced

- **ETA:** ~5–10 minutes

- **Output:**
  - Correlation matrix heatmap
  - Finalists with diversity scores
  - Redundancy report

---

## Parallel Execution Timeline

| Time | Contour A | Contour B | Contour C | Contour D |
|------|-----------|-----------|-----------|-----------|
| T+0s | START | START | — | — |
| T+30m | Checkpoint (270 runs) | Checkpoint (180 runs) | START | — |
| T+1h | Checkpoint (540 done) | Checkpoint (360 done) | Done (3–5m) | START |
| T+1.5h | DONE | Running | Done | Checkpoint |
| T+2h | Results aggregating | DONE | — | DONE |
| T+2.5h | **FINAL A** | Results | — | **FINAL D** |
| T+3h | — | **FINAL B** | — | — |
| T+3.5h | **Analysis & catalog merge** | — | — | — |

**Total optimistic:** 2–3 hours  
**Total realistic:** 3–4 hours  
**Total with margin:** 4–6 hours

---

## Integration Points

### Into Existing Catalog
1. New synthetic recommendations → `clientCatalog.synth`
2. HF monosymbols → `clientCatalog.mono` (15m/30m subset)
3. Regime-robust members → override `adminTradingSystemDraft.members`
4. Non-redundant finalists → final shortlist for next cycle

### New Tagged Source Labels
- `legacy` — from previous sweeps
- `grand_sweep_liquidity_synth` — Contour A results
- `grand_sweep_hf_shortwindow` — Contour B results
- `grand_sweep_regime_rescore` — Contour C results
- `curated_high_trade` — `HIGH-TRADE CURATED TS v1`

### New Result Artifacts
- `btdd_d1_grand_sweep_contour_a_*.json`
- `btdd_d1_grand_sweep_contour_b_*.json`
- `btdd_d1_grand_sweep_regime_rescore_*.json`
- `btdd_d1_grand_sweep_finalists_correlation_*.json`

---

## Risk Checks (Before Deployment to Clients)
- [ ] Portfolio diversification: ≤5 markets in core
- [ ] Pair overlap: No >2 strategies on same pair
- [ ] Margin load: Combined DD < 25% under risk-multiplier 1x
- [ ] Slippage validation: Synthetic spreads < 0.1% (cointegration)
- [ ] Execution QA: Daily backtest vs runtime live equity diff < 5%

---

## Contingencies
- If Contour A/B takes > 4h: Kill and restart with reduced parameter space
- If Contour C/D fails: Fallback to existing regime-scoring
- If catalog merge conflicts: Manual review of top-20 candidates

---

## Next Steps After Grand Sweep Completes
1. Snapshot latest catalog with new tagged sources
2. A/B test: `HIGH-TRADE v1` vs `grand-sweep v1 recommendations`
3. Client migration strategy (gradual or batch)
4. Continuous grand-sweep cycle (weekly or bi-weekly)
