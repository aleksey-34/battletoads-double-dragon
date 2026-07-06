# Архитектурная оптимизация BTDD — ход работ

**Ветка:** `main` (merge 2026-07-06)  
**Старт:** 2026-07-06  
**Связанные доки:** `architecture-refactor-plan.md`, `INFRASTRUCTURE_PLAN.md`, `RUNTIME_ARCHITECTURE.md`

---

## Цели (по приоритету)

| # | Задача | Статус | Риск |
|---|--------|--------|------|
| A | Распил `strategy.ts` → модули + фасад | 🔄 execution (~2050) | низкий |
| B | Распил `routes.ts` → sub-routers | ✅ client/backtest/admin | низкий |
| C | Client backtest → async queue (`preview_jobs`) | ✅ | средний |
| D | Presets вместо live `runBacktest` в SaaS client preview | ✅ default strict | средний |

**Принцип:** только move-only рефакторинг без смены логики; после каждого шага — `npm run build` в backend.

---

## Фаза A — `strategy.ts`

```
backend/src/bot/strategy/
  mutex.ts          ← per-TS + per-(apiKey,pair) locks (~55)
  types.ts          ← StrategySignal, ParsedSyntheticCandle, … (~57)
  normalize.ts      ← normalizeStrategy, validateStrategyBinding, … (~295)
  signals.ts        ← computeDonchian/StatArb/ZzPivot/CtFractal/Momentum (~275)
  crud.ts           ← get/create/update/delete strategies (~1005)
  sizing.ts         ← buildBalanced/SingleQtyPlan, leg balance (~421)
  candles.ts        ← loadStrategyCandles, parse candles, latest close (~108)
  cycle/cache.ts    ← per-cycle signal cache + group key
  cycle/autoRun.ts  ← runAutoStrategiesCycle (~410)
  cycle/*.ts        ← algofundSync, positionGuards, offlineSymbol, autoRun
  execution.ts      ← close/partial TP, position validation, candle context (~235)
bot/strategy.ts     ← фасад: executeStrategy (~2050, было ~4980)
```

**Не используем:** `backend/src/services/strategy/{crud,mutex,sizing}.ts` — устаревшие заглушки.

### Прогресс

- [x] `mutex.ts`, `types.ts`, `normalize.ts`, `signals.ts`, `crud.ts`, `sizing.ts`, `candles.ts`, `cycle/*`, `execution.ts`
- [x] `strategy.ts` — фасад executeStrategy + re-export cycle/execution API
- [ ] `bot/strategies/*` — DoubleDragon, StatArb, ZigZag

---

## Фаза B — `routes.ts`

```
backend/src/api/routes/
  helpers.ts        ← isLevel3, error status resolvers (~103)
  clientGuides.ts   ← exchange guide constants (~37)
  clientRoutes.ts   ← /auth/client/*, /client/* (~1481)
  backtestRoutes.ts ← /backtest/* (~107)
  adminRoutes.ts    ← requirePlatformAdmin блок (~2440)
  backtestState.ts  ← shared runInProgress mutex
api/routes.ts       ← тонкий aggregator (~77, было ~4290)
```

### Прогресс

- [x] `clientRoutes.ts`, `backtestRoutes.ts`, `adminRoutes.ts`
- [x] `routes.ts` — mount sub-routers

---

## Фаза C — Client backtest queue

- [x] `research/clientPreviewQueue.ts`
- [x] `previewStrategyClientOffer/Selection` → queue вместо sync `runBacktest`
- [x] `GET /client/strategy/preview-job/:jobId`
- [x] `ClientCabinet.tsx` — poll при `preview.source === 'queued_backtest'`
- [x] `previewWorker` — `maxDepositOverride`, `lotPercentOverride`, `fundingRatePercent`

---

## Фаза D — Presets only для client SaaS

- [x] `CLIENT_STRICT_PRESET_MODE` default `1` (env `0` отключает)
- [x] Client preview: `catalog_cache` → `preset_scaled` → `preset_lookup` → queue
- [x] Admin preview: live backtest без изменений (`/backtest/*`)

---

## Чеклист перед merge в main

- [x] `cd backend && npm run build`
- [x] `cd frontend && npm run build` (ClientCabinet poll)
- [ ] Smoke VPS: health, client catalog, preview sliders
- [ ] `systemctl is-active btdd-api btdd-runtime btdd-research`
- [ ] Деплой: `DEPLOY_MODE=multi` на VPS

---

## Безопасность деплоя

- Trading loop (`executeStrategy`, `runAutoStrategiesCycle`) — **без изменений логики**, только move-only
- `btdd-runtime` — отдельный процесс; API restart не останавливает позиции
- Rollback client preview: `CLIENT_STRICT_PRESET_MODE=0` на VPS

---

## Журнал

| Дата | Шаг | Коммит |
|------|-----|--------|
| 2026-07-06 | План + ветка | — |
| 2026-07-06 | A: mutex; B: clientRoutes; C: queue; D: strict preset | — |
| 2026-07-06 | A: normalize/signals/crud; B: backtest/admin routes | deploy |
