# TV Momentum Scalp 15m (`momentum_scalp_tv`) — burst-слой v4.2

## Зачем

Ортогональный **трендовый burst** к 4h CT fractal synth-ногам: короткие импульсы на liquid mono (SUI, DOGE, SOL), не коррелирует с контртрендом на старшем ТФ.

## Откуда собрано (скрипты / пайплайн)

| Этап | Скрипт | Что делает |
|------|--------|------------|
| Research overlay | `scripts/hybrid/research_ep4_tv_overlay_jul2026.py` | v4.1 + TV burst overlay, честный sizing |
| Burst research | `scripts/hybrid/research_ep4_burst_addon_jul2026.py` | сравнение burst-аддонов |
| VPS pipeline | `scripts/vps_ep4_burst_research.sh` | wick + TV momentum + DB momentum |
| Momentum research | `scripts/momentum_scalp_research.mjs` | прогон mono 15m кандидатов |
| Карточка v4.2 | `scripts/hybrid/build_synth_stable_card_jul2026.py` | `append_v42_tv_burst()` — 3 ноги SUI/DOGE/SOL |
| Runtime / backtest | `backend/src/bot/momentumScalpSignal.ts` | сигнал EMA+ADX |
| Engine | `backend/src/backtest/engine.ts` | exits `ms_tp_*`, `ms_sl_*`, `ms_cross_*` |
| Tests | `backend/src/research/momentumScalpSignal.test.ts` | unit |

**Опубликованная ТС:** `ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-2-jul2026-zbhya` (id 186)  
**Burst strategy ids:** 253636–253638 (SUI/DOGE/SOL 15m mono)

## Логика (не Pine, нативный движок)

Классический **EMA crossover + ADX** (как в TV-стиле trend scalp), без отдельного Pine-скрипта на бирже.

### Вход

- **Long:** EMA fast пересекает EMA slow снизу вверх **и** ADX ≥ 20 **и** +DI > −DI  
- **Short:** обратный кросс **и** ADX ≥ 20 **и** −DI > +DI  

### Выход

- **TP:** +2% от входа (`take_profit_percent`)  
- **SL:** −1.2% (`zscore_stop`)  
- **Opposite cross:** закрытие при обратном пересечении EMA (если включено)

### Параметры по умолчанию

| Поле в БД | Смысл | Default |
|-----------|-------|---------|
| `price_channel_length` | EMA fast period | 8 |
| `zscore_entry` | EMA slow period | 21 |
| `zscore_exit` | ADX min | 20 |
| `take_profit_percent` | TP % | 2.0 |
| `zscore_stop` | SL % | 1.2 |
| `long_enabled` / `short_enabled` | стороны | on |

ADX period фиксирован: 14. Interval: **15m**. Тип стратегии: `momentum_scalp_tv`, режим `mono`.

### Маппинг полей

Старые колонки zscore/channel переиспользованы **без миграции схемы** — см. комментарии в `momentumScalpSignal.ts`.

## Настройки карточки v4.2

- Lot **22%**, OP **15**, reinvest **50%**  
- Portfolio CB8 (DD 8% → lot×0.5 на 14d)  
- Burst-ноги: mult **1.0** (полный burst, без урезания)  
- CT synth-ноги: tune 0.35–1.0  

## Autolot от ширины канала (отдельно)

На **полном CT synth sweep** autolot (узкий Donchian → больше lot) давал лишнюю DD — **выключен** на v4.2.

**Гипотеза для burst:** autolot имеет смысл тестировать **только на mono 15m trend-ногах** (отдельный research pass), не на парных synth CT. Формула: `computeChannelWidthLotMultiplier()` в `backend/src/services/strategy/sizing.ts`.

Следующий шаг research: `autoLotByChannelWidth=true` только на strategy_type=`momentum_scalp_tv`, ref_width 5%, mult 0.5–1.5.
