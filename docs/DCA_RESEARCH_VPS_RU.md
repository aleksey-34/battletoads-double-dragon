# DCA research на VPS

## Период скана в UI

По умолчанию DCA scan использует **полную глубину карточки / sweep** (те же `dateFrom`/`dateTo`, что и Real rerun TS), например:

`2024-06-01 → 2026-06-03 • 1h • 732d • полная глубина карточки`

Это **~2 года**, не 2 дня. Метка `732d` — разница дат в днях.

## INSANE пресет (UI)

- **15m**, step **0.12%**, TP **0.2%**, base **4%**, max orders **30**, autotune **OFF**
- После пресета обязательно **«Сканировать DCA»** (`dcaForceRefresh: true`)
- Пул: до **16** пар, volatile-first (PEPE, WIF, BONK, DOGE, …)
- Автовыбор пар: сначала volatile, затем по **trades** (число завершённых DCA-циклов)

## Прогресс скана в SaaS

Poll: `GET /api/saas/admin/ts-dca-research-status` (UI делает каждые 2s).

На VPS без cookie:

```bash
# из под админ-сессии проще смотреть в UI; или journalctl:
journalctl -u btdd-api -f | grep -i dca
```

## CLI-ресерч (полный диапазон, медленно)

```bash
cd /opt/battletoads-double-dragon
chmod +x scripts/run_dca_full_research_vps.sh
BTDD_DCA_KEY='artursk-XXX-api' DCA_MARKETS='SUIUSDT,TRXUSDT,DOGEUSDT' \
  ./scripts/run_dca_full_research_vps.sh
tail -f logs/dca_full_research_latest.log
cat logs/dca_full_research.pid   # PID
```

Переменные:

| Env | Default |
|-----|---------|
| `DCA_FROM` | 2024-06-01 |
| `DCA_TO` | 2026-06-03 |
| `BTDD_DCA_KEY` | BTDD_D1 (лучше ключ карточки TS) |
| `DCA_MARKETS` | SUI,TRX,DOGE,WIF,PEPE,BNB |

**PEPE** на `BTDD_D1` часто падает с Bybit error — используйте тот же `apiKeyName`, что у карточки в storefront.

## Память

Не запускайте параллельно тяжёлые `node` backtest (diag, research, admin sweep). Один процесс ~1GB+.

Остановить зависший diag:

```bash
kill "$(cat /opt/battletoads-double-dragon/logs/dca_full_research.pid 2>/dev/null)" 2>/dev/null
pkill -f diag_dca_max_orders_usage || true
```

## Base % vs trades

`baseAmountPercent` меняет **размер лота и Ret/DD**, не число сделок. Trades растут от **step / TP / TF / длины периода**.
