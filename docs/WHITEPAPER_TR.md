# BTDD Platform — Teknik Rapor v1.0

**Kripto Piyasaları için Hizmet Olarak Algoritmik Ticaret**

*Nisan 2026*

---

## İçindekiler

1. [Yönetici Özeti](#1-yönetici-özeti)
2. [Problem Tanımı](#2-problem-tanımı)
3. [Çözüm Genel Bakış](#3-çözüm-genel-bakış)
4. [Ticaret Motoru ve Stratejiler](#4-ticaret-motoru-ve-stratejiler)
5. [Geriye Dönük Test ve Doğrulama](#5-geriye-dönük-test-ve-doğrulama)
6. [Platform Mimarisi](#6-platform-mimarisi)
7. [Müşteri Modları](#7-müşteri-modları)
8. [Risk Yönetimi](#8-risk-yönetimi)
9. [Borsa Entegrasyonları](#9-borsa-entegrasyonları)
10. [Performans Metrikleri](#10-performans-metrikleri)
11. [Teknoloji Yığını](#11-teknoloji-yığını)
12. [Yol Haritası](#12-yol-haritası)
13. [Ekip ve İletişim](#13-ekip-ve-iletişim)

---

## 1. Yönetici Özeti

BTDD Platform, bireysel yatırımcılar, fon yöneticileri ve kopya tüccarları için portföy düzeyinde kripto para ticaretini otomatikleştiren çok kiracılı algoritmik ticaret SaaS platformudur.

Platform eksiksiz bir boru hattı sunar: **piyasa verisi toplama → parametrik strateji optimizasyonu → sağlamlık filtreleme → portföy oluşturma → canlı yürütme** — kurumsal düzeyde geriye dönük test titizliğiyle tamamen otomatikleştirilmiş.

**Temel sonuçlar (15+ aylık Bybit 4s verilerinde doğrulanmış, Oca 2025 – Mar 2026):**

| Metrik | Değer |
|---|---|
| Tamamlanan geriye dönük testler | 9.108 |
| Sağlam strateji adayları | 3.129 |
| Portföy getirisi | **+%28,7** |
| Kâr Faktörü | **3,28** |
| Maks. Düşüş | **%4,4** |
| Kazanma Oranı | %43,75 (181/416 işlem) |
| Bağlı borsalar | 6 (canlı) |

---

## 2. Problem Tanımı

Bireysel kripto tüccarları artan dezavantajlarla karşı karşıyadır:

- **Duygusal ticaret** kaldıraçlı ürünlerde ortalama %70–90 bireysel kayıp oranlarına yol açar
- **Strateji doğrulama** altyapı gerektirir (veri akışları, geriye dönük test motorları, maliyet modellemesi) ki bireysel tüccarlar bunu kolay oluşturamaz
- **Yürütme disiplini** — kârlı stratejiler bile kaçırılan girişler, erken çıkışlar ve intikam ticareti nedeniyle düşük performans gösterir
- **Çoklu borsa karmaşıklığı** — her borsanın farklı API'leri, komisyon yapıları, emir türleri ve oran limitleri vardır
- **İstatistiksel okuryazarsızlık** — çevrimiçi tanıtılan çoğu "kârlı" strateji geleceğe bakma önyargısı, eğri uydurma veya komisyonsuz geriye dönük testten muzdariptir

Temel problem: **bireysel yatırımcıların kara kutuya güvenmeden titizlikle doğrulanmış algoritmik stratejilere yatırım yapabilecekleri erişilebilir, şeffaf bir platform yoktur.**

---

## 3. Çözüm Genel Bakış

BTDD Platform kurumsal kantitatif ticaret ile bireysel erişilebilirlik arasında köprü kurar:

### 3.1 Şeffaf Geriye Dönük Test
Platformda yayınlanan her performans numarası **doğrulanabilir**:
- Komisyonlar dahil (%0,06 giriş + %0,06 çıkış)
- Kayma modellenmiş (%0,03 alış-satış farkı)
- Geleceğe bakma önyargısı yok — her bar sırayla işlenir
- Parametreden sonuca tam izlenebilirlik

### 3.2 Çoklu Strateji Portföyleri
Tek bir stratejiye bahis yerine, platform farklı piyasalar ve zaman dilimlerinde korelasyonsuz stratejilerden **portföyler** oluşturur, çeşitlendirme yoluyla düşüşü azaltır.

### 3.3 Çok Kiracılı İzolasyon
Her müşteri izole bir ortamda çalışır:
- Özel API anahtar yönetimi
- Müşteri başına risk parametreleri
- Ayrı izleme ve denetim günlükleri
- Müşteriler arası veri sızıntısı yok

### 3.4 Üç Erişim Modu
Platform farklı yatırımcı profillerine üç mod üzerinden hizmet verir: Algofon (yönetilen), Stratejist (kendi kendini yöneten) ve Kopya Ticaret (sosyal).

---

## 4. Ticaret Motoru ve Stratejiler

### 4.1 Strateji Türleri

Platform şu anda üç doğrulanmış strateji ailesini çalıştırmaktadır:

#### DoubleDragon Breakout (DD_BattleToads)
- **Tür:** Trend takipli kırılma
- **Sinyal:** Donchian kanalı kırılması (N-bar yüksek/düşük penetrasyonu)
- **Giriş algılama:** Kapanış bazlı (muhafazakâr) veya Fitil bazlı (agresif)
- **Çıkış — Kâr:** Eşitlik zirvesinden takip eden stop (TP = %2–10)
- **Çıkış — Zarar:** Donchian kanalı merkezi sabit stop-loss olarak
- **Modlar:** Mono (tek varlık) ve Sentetik (çift ticaret)
- **Optimal parametreler:** Uzunluk 12–36 bar, TP %5–7,5, 4s zaman dilimi
- **En iyi koşullar:** Net yönlü impulslarla trend piyasaları

#### ZigZag Breakout (zz_breakout)
- **Tür:** Yapısal kırılma, hızlı varyant
- **Sinyal:** Daha kısa geri bakış dönemleriyle aynı Donchian mekanizması
- **Fark:** Rejim değişikliklerine daha hızlı tepki için uzunluk 5–16 bar
- **Çıkış:** Daha sıkı takip eden TP (%2–5) daha yüksek işlem frekansı
- **Kazanma Oranı:** Sağlam adaylarda %43–51
- **En iyi koşullar:** Yüksek volatiliteli dalgalı piyasalar

#### Statistical Arbitrage Z-Score (stat_arb_zscore)
- **Tür:** Ortalamaya dönüş / istatistiksel arbitraj
- **Sinyal:** Sentetik enstrüman çiftinde Z-skoru sapması
  - **Long Giriş:** Z < −2,0σ (çift düşük değerli)
  - **Short Giriş:** Z > +2,0σ (çift yüksek değerli)
  - **Çıkış (dönüş):** Z ortalamadan ±0,5σ içine döner
  - **Stop (trend kırılması):** Z ±3,5σ'yı aşar (rejim değişikliği)
- **Formül:** `Z = (fiyat − ortalama[120 bar]) / σ`
- **İdeal Çiftler:** Korelasyonlu kripto ekosistemleri — DeFi tokenleri, Layer-2 protokolleri, oracle ağları
- **Örnek çiftler:** ORDI/ZEC, IP/ZEC, GRT/INJ, BERA/ZEC

### 4.2 Piyasa Modları

**Mono Mod** — Tek enstrüman yürütme (BTCUSDT, ETHUSDT, vb.). Standart OHLCV verileri, tekil emir doldurma.

**Sentetik Mod** — İki enstrümanlı çift ticaret. Platform sentetik bir fiyat oluşturur:

$$P_{sentetik} = \frac{\alpha \cdot P_{baz}}{\beta \cdot P_{karşı}}$$

burada α, β dengeleme katsayılarıdır. Yürütme, dengelenmiş nominal ile her iki bacakta paralel emirler gerektirir. Bu mod **piyasa betasını azaltır** ve sinyal durağanlığını artırır — tek coin platformlarında bulunmayan bir avantaj.

---

## 5. Geriye Dönük Test ve Doğrulama

### 5.1 Maliyet Modeli

Her geriye dönük test gerçekçi yürütme maliyetleri içerir:

| Maliyet Bileşeni | Değer |
|---|---|
| Yapıcı/Alıcı komisyonu | Taraf başına %0,06 |
| Kayma (alış-satış farkı modeli) | %0,03 |
| Fonlama oranı | Kaldıraçlıysa bar başına tahakkuk |
| **Toplam gidiş-dönüş maliyeti** | **~%0,15** |

### 5.2 Tarihsel Tarama (9.108 Varyant)

| Strateji | Parametre Izgarası | Piyasa Başına Varyant |
|---|---|---|
| DoubleDragon | uzunluk[5,8,12,16,24,36] × TP[%2–10] × kaynak[kapanış,fitil] | 72 |
| ZigZag | uzunluk[5,8,12,16] × TP[%2–5] × kaynak[kapanış,fitil] | 48 |
| StatArb | uzunluk[24–120] × ZE[1,25–2,25] × ZX[0,5–1,0] × ZS[2,5–3,5] | 270 |

12 mono piyasa + N² sentetik çift üzerinde 4s Bybit tarihsel verilerle uygulanmıştır (Oca 2025 – Mar 2026).

### 5.3 Sağlamlık Filtresi

Bir strateji adayı ancak TÜM kriterler karşılanırsa sağlamlık filtresini geçer:

- **Kâr Faktörü ≥ 1,15**
- **Maks. Düşüş ≤ %22**
- **İşlem Sayısı ≥ 40** (istatistiksel anlamlılık eşiği)

**Sonuç:** 9.108 varyanttan 3.129'u geçti (%34,4 geçme oranı).

---

## 6. Platform Mimarisi

### 6.1 Üç Devreli İzolasyon

```
┌─────────────────────────────────────────────────────┐
│                    BTDD Platform                     │
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ RUNTIME  │  │ RESEARCH  │  │  PRODUCTION/SaaS │  │
│  │ Devre    │  │ Devre     │  │     Devre         │  │
│  │          │  │           │  │                   │  │
│  │runtime.db│  │research.db│  │     main.db       │  │
│  │          │  │           │  │                   │  │
│  │• Yürütme │  │• G.D.Test │  │• Kiracı yönet.  │  │
│  │• İzleme  │  │• Tarama   │  │• Abonelikler    │  │
│  │• Risk    │  │• Optimiz. │  │• Müşteri katalog│  │
│  │• Ticaret │  │• Yayınla  │  │• RBAC & kimlik  │  │
│  └──────────┘  └───────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**Runtime Devre** sıfır kesinti garantisiyle canlı ticaret yürütmesini yönetir. İzole bir systemd servisi olarak çalışır.

**Research Devre** geriye dönük testi, parametrik taramaları ve strateji optimizasyonunu yönetir.

**Production Devre** çok kiracılı SaaS katmanına hizmet eder — kiracı yönetimi, abonelik faturalandırma, müşteri katalogları ve rol tabanlı erişim kontrolü.

---

## 7. Müşteri Modları

### 7.1 Algofon (Yönetilen Hesap)

Yatırımcılar için en basit giriş noktası. Müşteri borsa API anahtarını bağlar (sadece ticaret, **çekim izni yok**) — fonlar her zaman müşterinin kendi borsa hesabında kalır. Platform otomatik olarak işlem yapar, pasif gelir üretir.

- **Temel ilke:** Paranız asla borsanızdan ayrılmaz. Basit, güvenli API bağlantısı.
- **Tarifeler:** Depozito katmanına bağlı olarak 20–200 USDT/ay
- **Risk aralığı:** 0–2,5× (müşteri tarafından ayarlanabilir)

### 7.2 Stratejist (Kendi Kendini Yöneten)

Daha derine inmek isteyenler için:

- **Kolay kurulum:** API anahtarı bağlayın, katalogdan stratejiler seçin ve birkaç tıklamayla kendi ticaret sisteminizi oluşturun
- **İki kaydırıcı:** Risk seviyesi (1–5) × İşlem frekansı (1–5) → optimize edilmiş ön ayara haritalanır
- **Eşitlik önizleme:** Canlıya geçmeden önce seçilen yapılandırma için geriye dönük test sonuçları
- **Tarifeler:** 15–100 USDT/ay, maks. depozito 1.000–10.000 USDT

### 7.3 Kopya Ticaret (Sosyal)

1 API anahtarı — ve birden fazla kopyalanan hesap. Kendi kurulumunuzla işlem yapın — arkadaşlarınızla paylaşın. Borsalardaki gibi ekstra zahmet yok.

- **Otomatik ölçekleme:** Pozisyon boyutlarını kopyalayıcının depozitosuna orantılı olarak ayarlar
- **Bağımsız risk kontrolü:** Kopyalayıcı kendi risk limitlerini belirleyebilir
- **Şeffaflık:** Sinyal kaynağının performans geçmişine tam görünürlük

---

## 8. Risk Yönetimi

| Parametre | Açıklama | Tipik Aralık |
|---|---|---|
| `lot_percent` | Bakiyenin %'si olarak pozisyon boyutu | %3–15 |
| `leverage` | Borsa marjin kaldıracı | 1–10× |
| `margin_type` | Cross veya İzole marjin | Strateji başına |
| `max_deposit` | Strateji başına maksimum sermaye | 500–5.000 USDT |
| `emergency_stop_dd` | Otomatik durdurma DD eşiği | %15–25 |

---

## 9. Borsa Entegrasyonları

| Borsa | Entegrasyon | Durum | Notlar |
|---|---|---|---|
| **Bybit** | Native (RestClientV5) | ✅ Canlı Birincil | Tam özellik desteği |
| **Binance** | ccxt + native uzantılar | ✅ Canlı | USDt-M Vadeli |
| **Bitget** | ccxt | ✅ Canlı | USDT-M Sözleşmeler |
| **BingX** | ccxt | ✅ Canlı | Standart sözleşmeler |
| **MEXC** | ccxt | ✅ Canlı | USDT-M Vadeli |
| **Weex** | Native istemci | ✅ Canlı | Özel bağlayıcı |

---

## 10. Performans Metrikleri

| Metrik | Değer |
|---|---|
| Ölçüm dönemi | Oca 2025 – Mar 2026 (15 ay) |
| Zaman dilimi | 4s barlar |
| Veri kaynağı | Bybit tarihsel OHLCV |
| Toplam geriye dönük testler | 9.108 |
| Sağlam adaylar | 3.129 (%34,4) |
| **Portföy getirisi** | **+%28,7** |
| **Kâr Faktörü** | **3,28** |
| **Maks. Düşüş** | **%4,4** |
| Kazanma Oranı | %43,75 |
| Toplam işlemler | 416 |
| **Getiri / MaksDüşüş oranı** | **6,5:1** |

---

## 11. Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| Backend runtime | Node.js 20, TypeScript, Express |
| Veritabanı | SQLite (3 izole veritabanı) |
| Frontend | React 18, Ant Design 5, TypeScript |
| Grafikler | Lightweight Charts (TradingView) |
| Exchange SDK | Bybit RestClientV5 (native), ccxt (çoklu borsa) |
| Süreç yönetimi | systemd (3 servis: api, runtime, research) |
| Ters proxy | nginx |
| SSL/CDN | Cloudflare Tunnel |
| Yerelleştirme | RU / EN / TR |

---

## 12. Yol Haritası

### Faz 1 — Mevcut (Q1 2026) ✅
- ✅ 3 strateji türüyle Canlı MVP
- ✅ 9.108 geriye dönük test taraması tamamlandı
- ✅ 6 borsa entegrasyonu
- ✅ 3 müşteri moduyla çok kiracılı SaaS
- ✅ Yönetici paneli + müşteri kabini

### Faz 2 — Büyüme (Q2 2026)
- Walk-forward örneklem dışı doğrulama
- İşlem ve uyarılar için Telegram bot bildirimleri
- Otomatik KYC-light ile onboarding hunisi
- OKX borsa entegrasyonu
- Kripto ödeme entegrasyonu

### Faz 3 — Ölçeklendirme (Q3–Q4 2026)
- Yatay ölçekleme için Redis tabanlı olay kuyruğu
- Ayrı yürütme ve araştırma VPS örnekleri
- Mobil duyarlı müşteri panosu
- Kurumsal API erişim katmanı

### Faz 4 — Ekosistem (2027)
- Stratejist müşteriler TS'lerini kopya ticarete yayınlayabilir (pazaryeri)
- DEX entegrasyonu (on-chain yürütme)
- Sosyal ticaret lider tablosu

---

## 13. Ekip ve İletişim

**Kurucu & CTO:** Aleksei Lazarev
- 5+ yıl algoritmik ticaret sistemleri geliştirme
- Node.js / TypeScript uzmanı
- Kripto türev piyasası deneyimi

**İletişim:**
- **Email:** aiaetrade17@gmail.com
- **Telegram:** @yakovbyakov
- **GitHub:** Özel depo (due diligence için talep üzerine erişilebilir)

---

## Sorumluluk Reddi

Geçmiş performans gelecekteki sonuçları garanti etmez. Sunulan tüm metrikler simüle edilmiş yürütme maliyetleriyle tarihsel geriye dönük teste dayanmaktadır. Canlı ticaret ek riskler içerir: borsa kesintisi, API oran limitleri, likidite boşlukları, düzenleyici değişiklikler ve siyah kuğu olayları. Yalnızca kaybetmeyi göze alabileceğiniz sermayeyle yatırım yapın. BTDD Platform finansal tavsiye sağlamaz.

---

*BTDD Platform Teknik Rapor v1.0 — Nisan 2026*
*© 2026 BTDD Platform. Tüm hakları saklıdır.*
