# 🔴 АУДИТ ПРОЕКТА — 30 апреля 2026

## TL;DR — почему профит в BT, а убыток в RT?

**5 главных причин** (ранжированы по влиянию):

| # | Причина | Эффект на P&L |
|---|---------|---------------|
| 1 | **Partial TP закрывает 50% позиции в BT, в RT — НЕ реализован** | До −50% от ожидаемого профита |
| 2 | **Risk multiplier `algofund_profiles.risk_multiplier` применяется ТОЛЬКО в preview-бэктесте, в live он игнорируется** | Лоты в RT в 1.5× меньше/больше чем в BT |
| 3 | **`getRiskSettings()` — мёртвый код. Таблица `risk_settings` (lot_long/short, leverage, margin_type) не читается в runtime** | Стратегия торгует с дефолтами, BT — с настройками |
| 4 | **`algofund_start_stop_requests` — очередь не обрабатывается runtime'ом**. INSERT'ы накапливаются, никто не читает. | Часть клиентов вообще не торгует, хотя помечены active=1 |
| 5 | **Slippage**: BT=0.05%, реальность Market-orderами на WEEX/MEXC — 0.1-0.5% на entry+exit | −0.4-1% на сделку |

Дополнительно ОП-лимитер **не атомарен**: SELECT count + INSERT order без блокировки → допустимо превышение OP=2 на 1-2 позиции при гонке стратегий.

---

## 1. КРИТИЧНЫЕ БАГИ (требуют немедленного фикса)

### 1.1 Очередь algofund_start_stop_requests не процессится
- **Файл**: `backend/src/saas/service.ts:11161` + `runtime-main.ts`
- **Проблема**: `createAlgofundStartStopRequest()` пишет в таблицу со статусом `pending`. В runtime НЕТ кода который читает эту очередь и обрабатывает.
- **Эффект**: Клиент жмёт "Запустить" → request сохранён → статус так и остаётся pending → стратегии не материализуются.
- **Fix**: добавить `processStartStopQueue()` в runtime cycle или удалить таблицу как мёртвую (если фактически переключение идёт другим путём — проверить).

### 1.2 risk_multiplier игнорируется в live trading
- **Файл**: `backend/src/saas/service.ts:10287` (preview), `backend/src/bot/strategy.ts:700` (live)
- **Проблема**: `algofund_profiles.risk_multiplier` множит лот ТОЛЬКО в preview backtest. В `computeSignalTotalNotional()` используется `strategy.lot_long_percent` без множителя.
- **Эффект**: Клиент видит в UI "x1.5" — а реально торгует x1.0.
- **Fix**: в `computeSignalTotalNotional` загрузить multiplier из `algofund_profiles` по tenant_id и умножить на `lot_percent`.

### 1.3 Partial TP не реализован в runtime
- **Файлы**: `backend/src/backtest/engine.ts:1128` (BT работает), `backend/src/bot/strategy.ts:2500+` (RT — нет)
- **Проблема**: BT при `partialTpPct>0` закрывает 50% позиции на достижении цели. Runtime не делает ничего.
- **Эффект**: BT-кривая фиксирует прибыль, RT-кривая откатывается обратно в SL.
- **Fix**: реализовать partial close в `closeAndRecordExit()` (или временно занулить `partialTpPct` во всех материализуемых стратегиях, чтобы BT и RT совпадали).

### 1.4 ОП-лимитер не атомарен
- **Файл**: `backend/src/bot/strategy.ts:2729-2738`
- **Проблема**: `SELECT COUNT(*) FROM open_positions` + `INSERT order` — без транзакции/lock.
- **Эффект**: Две стратегии одной TS могут одновременно увидеть `count=1` и обе открыться → OP=3 при лимите 2.
- **Fix**: `BEGIN IMMEDIATE; SELECT COUNT(*) ...; if (cnt < limit) INSERT ...; COMMIT;`

### 1.5 materializeStrategyClient без транзакции
- **Файл**: `backend/src/saas/service.ts:9957`, `backend/src/bot/tradingSystems.ts:314`
- **Проблема**: read offers → upsert strategies → DELETE/INSERT trading_system_members. Без TX. Параллельный retry создаёт дубли.
- **Fix**: обернуть всю последовательность в одну транзакцию + добавить unique constraint `(tenant_id, source, ts_name)`.

### 1.6 WEEX fetch без timeout (исправлено сегодня частично)
- Уже починили `/capi/v3/account/assets` → `v2`. Но `fetch()` в `weexClient.ts:117` всё ещё без `AbortSignal.timeout(...)` — при подвисании WEEX может зависнуть весь monitoring цикл.

### 1.7 setInterval'ы без timeout per-iteration
- **Файл**: `backend/src/runtime-main.ts:104, 125, 153, 178`
- **Проблема**: Если один цикл (autorun/monitoring/recon/liq) зависает > интервала, следующий просто скипается из-за guard-флага.
- **Fix**: обернуть тело каждого цикла в `Promise.race([job(), timeout(maxMs)])`.

---

## 2. BT vs RT РАСХОЖДЕНИЯ (детально)

| # | Параметр | BT | RT | Δ P&L per trade |
|---|----------|----|----|-----------------|
| 1 | Slippage | 0.05% | 0.1-0.5% | −0.05-0.45% |
| 2 | Commission | 0.1% hardcode | VIP-зависит (0.02-0.06%) | ±0.04-0.08% |
| 3 | Partial TP | да, 50% close | нет | −10-50% от total |
| 4 | Funding | 0% default | реальный (~0.01% в 8ч) | −0.01-0.03% за день удержания |
| 5 | Leverage formula | `notional = capital × lot × leverage` (см. `engine.ts:556`) | `notional = capital × lot` (margin only) | **BT в leverage раз больше** |
| 6 | Order type | мгновенное по close | market → market depth slippage | −0.1-0.5% |
| 7 | Time alignment | exact closed bar | задержка 100-500ms на fetch+exec | timing miss |
| 8 | Signal cache | fresh per bar | 60s TTL shared | timing desync |
| 9 | Partial fills | не моделируются | бывают на иллидных парах | размер позиции <100% |
| 10 | risk_multiplier | применяется | игнорируется | ±50% на лот |

**Самое критичное — №5**: `engine.ts:556` умножает notional на leverage — это удваивает/упятеряет позиции в BT по сравнению с RT (где leverage = только margin requirement). Если у стратегии `leverage=5` и `lot_long_percent=10%`, BT торгует 50% капитала, а RT — 10%.

---

## 3. BACKEND (47 находок, top-10)

| # | Файл | Проблема | Severity |
|---|------|----------|----------|
| B1 | `saas/service.ts:2410-2427` | activate/ensureDefault системного профиля без TX | CRITICAL |
| B2 | `api/routes.ts:1511-1514` | удаление API-ключа: 4 DELETE без TX → orphan записи | CRITICAL |
| B3 | `analytics/btRtSweep.ts:72,80` | миграции с `catch{}` молча скрывают реальные ошибки | CRITICAL |
| B4 | `system/passwordRecovery.ts:69` | fetch к Telegram без timeout — может висеть вечно | CRITICAL |
| B5 | `utils/auth.ts:273-286` | `while(true)` без max_iter при генерации slug | CRITICAL |
| B6 | `bot/exchange.ts:1147-1184` | `submitOrderAttempt` определена дважды в одном scope (вторая перекрывает первую) | HIGH |
| B7 | `bot/exchange.ts:126-151` | `while(true)` rate-limit retry без max | HIGH |
| B8 | `notifications/adminTelegramReporter.ts:83` | `.catch(()=>'')` глотает ошибки Telegram | HIGH |
| B9 | `analytics/liveReconciliation.ts:127-166` | UPDATE+INSERT без TX | HIGH |
| B10 | `bot/risk.ts:20` | `getRiskSettings()` — dead code, никем не используется | HIGH |

---

## 4. RUNTIME / ТОРГОВАЯ ЛОГИКА (15 критичных)

| # | Файл | Проблема |
|---|------|----------|
| R1 | `bot/strategy.ts:2729` | OP-check без lock (race) |
| R2 | `saas/service.ts:9957` | материализация без TX |
| R3 | `bot/tradingSystems.ts:314` | DELETE+INSERT членов TS без TX |
| R4 | `automation/scheduler.ts:45` | recon cycle: 50 стратегий sequentially → может занять >6h |
| R5 | `bot/monitoring.ts:85` | при balance=0 пропускает запись → дыры в графике DD |
| R6 | `bot/exchange.ts:314` | BingX position-side detection: 3 попытки, может пропустить вход в one-way mode |
| R7 | `bot/exchange.ts:330` | MEXC 700007 (no perm) — silent skip без алерта |
| R8 | `automation/reconciliationEngine.ts:77` | reuse trade_id → дубль event'ов |
| R9 | `bot/exchange.ts:158` | offline symbol cache 15min — символ может вернуться раньше |
| R10 | `bot/strategy.ts:596` | signal cache 60s TTL — стратегии получают stale signal |
| R11 | `runtime-main.ts:104` | autorun guard 30s — длинный цикл скипает следующий |
| R12 | `bot/strategy.ts:3635, 3711` | orphan `catch{}` при exec ордера |
| R13 | `analytics/liveReconciliation.ts:126` | INSERT live_trade_event без retry/queue → теряется при disconnect |
| R14 | reconciliation_reports — нет prune (>30 дней) — bloat |
| R15 | OP-лимит = 0 для не-ALGOFUND систем (no enforcement) |

---

## 5. FRONTEND (32 находки, top-10)

| # | Файл | Проблема |
|---|------|----------|
| F1 | `ClientCabinet.tsx:1300` | `runStrategySelectionPreview` без mounted check → stale setState |
| F2 | `ClientCabinet.tsx:1315` | preview-запросы не отменяются → ответ старого оффера перезаписывает новый |
| F3 | `App.tsx:195` | 401 не делает auto-logout — пользователь видит ошибку |
| F4 | `ClientCabinet.tsx:1043` | `algofundRiskMultiplier` локальный + workspace.profile.risk_multiplier рассинхронизируются |
| F5 | `SaaS.tsx:5373` | setInterval synctrade 15s без mounted-флага → утечка |
| F6 | `Dashboard.tsx:1195` | autoRefresh 180s без cap на pending → накопление при медленном API |
| F7 | `ClientCabinet.tsx:1160` | `betaOpInput` без validate range[0.1..10] — можно −5 или 1000 |
| F8 | `ClientCabinet.tsx:1020` | `refreshAlgofundState` не проверяет `data?.state` → может затереть workspace на undefined |
| F9 | `SaaS.tsx:4920` | `loadCopytradingTenant` без error state → бесконечный спиннер |
| F10 | `ClientCabinet.tsx:1745` | статус торговли показывается из stale workspace → кнопка "Включить" на уже включённой |

---

## 6. РЕКОМЕНДОВАННЫЙ ПОРЯДОК ФИКСА

### Спринт 1 (срочно — устранение убытков)
1. **R1 / B-OP**: атомарный OP-check (BEGIN IMMEDIATE)
2. **1.2 risk_multiplier в live**: применить в `computeSignalTotalNotional`
3. **1.5 materialize в TX**
4. **1.1 dequeue start_stop_requests** (или удалить таблицу)
5. **BT vs RT №5 leverage formula**: убрать `× leverageFactor` из `engine.ts:556` ИЛИ применить в RT тоже
6. **1.3 Partial TP**: реализовать в RT, либо обнулить `partialTpPct` во всех materialized стратегиях

### Спринт 2 (стабильность)
7. WEEX fetch + timeout, runtime-main циклы с timeout
8. Все catch{} → catch(e) {logger.warn(...)}
9. ALTER TABLE мигрейшены — нормальная миграционная таблица вместо try/catch
10. Frontend — abort предыдущего fetch при новом запросе (AbortController)
11. Bybit timeout retry, MEXC 700007 alert

### Спринт 3 (чистка)
12. Удалить dead code (`getRiskSettings`)
13. Добавить unique constraints на `strategies(tenant_id, source, ts_name)`
14. Prune `reconciliation_reports` >30 дней
15. Pruning старых `live_trade_events` для performance

---

## 7. БЫСТРЫЙ DIAGNOSE СЕЙЧАС: что проверить вручную

```sql
-- 1. Сколько ALGOFUND клиентов с risk_multiplier ≠ 1.0?
SELECT tenant_id, risk_multiplier, actual_enabled, assigned_api_key_name
FROM algofund_profiles
WHERE actual_enabled=1 AND risk_multiplier <> 1.0;
-- Если есть — у них в RT неправильный лот

-- 2. Сколько pending start_stop_requests лежит без обработки?
SELECT status, COUNT(*) FROM algofund_start_stop_requests GROUP BY status;

-- 3. Какие стратегии торгуют с partialTpPct в parameters?
SELECT id, name, parameters FROM strategies
WHERE is_active=1
  AND parameters LIKE '%partialTpPct%'
  AND CAST(json_extract(parameters,'$.partialTpPct') AS REAL) > 0
LIMIT 20;
-- Если много — это и есть основной разрыв BT vs RT

-- 4. Стратегии с leverage > 1?
SELECT id, name, leverage, lot_long_percent FROM strategies
WHERE is_active=1 AND leverage > 1 LIMIT 20;
-- Если есть — BT в leverage раз больше чем RT (см. BT vs RT №5)
```

---

**Итог**: проект имеет систематические проблемы согласованности BT↔RT и атомарности на критичных путях. Самые опасные для денег — №1.2 (risk_mult), 1.3 (partial TP), 1.4 (OP), №5 (leverage formula). Фикс этих 4 пунктов закроет ~80% разрыва между ожидаемым (BT) и реальным (RT) P&L.
