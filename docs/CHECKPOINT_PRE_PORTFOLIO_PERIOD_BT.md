# Checkpoint: pre portfolio-period BT (2026-08-05)

**Tag:** `checkpoint/pre-portfolio-period-bt-20260805`  
**Branch:** `restore/pre-portfolio-period-bt`  
**Commit:** `d8e282a` (fix WEEX min-qty retry) — same as `origin/main` at checkpoint time.

## Restore

```bash
git fetch origin --tags
git switch -C main origin/main   # optional: sync remote view first
git reset --hard checkpoint/pre-portfolio-period-bt-20260805
# VPS after reset+push:
# sudo -u ubuntu git -C /opt/battletoads-double-dragon fetch origin --tags
# sudo ALLOW_DIRTY_TRACKED=1 DEPLOY_MODE=multi bash /opt/battletoads-double-dragon/scripts/update_vps_from_git.sh
```

Safer (no force on main): work on `restore/pre-portfolio-period-bt` and merge/cherry-pick only what you need.

## Scope of later work (after this checkpoint)

- Admin: recalculate portfolio/TS BT for arbitrary `dateFrom`/`dateTo`
- Candle coverage preflight (`POST /api/saas/admin/portfolio-bt/coverage`)
- Hybrid export for portfolio book intervals (`scripts/hybrid/export_portfolio_books_candles.sh`)
- Stamp results onto offer + TS storefront snapshots (existing «Сохранить»)

Does **not** change live `executeStrategy` / emergency halt.

## How to recalculate a period (after feature lands)

1. Export hybrid (optional but recommended):  
   `HYBRID_CANDLE_DIR=... bash scripts/hybrid/export_portfolio_books_candles.sh`
2. Admin → TS/portfolio card → set `dateFrom`/`dateTo` → **Проверить свечи** → **Real BT за период** → **Сохранить**.
3. Offers stay on strategy vitrine via review snapshots; TS via `ts_backtest_snapshots`.
