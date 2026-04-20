# Массовый бэктест GS3 + DAILYSWEEP — Полные результаты

**Дата:** 2026-04-19

**Параметры:** bars=6000, warmup=400, balance=10000, lot=100%, maxDeposit=10000, comm=0.06%, slip=0.03%, OP=1

**Фильтры winners:** ret≥0.5%, PF≥1.02, DD≤30%, trades≥1

## Сводка

| Метрика | Значение |
|---------|----------|
| Всего протестировано | 3740 |
| Ошибки (500 synth pairs) | 248 |
| Winners | 1209 |
| Процент winners | 32.3% |
| Известных 9 в winners | 7 |
| Новых winners | 1202 |

## По инструментам

| Инструмент | Ликвидность 24h | Тир | Winners | Лучший ret% | Лучший PF | Ср. ret% | Ср. DD% |
|------------|----------------|-----|---------|------------|----------|---------|--------|
| APTUSDT | ? | ? | 132 | 62.2% | 4.48 | 26.0% | 16.4% |
| ARBUSDT | ? | ? | 140 | 51.7% | 3.04 | 21.1% | 18.3% |
| BERAUSDT | ? | ? | 187 | 166.4% | 4.19 | 80.6% | 20.4% |
| IPUSDT | ? | ? | 80 | 162.3% | 8.01 | 124.3% | 18.5% |
| NEARUSDT | ? | ? | 224 | 39.5% | 1.96 | 12.5% | 18.3% |
| ONDOUSDT | ? | ? | 77 | 35.5% | 2.43 | 11.2% | 21.4% |
| OPUSDT | ? | ? | 17 | 2.3% | 1.92 | 1.2% | 2.0% |
| ORDIUSDT | ? | ? | 48 | 293.8% | 13.52 | 233.7% | 22.1% |
| RENDERUSDT | ? | ? | 9 | 3.8% | 1.41 | 1.9% | 5.3% |
| SOMIUSDT | ? | ? | 52 | 106.7% | 3.55 | 59.0% | 24.6% |
| SUIUSDT | ? | ? | 151 | 38.9% | 6.09 | 11.1% | 12.4% |
| TRUUSDT | ? | ? | 83 | 126.2% | 3.83 | 55.2% | 22.2% |
| UNIUSDT | ? | ? | 9 | 2.4% | 1.20 | 1.5% | 5.7% |

## ТОП-5 стратегий по каждому инструменту/паре

### APTUSDT (Ликвидность: ?, Тир: ?, Winners: 59)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164598 | GS3_4H_DD_M_APTUSDT_4h_L8_TP7_5_SRCwick | 4h | DD_Bat | 50.5 | 21.8 | 1.65 | 59 | 35.6 | ROBUST |
| 2 | 164698 | GS3_4H_ZZ_M_APTUSDT_4h_L8_TP7_5_SRCwick | 4h | ZZ_Bre | 50.5 | 21.8 | 1.65 | 59 | 35.6 | ROBUST |
| 3 | 164600 | GS3_4H_DD_M_APTUSDT_4h_L8_TP10_SRCwick | 4h | DD_Bat | 48.6 | 22.9 | 1.61 | 59 | 35.6 | ROBUST |
| 4 | 164700 | GS3_4H_ZZ_M_APTUSDT_4h_L8_TP10_SRCwick | 4h | ZZ_Bre | 48.6 | 22.9 | 1.61 | 59 | 35.6 | ROBUST |
| 5 | 164596 | GS3_4H_DD_M_APTUSDT_4h_L8_TP5_SRCwick | 4h | DD_Bat | 48.2 | 21.3 | 1.62 | 59 | 35.6 | ROBUST |

### APTUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 73)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165887 | GS3_4H_DD_S_APTUSDT_TIAUSDT_4h_L36_TP5_SRCclose | 4h | DD_Bat | 62.2 | 10.7 | 4.35 | 12 | 58.3 | ROBUST |
| 2 | 165987 | GS3_4H_ZZ_S_APTUSDT_TIAUSDT_4h_L36_TP5_SRCclose | 4h | ZZ_Bre | 62.2 | 10.7 | 4.35 | 12 | 58.3 | ROBUST |
| 3 | 165889 | GS3_4H_DD_S_APTUSDT_TIAUSDT_4h_L36_TP7_5_SRCclose | 4h | DD_Bat | 61.2 | 9.7 | 4.48 | 12 | 58.3 | ROBUST |
| 4 | 165891 | GS3_4H_DD_S_APTUSDT_TIAUSDT_4h_L36_TP10_SRCclose | 4h | DD_Bat | 61.2 | 9.7 | 4.48 | 12 | 58.3 | ROBUST |
| 5 | 165989 | GS3_4H_ZZ_S_APTUSDT_TIAUSDT_4h_L36_TP7_5_SRCclose | 4h | ZZ_Bre | 61.2 | 9.7 | 4.48 | 12 | 58.3 | ROBUST |

### ARBUSDT (Ликвидность: ?, Тир: ?, Winners: 90)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164904 | GS3_4H_DD_M_ARBUSDT_4h_L24_TP10_SRCwick | 4h | DD_Bat | 51.7 | 15.8 | 3.04 | 19 | 31.6 | ROBUST |
| 2 | 165004 | GS3_4H_ZZ_M_ARBUSDT_4h_L24_TP10_SRCwick | 4h | ZZ_Bre | 51.7 | 15.8 | 3.04 | 19 | 31.6 | ROBUST |
| 3 | 164874 | GS3_4H_DD_M_ARBUSDT_4h_L8_TP3_SRCwick | 4h | DD_Bat | 50.4 | 17.2 | 1.73 | 57 | 40.4 | ROBUST |
| 4 | 164974 | GS3_4H_ZZ_M_ARBUSDT_4h_L8_TP3_SRCwick | 4h | ZZ_Bre | 50.4 | 17.2 | 1.73 | 57 | 40.4 | ROBUST |
| 5 | 164899 | GS3_4H_DD_M_ARBUSDT_4h_L24_TP5_SRCclose | 4h | DD_Bat | 50.0 | 21.5 | 2.39 | 22 | 31.8 | ROBUST |

### ARBUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 50)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165315 | GS3_4H_DD_S_ARBUSDT_TIAUSDT_4h_L16_TP10_SRCclose | 4h | DD_Bat | 17.4 | 14.6 | 1.57 | 29 | 31.0 | ROBUST |
| 2 | 165415 | GS3_4H_ZZ_S_ARBUSDT_TIAUSDT_4h_L16_TP10_SRCclose | 4h | ZZ_Bre | 17.4 | 14.6 | 1.57 | 29 | 31.0 | ROBUST |
| 3 | 165307 | GS3_4H_DD_S_ARBUSDT_TIAUSDT_4h_L12_TP10_SRCclose | 4h | DD_Bat | 17.4 | 18.5 | 1.54 | 39 | 43.6 | ROBUST |
| 4 | 165407 | GS3_4H_ZZ_S_ARBUSDT_TIAUSDT_4h_L12_TP10_SRCclose | 4h | ZZ_Bre | 17.4 | 18.5 | 1.54 | 39 | 43.6 | ROBUST |
| 5 | 165324 | GS3_4H_DD_S_ARBUSDT_TIAUSDT_4h_L24_TP10_SRCwick | 4h | DD_Bat | 13.7 | 13.4 | 1.79 | 21 | 42.9 | ROBUST |

### BERAUSDT (Ликвидность: ?, Тир: ?, Winners: 187)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 163464 | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP4_SRCwick | 4h | DD_Bat | 166.4 | 16.3 | 2.16 | 85 | 37.6 | ROBUST |
| 2 | 163518 | DAILYSWEEP_DD_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | DD_Bat | 164.6 | 26.7 | 3.77 | 19 | 42.1 | HIGH_DD |
| 3 | 163784 ★ | GS3_4H_DD_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | DD_Bat | 164.6 | 26.7 | 3.77 | 19 | 42.1 | HIGH_DD |
| 4 | 163884 | GS3_4H_ZZ_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | ZZ_Bre | 164.6 | 26.7 | 3.77 | 19 | 42.1 | HIGH_DD |
| 5 | 163462 | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP3_SRCwick | 4h | DD_Bat | 161.1 | 15.5 | 2.12 | 86 | 37.2 | ROBUST |

### IPUSDT (Ликвидность: ?, Тир: ?, Winners: 80)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 163931 | GS3_4H_DD_M_IPUSDT_4h_L36_TP10_SRCclose | 4h | DD_Bat | 162.3 | 22.7 | 6.20 | 14 | 50.0 | ROBUST |
| 2 | 164031 | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP10_SRCclose | 4h | ZZ_Bre | 162.3 | 22.7 | 6.20 | 14 | 50.0 | ROBUST |
| 3 | 163919 | GS3_4H_DD_M_IPUSDT_4h_L24_TP5_SRCclose | 4h | DD_Bat | 157.9 | 13.8 | 4.53 | 21 | 38.1 | ROBUST |
| 4 | 164019 | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP5_SRCclose | 4h | ZZ_Bre | 157.9 | 13.8 | 4.53 | 21 | 38.1 | ROBUST |
| 5 | 163932 | GS3_4H_DD_M_IPUSDT_4h_L36_TP10_SRCwick | 4h | DD_Bat | 156.8 | 20.9 | 8.01 | 13 | 61.5 | ROBUST |

### NEARUSDT (Ликвидность: ?, Тир: ?, Winners: 82)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164738 | GS3_4H_DD_M_NEARUSDT_4h_L8_TP7_5_SRCwick | 4h | DD_Bat | 39.5 | 20.0 | 1.53 | 54 | 44.4 | ROBUST |
| 2 | 164740 | GS3_4H_DD_M_NEARUSDT_4h_L8_TP10_SRCwick | 4h | DD_Bat | 39.5 | 20.0 | 1.53 | 54 | 44.4 | ROBUST |
| 3 | 164838 | GS3_4H_ZZ_M_NEARUSDT_4h_L8_TP7_5_SRCwick | 4h | ZZ_Bre | 39.5 | 20.0 | 1.53 | 54 | 44.4 | ROBUST |
| 4 | 164840 | GS3_4H_ZZ_M_NEARUSDT_4h_L8_TP10_SRCwick | 4h | ZZ_Bre | 39.5 | 20.0 | 1.53 | 54 | 44.4 | ROBUST |
| 5 | 164734 | GS3_4H_DD_M_NEARUSDT_4h_L8_TP3_SRCwick | 4h | DD_Bat | 35.4 | 20.4 | 1.46 | 55 | 43.6 | LOW_PF |

### NEARUSDT/SEIUSDT (Ликвидность: ?, Тир: ?, Winners: 57)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165609 | GS3_4H_DD_S_NEARUSDT_SEIUSDT_4h_L36_TP7_5_SRCclose | 4h | DD_Bat | 15.5 | 18.3 | 1.69 | 14 | 28.6 | ROBUST |
| 2 | 165709 | GS3_4H_ZZ_S_NEARUSDT_SEIUSDT_4h_L36_TP7_5_SRCclose | 4h | ZZ_Bre | 15.5 | 18.3 | 1.69 | 14 | 28.6 | ROBUST |
| 3 | 165613 | GS3_4H_SZ_S_NEARUSDT_SEIUSDT_4h_L24_ZE1_5_ZX0_5_ZS | 4h | StatAr | 14.5 | 15.4 | 1.25 | 56 | 58.9 | LOW_PF |
| 4 | 165639 | GS3_4H_SZ_S_NEARUSDT_SEIUSDT_4h_L72_ZE1_5_ZX0_75_Z | 4h | StatAr | 13.9 | 26.9 | 1.25 | 35 | 57.1 | HIGH_DD,LOW_PF |
| 5 | 165611 | GS3_4H_DD_S_NEARUSDT_SEIUSDT_4h_L36_TP10_SRCclose | 4h | DD_Bat | 13.3 | 19.9 | 1.59 | 14 | 28.6 | ROBUST |

### NEARUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 85)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165442 | GS3_4H_DD_S_NEARUSDT_TIAUSDT_4h_L12_TP3_SRCwick | 4h | DD_Bat | 24.4 | 21.3 | 1.47 | 45 | 26.7 | LOW_PF |
| 2 | 165542 | GS3_4H_ZZ_S_NEARUSDT_TIAUSDT_4h_L12_TP3_SRCwick | 4h | ZZ_Bre | 24.4 | 21.3 | 1.47 | 45 | 26.7 | LOW_PF |
| 3 | 165444 | GS3_4H_DD_S_NEARUSDT_TIAUSDT_4h_L12_TP5_SRCwick | 4h | DD_Bat | 22.6 | 22.5 | 1.44 | 45 | 26.7 | LOW_PF |
| 4 | 165544 | GS3_4H_ZZ_S_NEARUSDT_TIAUSDT_4h_L12_TP5_SRCwick | 4h | ZZ_Bre | 22.6 | 22.5 | 1.44 | 45 | 26.7 | LOW_PF |
| 5 | 165465 | GS3_4H_DD_S_NEARUSDT_TIAUSDT_4h_L36_TP3_SRCclose | 4h | DD_Bat | 20.5 | 16.5 | 1.64 | 20 | 30.0 | ROBUST |

### ONDOUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 77)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165187 | GS3_4H_DD_S_ONDOUSDT_TIAUSDT_4h_L36_TP5_SRCclose | 4h | DD_Bat | 35.5 | 21.7 | 2.43 | 16 | 31.2 | ROBUST |
| 2 | 165287 | GS3_4H_ZZ_S_ONDOUSDT_TIAUSDT_4h_L36_TP5_SRCclose | 4h | ZZ_Bre | 35.5 | 21.7 | 2.43 | 16 | 31.2 | ROBUST |
| 3 | 165189 | GS3_4H_DD_S_ONDOUSDT_TIAUSDT_4h_L36_TP7_5_SRCclose | 4h | DD_Bat | 34.0 | 22.3 | 2.33 | 16 | 31.2 | ROBUST |
| 4 | 165191 | GS3_4H_DD_S_ONDOUSDT_TIAUSDT_4h_L36_TP10_SRCclose | 4h | DD_Bat | 34.0 | 22.3 | 2.33 | 16 | 31.2 | ROBUST |
| 5 | 165289 | GS3_4H_ZZ_S_ONDOUSDT_TIAUSDT_4h_L36_TP7_5_SRCclose | 4h | ZZ_Bre | 34.0 | 22.3 | 2.33 | 16 | 31.2 | ROBUST |

### OPUSDT/SEIUSDT (Ликвидность: ?, Тир: ?, Winners: 17)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 167671 | GS3_5M_SZ_S_OPUSDT_SEIUSDT_5m_L48_ZE2_ZX0_5_ZS3_5 | 5m | StatAr | 2.3 | 1.6 | 1.90 | 20 | 75.0 | LOW_RET |
| 2 | 167667 | GS3_5M_SZ_S_OPUSDT_SEIUSDT_5m_L48_ZE1_5_ZX0_5_ZS3_ | 5m | StatAr | 1.8 | 2.3 | 1.48 | 31 | 71.0 | LOW_PF,LOW_RET |
| 3 | 167663 | GS3_5M_SZ_S_OPUSDT_SEIUSDT_5m_L24_ZE2_25_ZX0_5_ZS3 | 5m | StatAr | 1.7 | 2.3 | 1.65 | 23 | 69.6 | LOW_RET |
| 4 | 167687 | GS3_5M_SZ_S_OPUSDT_SEIUSDT_5m_L72_ZE2_25_ZX0_5_ZS3 | 5m | StatAr | 1.7 | 1.4 | 1.92 | 12 | 66.7 | LOW_RET |
| 5 | 167675 | GS3_5M_SZ_S_OPUSDT_SEIUSDT_5m_L48_ZE2_25_ZX0_5_ZS3 | 5m | StatAr | 1.6 | 1.5 | 1.91 | 14 | 71.4 | LOW_RET |

### ORDIUSDT (Ликвидность: ?, Тир: ?, Winners: 48)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164315 | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP5_SRCclose | 4h | DD_Bat | 293.8 | 22.7 | 4.41 | 58 | 41.4 | ROBUST |
| 2 | 164415 | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP5_SRCclose | 4h | ZZ_Bre | 293.8 | 22.7 | 4.41 | 58 | 41.4 | ROBUST |
| 3 | 164316 | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP5_SRCwick | 4h | DD_Bat | 287.1 | 25.7 | 4.57 | 56 | 41.1 | HIGH_DD |
| 4 | 164416 | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP5_SRCwick | 4h | ZZ_Bre | 287.1 | 25.7 | 4.57 | 56 | 41.1 | HIGH_DD |
| 5 | 164313 | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP3_SRCclose | 4h | DD_Bat | 285.5 | 23.1 | 4.12 | 60 | 40.0 | ROBUST |

### RENDERUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 9)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 167823 | GS3_5M_SZ_S_RENDERUSDT_TIAUSDT_5m_L24_ZE2_ZX0_75_Z | 5m | StatAr | 3.8 | 4.8 | 1.41 | 35 | 62.9 | LOW_PF,LOW_RET |
| 2 | 167827 | GS3_5M_SZ_S_RENDERUSDT_TIAUSDT_5m_L24_ZE2_25_ZX0_7 | 5m | StatAr | 2.8 | 4.8 | 1.32 | 31 | 61.3 | LOW_PF,LOW_RET |
| 3 | 167819 | GS3_5M_SZ_S_RENDERUSDT_TIAUSDT_5m_L24_ZE1_5_ZX0_75 | 5m | StatAr | 2.5 | 4.7 | 1.21 | 51 | 62.8 | LOW_PF,LOW_RET |
| 4 | 167822 | GS3_5M_SZ_S_RENDERUSDT_TIAUSDT_5m_L24_ZE2_ZX0_75_Z | 5m | StatAr | 2.4 | 4.7 | 1.21 | 42 | 57.1 | LOW_PF,LOW_RET |
| 5 | 167826 | GS3_5M_SZ_S_RENDERUSDT_TIAUSDT_5m_L24_ZE2_25_ZX0_7 | 5m | StatAr | 2.0 | 4.7 | 1.18 | 38 | 57.9 | LOW_PF,LOW_RET |

### SOMIUSDT (Ликвидность: ?, Тир: ?, Winners: 52)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164110 | GS3_4H_SZ_M_SOMIUSDT_4h_L96_ZE1_5_ZX0_5_ZS3_5 | 4h | StatAr | 106.7 | 23.7 | 3.29 | 15 | 73.3 | ROBUST |
| 2 | 164109 | GS3_4H_SZ_M_SOMIUSDT_4h_L96_ZE1_5_ZX0_5_ZS3 | 4h | StatAr | 102.4 | 23.9 | 2.94 | 20 | 65.0 | ROBUST |
| 3 | 164113 | GS3_4H_SZ_M_SOMIUSDT_4h_L96_ZE2_ZX0_5_ZS3 | 4h | StatAr | 100.2 | 21.4 | 3.29 | 15 | 60.0 | ROBUST |
| 4 | 164117 | GS3_4H_SZ_M_SOMIUSDT_4h_L96_ZE2_25_ZX0_5_ZS3 | 4h | StatAr | 99.7 | 21.2 | 3.55 | 14 | 57.1 | ROBUST |
| 5 | 164114 | GS3_4H_SZ_M_SOMIUSDT_4h_L96_ZE2_ZX0_5_ZS3_5 | 4h | StatAr | 97.5 | 21.2 | 3.21 | 11 | 63.6 | ROBUST |

### SUIUSDT (Ликвидность: ?, Тир: ?, Winners: 70)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164462 | GS3_4H_DD_M_SUIUSDT_4h_L12_TP3_SRCwick | 4h | DD_Bat | 38.9 | 15.2 | 1.66 | 41 | 48.8 | ROBUST |
| 2 | 164562 | GS3_4H_ZZ_M_SUIUSDT_4h_L12_TP3_SRCwick | 4h | ZZ_Bre | 38.9 | 15.2 | 1.66 | 41 | 48.8 | ROBUST |
| 3 | 164456 | GS3_4H_DD_M_SUIUSDT_4h_L8_TP5_SRCwick | 4h | DD_Bat | 37.4 | 21.7 | 1.55 | 52 | 34.6 | ROBUST |
| 4 | 164556 | GS3_4H_ZZ_M_SUIUSDT_4h_L8_TP5_SRCwick | 4h | ZZ_Bre | 37.4 | 21.7 | 1.55 | 52 | 34.6 | ROBUST |
| 5 | 164454 | GS3_4H_DD_M_SUIUSDT_4h_L8_TP3_SRCwick | 4h | DD_Bat | 36.8 | 21.4 | 1.50 | 55 | 36.4 | ROBUST |

### SUIUSDT/SEIUSDT (Ликвидность: ?, Тир: ?, Winners: 81)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 165776 | GS3_4H_SZ_S_SUIUSDT_SEIUSDT_4h_L48_ZE2_25_ZX0_75_Z | 4h | StatAr | 17.9 | 11.5 | 2.13 | 18 | 66.7 | ROBUST |
| 2 | 165772 | GS3_4H_SZ_S_SUIUSDT_SEIUSDT_4h_L48_ZE2_ZX0_75_ZS3_ | 4h | StatAr | 16.1 | 10.9 | 1.88 | 20 | 70.0 | ROBUST |
| 3 | 165774 | GS3_4H_SZ_S_SUIUSDT_SEIUSDT_4h_L48_ZE2_25_ZX0_5_ZS | 4h | StatAr | 14.5 | 13.6 | 1.64 | 16 | 68.8 | ROBUST |
| 4 | 165770 | GS3_4H_SZ_S_SUIUSDT_SEIUSDT_4h_L48_ZE2_ZX0_5_ZS3_5 | 4h | StatAr | 14.3 | 13.0 | 1.60 | 18 | 72.2 | ROBUST |
| 5 | 165768 | GS3_4H_SZ_S_SUIUSDT_SEIUSDT_4h_L48_ZE1_5_ZX0_75_ZS | 4h | StatAr | 13.2 | 12.1 | 1.59 | 24 | 58.3 | ROBUST |

### TRUUSDT (Ликвидность: ?, Тир: ?, Winners: 17)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 164200 | GS3_4H_DD_M_TRUUSDT_4h_L24_TP5_SRCwick | 4h | DD_Bat | 126.2 | 26.0 | 2.74 | 22 | 54.5 | HIGH_DD |
| 2 | 164300 | GS3_4H_ZZ_M_TRUUSDT_4h_L24_TP5_SRCwick | 4h | ZZ_Bre | 126.2 | 26.0 | 2.74 | 22 | 54.5 | HIGH_DD |
| 3 | 164198 | GS3_4H_DD_M_TRUUSDT_4h_L24_TP3_SRCwick | 4h | DD_Bat | 122.9 | 28.0 | 2.75 | 25 | 60.0 | HIGH_DD |
| 4 | 164298 | GS3_4H_ZZ_M_TRUUSDT_4h_L24_TP3_SRCwick | 4h | ZZ_Bre | 122.9 | 28.0 | 2.75 | 25 | 60.0 | HIGH_DD |
| 5 | 164184 | GS3_4H_DD_M_TRUUSDT_4h_L12_TP5_SRCwick | 4h | DD_Bat | 120.9 | 30.0 | 2.48 | 38 | 39.5 | HIGH_DD |

### TRUUSDT/GRTUSDT (Ликвидность: ?, Тир: ?, Winners: 66)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 166842 | GS3_1H_DD_S_TRUUSDT_GRTUSDT_1h_L24_TP5_SRCclose | 1h | DD_Bat | 99.7 | 24.9 | 2.99 | 29 | 37.9 | ROBUST |
| 2 | 166887 | GS3_1H_ZZ_S_TRUUSDT_GRTUSDT_1h_L24_TP5_SRCclose | 1h | ZZ_Bre | 99.7 | 24.9 | 2.99 | 29 | 37.9 | ROBUST |
| 3 | 166089 | GS3_4H_SZ_S_TRUUSDT_GRTUSDT_4h_L120_ZE2_25_ZX0_5_Z | 4h | StatAr | 98.4 | 18.6 | 2.74 | 24 | 58.3 | ROBUST |
| 4 | 166070 | GS3_4H_SZ_S_TRUUSDT_GRTUSDT_4h_L96_ZE1_5_ZX0_5_ZS3 | 4h | StatAr | 98.3 | 20.8 | 2.87 | 22 | 68.2 | ROBUST |
| 5 | 166085 | GS3_4H_SZ_S_TRUUSDT_GRTUSDT_4h_L120_ZE2_ZX0_5_ZS3 | 4h | StatAr | 95.8 | 18.6 | 2.68 | 24 | 58.3 | ROBUST |

### UNIUSDT/TIAUSDT (Ликвидность: ?, Тир: ?, Winners: 9)

| # | ID | Имя | TF | Тип | Ret% | DD% | PF | Trades | WR% | Робастность |
|---|-----|-----|----|-----|------|-----|-----|--------|-----|-------------|
| 1 | 168045 | GS3_5M_SZ_S_UNIUSDT_TIAUSDT_5m_L48_ZE1_5_ZX0_5_ZS3 | 5m | StatAr | 2.4 | 5.7 | 1.19 | 25 | 68.0 | LOW_PF,LOW_RET |
| 2 | 168039 | GS3_5M_SZ_S_UNIUSDT_TIAUSDT_5m_L24_ZE2_ZX0_75_ZS3_ | 5m | StatAr | 2.3 | 5.1 | 1.20 | 33 | 66.7 | LOW_PF,LOW_RET |
| 3 | 168043 | GS3_5M_SZ_S_UNIUSDT_TIAUSDT_5m_L24_ZE2_25_ZX0_75_Z | 5m | StatAr | 2.2 | 5.5 | 1.19 | 27 | 63.0 | LOW_PF,LOW_RET |
| 4 | 168041 | GS3_5M_SZ_S_UNIUSDT_TIAUSDT_5m_L24_ZE2_25_ZX0_5_ZS | 5m | StatAr | 1.8 | 5.5 | 1.16 | 27 | 66.7 | LOW_PF,LOW_RET |
| 5 | 168047 | GS3_5M_SZ_S_UNIUSDT_TIAUSDT_5m_L48_ZE1_5_ZX0_75_ZS | 5m | StatAr | 1.5 | 6.1 | 1.12 | 26 | 69.2 | LOW_PF,LOW_RET |

## ТОП-100 по доходности (все инструменты)

| # | ID | Инструмент | Имя | TF | Ret% | DD% | PF | Trades | WR% | Ликв. | Робастность |
|---|----|-----------|-----|----|------|-----|-----|--------|-----|-------|-------------|
| 1 | 164315 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP5_SRCclose | 4h | 293.8 | 22.7 | 4.41 | 58 | 41.4 | ? | ROBUST |
| 2 | 164415 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP5_SRCclose | 4h | 293.8 | 22.7 | 4.41 | 58 | 41.4 | ? | ROBUST |
| 3 | 164316 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP5_SRCwick | 4h | 287.1 | 25.7 | 4.57 | 56 | 41.1 | ? | HIGH_DD |
| 4 | 164416 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP5_SRCwick | 4h | 287.1 | 25.7 | 4.57 | 56 | 41.1 | ? | HIGH_DD |
| 5 | 164313 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP3_SRCclose | 4h | 285.5 | 23.1 | 4.12 | 60 | 40.0 | ? | ROBUST |
| 6 | 164413 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP3_SRCclose | 4h | 285.5 | 23.1 | 4.12 | 60 | 40.0 | ? | ROBUST |
| 7 | 164321 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L12_TP3_SRCclose | 4h | 261.9 | 27.6 | 4.25 | 50 | 38.0 | ? | HIGH_DD |
| 8 | 164421 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L12_TP3_SRCclose | 4h | 261.9 | 27.6 | 4.25 | 50 | 38.0 | ? | HIGH_DD |
| 9 | 164314 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP3_SRCwick | 4h | 255.1 | 22.8 | 3.79 | 59 | 40.7 | ? | ROBUST |
| 10 | 164414 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP3_SRCwick | 4h | 255.1 | 22.8 | 3.79 | 59 | 40.7 | ? | ROBUST |
| 11 | 164340 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L24_TP5_SRCwick | 4h | 254.5 | 27.0 | 6.06 | 22 | 40.9 | ? | HIGH_DD |
| 12 | 164440 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L24_TP5_SRCwick | 4h | 254.5 | 27.0 | 6.06 | 22 | 40.9 | ? | HIGH_DD |
| 13 | 164339 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L24_TP5_SRCclose | 4h | 253.6 | 28.6 | 6.39 | 21 | 42.9 | ? | HIGH_DD |
| 14 | 164439 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L24_TP5_SRCclose | 4h | 253.6 | 28.6 | 6.39 | 21 | 42.9 | ? | HIGH_DD |
| 15 | 164337 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L24_TP3_SRCclose | 4h | 252.9 | 24.5 | 6.57 | 27 | 48.1 | ? | ROBUST |
| 16 | 164437 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L24_TP3_SRCclose | 4h | 252.9 | 24.5 | 6.57 | 27 | 48.1 | ? | ROBUST |
| 17 | 166407 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L14_TP5_SRCclose | 1h | 249.3 | 18.0 | 13.52 | 34 | 61.8 | ? | ROBUST |
| 18 | 166452 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L14_TP5_SRCclose | 1h | 249.3 | 18.0 | 13.52 | 34 | 61.8 | ? | ROBUST |
| 19 | 164317 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP7_5_SRCclose | 4h | 248.4 | 23.6 | 3.89 | 58 | 41.4 | ? | ROBUST |
| 20 | 164417 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP7_5_SRCclose | 4h | 248.4 | 23.6 | 3.89 | 58 | 41.4 | ? | ROBUST |
| 21 | 164319 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP10_SRCclose | 4h | 248.2 | 23.6 | 3.89 | 58 | 41.4 | ? | ROBUST |
| 22 | 164419 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP10_SRCclose | 4h | 248.2 | 23.6 | 3.89 | 58 | 41.4 | ? | ROBUST |
| 23 | 166408 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L14_TP7_5_SRCclose | 1h | 246.5 | 18.6 | 12.58 | 33 | 60.6 | ? | ROBUST |
| 24 | 166453 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L14_TP7_5_SRCclose | 1h | 246.5 | 18.6 | 12.58 | 33 | 60.6 | ? | ROBUST |
| 25 | 164318 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP7_5_SRCwick | 4h | 245.7 | 26.6 | 4.00 | 56 | 41.1 | ? | HIGH_DD |
| 26 | 164418 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP7_5_SRCwick | 4h | 245.7 | 26.6 | 4.00 | 56 | 41.1 | ? | HIGH_DD |
| 27 | 164347 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L36_TP5_SRCclose | 4h | 245.4 | 27.6 | 6.99 | 18 | 50.0 | ? | HIGH_DD |
| 28 | 164447 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L36_TP5_SRCclose | 4h | 245.4 | 27.6 | 6.99 | 18 | 50.0 | ? | HIGH_DD |
| 29 | 164320 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L8_TP10_SRCwick | 4h | 245.4 | 26.7 | 3.99 | 56 | 41.1 | ? | HIGH_DD |
| 30 | 164420 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L8_TP10_SRCwick | 4h | 245.4 | 26.7 | 3.99 | 56 | 41.1 | ? | HIGH_DD |
| 31 | 164345 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L36_TP3_SRCclose | 4h | 243.4 | 24.4 | 7.30 | 24 | 41.7 | ? | ROBUST |
| 32 | 164445 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L36_TP3_SRCclose | 4h | 243.4 | 24.4 | 7.30 | 24 | 41.7 | ? | ROBUST |
| 33 | 166405 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L8_TP7_5_SRCclose | 1h | 238.5 | 19.6 | 6.02 | 49 | 44.9 | ? | ROBUST |
| 34 | 166450 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L8_TP7_5_SRCclose | 1h | 238.5 | 19.6 | 6.02 | 49 | 44.9 | ? | ROBUST |
| 35 | 166404 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L8_TP5_SRCclose | 1h | 229.7 | 21.9 | 5.98 | 50 | 46.0 | ? | ROBUST |
| 36 | 166449 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L8_TP5_SRCclose | 1h | 229.7 | 21.9 | 5.98 | 50 | 46.0 | ? | ROBUST |
| 37 | 164338 | ORDIUSDT | GS3_4H_DD_M_ORDIUSDT_4h_L24_TP3_SRCwick | 4h | 224.7 | 20.0 | 5.13 | 28 | 46.4 | ? | ROBUST |
| 38 | 164438 | ORDIUSDT | GS3_4H_ZZ_M_ORDIUSDT_4h_L24_TP3_SRCwick | 4h | 224.7 | 20.0 | 5.13 | 28 | 46.4 | ? | ROBUST |
| 39 | 166410 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L24_TP5_SRCclose | 1h | 223.8 | 20.5 | 10.93 | 25 | 40.0 | ? | ROBUST |
| 40 | 166455 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L24_TP5_SRCclose | 1h | 223.8 | 20.5 | 10.93 | 25 | 40.0 | ? | ROBUST |
| 41 | 166411 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L24_TP7_5_SRCclose | 1h | 213.2 | 23.5 | 7.44 | 25 | 40.0 | ? | ROBUST |
| 42 | 166456 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L24_TP7_5_SRCclose | 1h | 213.2 | 23.5 | 7.44 | 25 | 40.0 | ? | ROBUST |
| 43 | 163464 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP4_SRCwick | 4h | 166.4 | 16.3 | 2.16 | 85 | 37.6 | ? | ROBUST |
| 44 | 163518 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | 164.6 | 26.7 | 3.77 | 19 | 42.1 | ? | HIGH_DD |
| 45 | 163784 ★ | BERAUSDT | GS3_4H_DD_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | 164.6 | 26.7 | 3.77 | 19 | 42.1 | ? | HIGH_DD |
| 46 | 163884 | BERAUSDT | GS3_4H_ZZ_M_BERAUSDT_4h_L24_TP10_SRCwick | 4h | 164.6 | 26.7 | 3.77 | 19 | 42.1 | ? | HIGH_DD |
| 47 | 163931 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L36_TP10_SRCclose | 4h | 162.3 | 22.7 | 6.20 | 14 | 50.0 | ? | ROBUST |
| 48 | 164031 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP10_SRCclose | 4h | 162.3 | 22.7 | 6.20 | 14 | 50.0 | ? | ROBUST |
| 49 | 163462 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP3_SRCwick | 4h | 161.1 | 15.5 | 2.12 | 86 | 37.2 | ? | ROBUST |
| 50 | 163919 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L24_TP5_SRCclose | 4h | 157.9 | 13.8 | 4.53 | 21 | 38.1 | ? | ROBUST |
| 51 | 164019 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP5_SRCclose | 4h | 157.9 | 13.8 | 4.53 | 21 | 38.1 | ? | ROBUST |
| 52 | 163466 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP5_SRCwick | 4h | 157.8 | 16.8 | 2.03 | 84 | 36.9 | ? | ROBUST |
| 53 | 163932 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L36_TP10_SRCwick | 4h | 156.8 | 20.9 | 8.01 | 13 | 61.5 | ? | ROBUST |
| 54 | 164032 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP10_SRCwick | 4h | 156.8 | 20.9 | 8.01 | 13 | 61.5 | ? | ROBUST |
| 55 | 163929 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L36_TP7_5_SRCclose | 4h | 156.7 | 20.2 | 4.91 | 15 | 46.7 | ? | ROBUST |
| 56 | 164029 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP7_5_SRCclose | 4h | 156.7 | 20.2 | 4.91 | 15 | 46.7 | ? | ROBUST |
| 57 | 163921 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L24_TP7_5_SRCclose | 4h | 154.2 | 18.2 | 4.88 | 19 | 47.4 | ? | ROBUST |
| 58 | 164021 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP7_5_SRCclose | 4h | 154.2 | 18.2 | 4.88 | 19 | 47.4 | ? | ROBUST |
| 59 | 163494 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L12_TP10_SRCwick | 4h | 146.3 | 18.7 | 2.80 | 36 | 47.2 | ? | ROBUST |
| 60 | 163768 | BERAUSDT | GS3_4H_DD_M_BERAUSDT_4h_L12_TP10_SRCwick | 4h | 146.3 | 18.7 | 2.80 | 36 | 47.2 | ? | ROBUST |
| 61 | 163868 | BERAUSDT | GS3_4H_ZZ_M_BERAUSDT_4h_L12_TP10_SRCwick | 4h | 146.3 | 18.7 | 2.80 | 36 | 47.2 | ? | ROBUST |
| 62 | 163468 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP7_5_SRCwick | 4h | 145.4 | 18.1 | 1.98 | 82 | 37.8 | ? | ROBUST |
| 63 | 163470 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP10_SRCwick | 4h | 145.4 | 18.1 | 1.98 | 82 | 37.8 | ? | ROBUST |
| 64 | 163492 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L12_TP7_5_SRCwick | 4h | 145.3 | 18.7 | 2.79 | 36 | 47.2 | ? | ROBUST |
| 65 | 163766 | BERAUSDT | GS3_4H_DD_M_BERAUSDT_4h_L12_TP7_5_SRCwick | 4h | 145.3 | 18.7 | 2.79 | 36 | 47.2 | ? | ROBUST |
| 66 | 163866 | BERAUSDT | GS3_4H_ZZ_M_BERAUSDT_4h_L12_TP7_5_SRCwick | 4h | 145.3 | 18.7 | 2.79 | 36 | 47.2 | ? | ROBUST |
| 67 | 163914 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L16_TP7_5_SRCwick | 4h | 144.5 | 12.4 | 3.44 | 30 | 46.7 | ? | ROBUST |
| 68 | 164014 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L16_TP7_5_SRCwick | 4h | 144.5 | 12.4 | 3.44 | 30 | 46.7 | ? | ROBUST |
| 69 | 163460 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L5_TP2_SRCwick | 4h | 144.2 | 17.9 | 1.97 | 92 | 39.1 | ? | ROBUST |
| 70 | 163906 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L12_TP7_5_SRCwick | 4h | 144.2 | 13.0 | 3.04 | 34 | 44.1 | ? | ROBUST |
| 71 | 164006 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L12_TP7_5_SRCwick | 4h | 144.2 | 13.0 | 3.04 | 34 | 44.1 | ? | ROBUST |
| 72 | 163927 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L36_TP5_SRCclose | 4h | 144.0 | 15.8 | 4.09 | 19 | 42.1 | ? | ROBUST |
| 73 | 164027 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP5_SRCclose | 4h | 144.0 | 15.8 | 4.09 | 19 | 42.1 | ? | ROBUST |
| 74 | 163924 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L24_TP10_SRCwick | 4h | 143.3 | 20.6 | 4.47 | 20 | 40.0 | ? | ROBUST |
| 75 | 164024 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP10_SRCwick | 4h | 143.3 | 20.6 | 4.47 | 20 | 40.0 | ? | ROBUST |
| 76 | 163923 ★ | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L24_TP10_SRCclose | 4h | 141.8 | 22.9 | 4.57 | 19 | 47.4 | ? | ROBUST |
| 77 | 164023 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP10_SRCclose | 4h | 141.8 | 22.9 | 4.57 | 19 | 47.4 | ? | ROBUST |
| 78 | 163930 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L36_TP7_5_SRCwick | 4h | 140.5 | 18.3 | 4.92 | 15 | 53.3 | ? | ROBUST |
| 79 | 164030 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L36_TP7_5_SRCwick | 4h | 140.5 | 18.3 | 4.92 | 15 | 53.3 | ? | ROBUST |
| 80 | 163911 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L16_TP5_SRCclose | 4h | 140.1 | 16.6 | 2.91 | 32 | 37.5 | ? | ROBUST |
| 81 | 164011 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L16_TP5_SRCclose | 4h | 140.1 | 16.6 | 2.91 | 32 | 37.5 | ? | ROBUST |
| 82 | 163922 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L24_TP7_5_SRCwick | 4h | 136.2 | 18.0 | 3.93 | 21 | 38.1 | ? | ROBUST |
| 83 | 164022 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L24_TP7_5_SRCwick | 4h | 136.2 | 18.0 | 3.93 | 21 | 38.1 | ? | ROBUST |
| 84 | 163913 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L16_TP7_5_SRCclose | 4h | 135.8 | 18.4 | 2.94 | 30 | 40.0 | ? | ROBUST |
| 85 | 164013 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L16_TP7_5_SRCclose | 4h | 135.8 | 18.4 | 2.94 | 30 | 40.0 | ? | ROBUST |
| 86 | 163904 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L12_TP5_SRCwick | 4h | 135.7 | 14.5 | 2.63 | 38 | 42.1 | ? | ROBUST |
| 87 | 164004 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L12_TP5_SRCwick | 4h | 135.7 | 14.5 | 2.63 | 38 | 42.1 | ? | ROBUST |
| 88 | 166406 | ORDIUSDT | GS3_1H_DD_M_ORDIUSDT_1h_L14_TP3_SRCclose | 1h | 133.3 | 7.5 | 5.98 | 41 | 63.4 | ? | ROBUST |
| 89 | 166451 | ORDIUSDT | GS3_1H_ZZ_M_ORDIUSDT_1h_L14_TP3_SRCclose | 1h | 133.3 | 7.5 | 5.98 | 41 | 63.4 | ? | ROBUST |
| 90 | 163912 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L16_TP5_SRCwick | 4h | 133.3 | 15.4 | 2.71 | 34 | 38.2 | ? | ROBUST |
| 91 | 164012 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L16_TP5_SRCwick | 4h | 133.3 | 15.4 | 2.71 | 34 | 38.2 | ? | ROBUST |
| 92 | 163516 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L24_TP7_5_SRCwick | 4h | 133.1 | 26.7 | 2.93 | 21 | 42.9 | ? | HIGH_DD |
| 93 | 163782 | BERAUSDT | GS3_4H_DD_M_BERAUSDT_4h_L24_TP7_5_SRCwick | 4h | 133.1 | 26.7 | 2.93 | 21 | 42.9 | ? | HIGH_DD |
| 94 | 163882 | BERAUSDT | GS3_4H_ZZ_M_BERAUSDT_4h_L24_TP7_5_SRCwick | 4h | 133.1 | 26.7 | 2.93 | 21 | 42.9 | ? | HIGH_DD |
| 95 | 163506 | BERAUSDT | DAILYSWEEP_DD_M_BERAUSDT_4h_L16_TP10_SRCwick | 4h | 131.6 | 21.6 | 2.71 | 29 | 44.8 | ? | ROBUST |
| 96 | 163776 | BERAUSDT | GS3_4H_DD_M_BERAUSDT_4h_L16_TP10_SRCwick | 4h | 131.6 | 21.6 | 2.71 | 29 | 44.8 | ? | ROBUST |
| 97 | 163876 | BERAUSDT | GS3_4H_ZZ_M_BERAUSDT_4h_L16_TP10_SRCwick | 4h | 131.6 | 21.6 | 2.71 | 29 | 44.8 | ? | ROBUST |
| 98 | 163908 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L12_TP10_SRCwick | 4h | 129.4 | 21.4 | 2.85 | 34 | 41.2 | ? | ROBUST |
| 99 | 164008 | IPUSDT | GS3_4H_ZZ_M_IPUSDT_4h_L12_TP10_SRCwick | 4h | 129.4 | 21.4 | 2.85 | 34 | 41.2 | ? | ROBUST |
| 100 | 163909 | IPUSDT | GS3_4H_DD_M_IPUSDT_4h_L16_TP3_SRCclose | 4h | 128.7 | 15.0 | 2.57 | 39 | 35.9 | ? | ROBUST |

## Анализ робастности

| Категория | Кол-во | % от winners |
|-----------|--------|-------------|
| ROBUST (trades≥5, DD≤25%, PF≥1.5) | 541 | 44.7% |
| LOW_TRADES (<5) | 0 | 0.0% |
| HIGH_DD (>25%) | 212 | 17.5% |
| LOW_PF (<1.5) | 556 | 46.0% |

## По типу стратегии

| Тип | Winners | ROBUST | % robust |
|-----|---------|--------|----------|
| DD_BattleToads | 454 | 248 | 55% |
| stat_arb_zscore | 366 | 99 | 27% |
| zz_breakout | 389 | 194 | 50% |

## По таймфрейму

| TF | Winners |
|----|---------|
| 1h | 216 |
| 4h | 890 |
| 5m | 103 |

## Примечание: DD vs ZZ дубликаты

DD_BattleToads и ZZ_Breakout стратегии с одинаковыми параметрами дают **идентичные** результаты (293.78% у обоих ORDI L8 TP5).
Это значит что тип стратегии (DD/ZZ) не влияет на бэктест — фактически уникальных конфигураций вдвое меньше (~600).

Для карточек ТС достаточно брать одну из пары DD/ZZ.

## Предложение по карточкам ТС (с OP)

Так как OP=N означает что из N стратегий в облаке только одна может войти одновременно,
можно включать **несколько стратегий по одному инструменту** — они не будут мешать друг другу.

| Карточка | Инструменты | Стратегий | OP | Идея |
|----------|-------------|-----------|-----|------|
| ORDI-MEGA | ORDI (4h+1h) | 8-10 best | 2 | Топ по ret, два входа одновременно |
| BERA-PACK | BERA (4h) | 6-8 best | 2 | Второй по силе инструмент |
| IP-PACK | IP (4h) | 4-6 best | 1 | Стабильный моно |
| MULTI-TOP | ORDI+BERA+IP+NEAR | 12-16 best | 4 | Диверсифицированный портфель |
| SAFE-YIELD | Low DD, high PF | 8-10 | 3 | Консервативный |
| HIGH-FREQ | High trades count | 8-10 | 4 | Частые сделки |