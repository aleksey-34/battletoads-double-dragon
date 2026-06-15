# Balanced Shield + DCA v1 — полное описание TS

Система: `ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v1-x4wc64`  
Карточка: **Balanced Shield + DCA** (732d backtest, admin snapshot)

---

## Архитектура (3 слоя)

```text
┌─────────────────────────────────────────────────────────────┐
│  CORE — 38 mono/trend офферов (sweep snapshot)              │
│  DD_BattleToads 14 + zz_breakout 18 + stat_arb_zscore 4     │
│  + дубли по символам (2 стратегии на ARB, BERA, …)        │
│  ОП=10, lot=20%, reinvest=100%                              │
├─────────────────────────────────────────────────────────────┤
│  MACRO SHIELD — overlay на CORE (не отдельные офферы)        │
│  ETH/BTC RSI(14) 4h ≥70 → закрыть LONG целиком по символу   │
├─────────────────────────────────────────────────────────────┤
│  DCA SATELLITE — 2 mono-стратегии (не sweep offers!)         │
│  SUIUSDT + TRXUSDT, классическая сетка, role=satellite      │
└─────────────────────────────────────────────────────────────┘
```

### Это синтетика?

| Компонент | Тип | Пояснение |
|-----------|-----|-----------|
| **Core 38 offers** | Mono + частично stat_arb | Обычные sweep-офферы, каждый — одна пара USDT-mono |
| **Macro shield** | Overlay | Не оффер; модифицирует exit long по якорям ETH/BTC |
| **DCA SUI/TRX** | **Mono DCA**, не synthetic | Отдельные `strategy_type=dca` на **mono** паре SUIUSDT/TRXUSDT. Это **не** stat-arb пара base/quote. Satellite для стабилизации equity и turnover |

«DCA SUI/TRX» — **не синтетика**, а **mono grid DCA** на ликвидных alt с высокой частотой round-trip.

---

## Доли и веса (backtest + runtime)

### Core trend (38 members, ~100% risk budget)

| Тип | Шт | Доля в карточке | Роль |
|-----|-----|-----------------|------|
| DD_BattleToads (Donchian breakout) | 14 | ~37% members | Trend core, trailing TP |
| zz_breakout (ZigZag channel) | 18 | ~47% | Trend/satellite breakout |
| stat_arb_zscore | 4 | ~11% | Mean-reversion mono |
| Дубли symbol (2nd leg) | ~2 | ~5% | Второй TF/вариант на том же рынке |

**Клиентский lot:** 20% от equity на стратегию (card override).  
**Reinvest:** 100% → `max_deposit` compound до 250k cap.  
**Max open positions (ОП):** 10 — лимит **только trend core**; DCA не считается в ОП.

### Macro Shield (RSI takes)

| Правило | Условие | Действие |
|---------|---------|----------|
| `eth_tp` | ETHUSDT 4h RSI(14) **≥ 70** | Закрыть **весь LONG** по любому символу клиента |
| `btc_tp` | BTCUSDT 4h RSI(14) **≥ 70** | То же |

- Работает **только на long** (short не трогаем этим overlay).
- Закрытие **целиком** по символу (`macro_shield_exit_long`), не partial.
- В backtest: `DEFAULT_TS_MACRO_SHIELD_OVERLAY` в engine.
- В runtime: `macroExitShield.ts` перед stat-arb cycle.
- **Не отдельный оффер** — флаг `macroShield: true` в card metadata.

**Зачем:** фиксация long-прибыли на перегреве BTC/ETH; снижает DD в bull exhaustion без выключения short-leg.

### DCA satellite (SUI + TRX)

| Параметр | Значение (master) |
|----------|-------------------|
| Base size | 400 USDT первая нога |
| Step | **12%** между safety-ордерами (в БД поле `12`, не `0.12`) |
| Max orders | 30 ног сетки |
| TP | **20%** от средней (в БД поле `20`, не `0.2`) |
| TF | **15m** (бары DCA; не 4h) |
| Weight в TS | 0.85, role `satellite` |

**Зачем:**  
- Стабилизация equity curve (много мелких TP-циклов flat→long→TP).  
- Дополнительный **объём** (turnover) без роста trend OP.  
- В combined backtest даёт **Δ ret / Δ trades** vs TS-only (см. модалку «Δ vs TS-only»).

**Runtime:** копируется на каждый client API key + добавляется в `ALGOFUND::<slug>` TS как satellite members.

---

## Объём при текущих настройках (оценка)

Допущения: депозит клиента **~$1000**, lot **20%**, reinvest **100%**, 732d backtest period.

| Слой | Backtest trades | ~Trades/год | Notional feel |
|------|-----------------|-------------|---------------|
| Core 38 offers | ~8507 total | ~4200 | Основной PnL, OP≤10 |
| DCA SUI+TRX | +сотни/тысячи циклов в combined | Высокая частота grid | ~400 USDT base × до 30 legs × 2 pairs |
| Macro shield | Exit events (редко) | 0–N при RSI≥70 | Уменьшает хвост long DD |

**Admin snapshot:** Ret **1184%**, DD **22.7%**, **8507** trades (compound reinvest=100, lot=20, macro+DCA в combined run).

**Live (1 день post-migrate):** ~28 entries / 17 exits на 20 клиентов — ранняя стадия, соответствует активному core; DCA должен добавить циклы после remat.

Per-client **turnover** ≈ `(open_positions × 20% lot × leverage) + DCA grid notional`.  
При 8 open × 20% × ~3x ≈ **~48%** equity в trend + до **~$800–1200** max DCA exposure на пару при полной сетке (зависит от fill depth).

---

## Runtime vs backtest checklist

| Параметр | Backtest | Runtime target |
|----------|----------|----------------|
| systemName | balanced-shield-dca-v1-x4wc64 | ✅ 20/20 clients |
| lot 20% | ✅ | ✅ |
| reinvest 100% | ✅ | ✅ |
| maxOP 10 | ✅ | ✅ |
| macroShield | ✅ engine | ✅ deployed |
| DCA SUI/TRX | ✅ combined | ⚠️ remat после fix materialize |
| 38 offerIds | snapshot | 34/36 на WEEX (TRU + 1 filtered) |

---

## UI / dashboard

- **Витрина:** одна карточка (dedupe alias snapshots), tags `Shield RSI≥70`, `DCA SUI+TRX`, `ОП 10`.
- **Модалка бэктеста:** toggles DCA + Macro shield; Δ vs TS-only; DCA-only layer.
- **DCA не в offer store** — отдельные strategies; в offer table не дублируем.
- **BT/RT daily drift monitor:** временно **отключён** (scheduler `bt_rt_daily_snapshot`).

---

## Операции

```bash
# Rematerialize all shield clients (after deploy)
python3 scripts/admin_tools/storefront/rematerialize_shield_clients.py

# Verify DCA on client
sqlite3 backend/database.db "SELECT t.slug, s.base_symbol FROM strategies s
  JOIN api_keys ak ON ak.id=s.api_key_id
  JOIN algofund_profiles ap ON ap.execution_api_key_name=ak.name
  JOIN tenants tn ON tn.id=ap.tenant_id
  WHERE s.strategy_type='dca' AND s.is_archived=0 AND tn.slug='ali';"
```
