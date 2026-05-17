"#!/usr/bin/env python3
\"\"\"Generate HTML versions of investment memo and pitch deck, and update pitch deck slide 9.\"\"\"
import markdown, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # repo root

# ── Investment Memo HTML ──────────────────────────────────────────────────────
with open(os.path.join(BASE, 'docs', 'INVESTMENT_MEMO_RU.md'), 'r', encoding='utf-8') as f:
    memo_md = f.read()

memo_html = markdown.markdown(memo_md, extensions=['tables', 'fenced_code'])

html_template = '''<!DOCTYPE html>
<html lang=\"ru\">
<head>
<meta charset=\"UTF-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
<title>BTDD Platform — Investment Memorandum</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', -apple-system, sans-serif; max-width: 860px; margin: 0 auto; padding: 3rem 2rem; line-height: 1.7; color: #1a1a2e; background: #fafbfc; }
  h1 { font-size: 2rem; font-weight: 700; color: #0f0f23; border-bottom: 3px solid #2563eb; padding-bottom: 0.75rem; margin-bottom: 1.5rem; }
  h2 { font-size: 1.35rem; font-weight: 600; color: #1e293b; margin-top: 2.5rem; margin-bottom: 1rem; padding-bottom: 0.4rem; border-bottom: 1px solid #e2e8f0; }
  h3 { font-size: 1.1rem; font-weight: 600; color: #334155; margin-top: 1.5rem; }
  p { margin: 0.75rem 0; color: #334155; }
  strong { color: #2563eb; font-weight: 600; }
  table { border-collapse: collapse; width: 100%; margin: 1.25rem 0; font-size: 0.9rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
  th, td { border: 1px solid #e2e8f0; padding: 10px 14px; text-align: left; }
  th { background: #2563eb; color: #fff; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.5px; }
  tr:nth-child(even) td { background: #f8fafc; }
  blockquote { border-left: 4px solid #2563eb; padding: 0.75rem 1.25rem; margin: 1.25rem 0; background: #f0f4ff; border-radius: 0 8px 8px 0; color: #1e40af; font-style: italic; }
  hr { border: none; border-top: 1px solid #e2e8f0; margin: 2.5rem 0; }
  ul, ol { margin: 0.75rem 0 0.75rem 1.5rem; color: #334155; }
  li { margin: 0.35rem 0; }
  @media print { body { background: #fff; } table { box-shadow: none; } th { background: #e2e8f0; color: #000; } }
</style>
</head>
<body>
{body}
</body>
</html>'''

with open(os.path.join(BASE, 'docs', 'INVESTMENT_MEMO_RU.html'), 'w', encoding='utf-8') as f:
    f.write(html_template.replace('{body}', memo_html))

print('[✓] Investment memo HTML generated')

# ── Update Pitch Deck Slide 9 ────────────────────────────────────────────────
with open(os.path.join(BASE, 'docs', 'PITCH_DECK_RU.md'), 'r', encoding='utf-8') as f:
    pitch = f.read()

old_slide9 = """## Слайд 9 — Запрос грантов / партнёрства

### Что мы ищем

#### От криптобирж:
| Биржа | Программа | Что просим |
|---|---|---|
| **Bybit** | Bybit Builder Grant | $10K–$50K грант + API rebate + co-marketing |
| **OKX** | OKX Ventures | $25K грант на интеграцию OKX API |
| **Binance** | Binance Labs BUIDL | API Integration Grant + developer support |
| **Gate.io** | API Partner | Rebate от объёма + joint promotion |
| **KuCoin** | KuCoin Labs | Grant $15K + ecosystem support |
| **MEXC** | MEXC Partner | Rebate + co-marketing (уже в production) |
| **WEEX** | WEEX Partner | Rebate + co-marketing (уже в production) |

#### От инфраструктурных провайдеров:
| Провайдер | Программа | Размер |
|---|---|---|
| **AWS Activate** | Startup credits | $10K–$100K |
| **Google for Startups** | Cloud credits | до $200K |
| **Microsoft for Startups** | Azure credits | до $150K |

#### Итого запрашиваемая поддержка:
- **$150K–$300K** суммарно грантов/кредитов
- **API partner status** на 3+ биржах (для volume rebate)
- **Co-marketing** → привлечение 200+ клиентов в первые 6 мес"""

new_slide9 = """## Слайд 9 — Предложение партнёрам и инвесторам

### Инвестиционное предложение

**Инвестор получает долю от операционного дохода платформы**, который включает:
- Ежемесячные подписки (SaaS)
- Profit share от клиентских прибылей (40% high-watermark)
- Exchange rebates и referral-бонусы (Bybit, Binance, MEXC, WEEX, BingX)

### Условия

| Параметр | Значение |
|---|---|
| **Доля инвестора** | 30% от ежемесячного чистого дохода |
| **Срок** | Бессрочно (опцион buyout через 24 мес) |
| **Минимальный чек** | $50K за 5% дохода (пропорционально) |
| **Прозрачность** | Ежемесячный dashboard со всеми метриками платформы |
| **Выход** | Buyout-опцион с мультипликатором x3 от среднегодового дохода |

### Почему доход, а не equity?

- ✅ Платформа уже генерирует выручку — инвестор видит результат с первого месяца
- ✅ Не размываем контроль основателя над продуктом
- ✅ Все метрики верифицируемы через API бирж
- ✅ Низкий риск: платформа диверсифицирована по клиентам и биржам

### Финансовый прогноз (12 мес)

| Месяц | Клиенты | MRR (подписки) | Profit Share | Rebates | **Total Monthly** |
|-------|---------|-----------------|--------------|---------|-------------------|
| 1–3 | 19→30 | $1.5K | $0.8K | $0.5K | **$2.8K** |
| 4–6 | 30→50 | $3.5K | $2.0K | $1.2K | **$6.7K** |
| 7–12 | 50→100 | $7.0K | $4.5K | $3.0K | **$14.5K** |

### Возврат инвестиций (при $300K за 30%)

| Год | Месячный доход | Годовой доход | Доход инвестора (30%) | ROI |
|-----|---------------|---------------|------------------------|-----|
| 1 | $2.8K → $14.5K | ~$104K | **$31K** | 10% |
| 2 | $15K → $50K | ~$390K | **$117K** | 39% |
| 3 | $50K → $100K | ~$900K | **$270K** | 90% |

> Цель: полный возврат инвестиций в течение 24–30 месяцев, далее — пассивный доход."""

pitch = pitch.replace(old_slide9, new_slide9)

# Remove VPS IP from slide 10
pitch = pitch.replace(
    '- ✅ **Production-ready**: VPS 176.57.184.98, backend + frontend работают 24/7',
    '- ✅ **Production-ready**: backend + frontend работают 24/7 на выделенном сервере'
)
# Remove demo/GitHub from contacts
pitch = pitch.replace(
    '**Demo**: https://btdd.vercel.app  \n**GitHub**: (приватный, по запросу)',
    ''
)
# Update footer
pitch = pitch.replace(
    '*Версия 1.0, Апрель 2026.*',
    '*Версия 2.0, Май 2026.*'
)
pitch = pitch.replace(
    '*Документ подготовлен для рассылки в программы грантов и партнёрства криптобирж.*',
    '*Документ подготовлен для квалифицированных инвесторов и стратегических партнёров.*'
)

with open(os.path.join(BASE, 'docs', 'PITCH_DECK_RU.md'), 'w', encoding='utf-8') as f:
    f.write(pitch)

# Regenerate pitch deck HTML
pitch_html = markdown.markdown(pitch, extensions=['tables', 'fenced_code'])
with open(os.path.join(BASE, 'docs', 'PITCH_DECK_RU.html'), 'w', encoding='utf-8') as f:
    f.write(html_template.replace('{body}', pitch_html).replace('Investment Memorandum', 'Pitch Deck'))

print('[✓] Pitch deck updated + HTML regenerated')
"