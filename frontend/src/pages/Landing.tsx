import React from 'react';
import { Button, Space, Tag, Typography, Divider } from 'antd';
import {
  RocketOutlined,
  ThunderboltOutlined,
  LineChartOutlined,
  SafetyCertificateOutlined,
  ApiOutlined,
  TeamOutlined,
  TrophyOutlined,
  ArrowRightOutlined,
  BarChartOutlined,
  BulbOutlined,
  GlobalOutlined,
  CopyOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import { useI18n, UILanguage } from '../i18n';

const { Title, Paragraph, Text } = Typography;

/* ─── Localised content per language ─── */
function useLandingTexts(lang: UILanguage) {
  const t: Record<UILanguage, Record<string, any>> = {
    ru: {
      heroTitle1: 'Алгоритмическая торговля',
      heroTitle2: 'как сервис',
      heroSub: 'Полноценная SaaS-платформа для автоматической торговли на криптобиржах. Три типа стратегий, 9 108 бектестов, robustness-фильтрация и мульти-тенантная архитектура. Bybit, Binance, Bitget, BingX, MEXC, Weex — всё подключено.',
      btnStart: 'Начать работу',
      btnLogin: 'Войти',
      tagExchanges: '6 бирж · All Live',
      tagTimeframe: 'Мульти таймфрейм',
      tagClassicArb: 'классика + арбитраж ⓘ',
      tagClassicArbTip: 'Классика — торговля одним инструментом. Арбитраж — синтетические пары из двух активов для снижения рыночного риска.',
      metrics: [
        { value: '9 108', label: 'бектестов прогнано', sub: 'исторический sweep' },
        { value: '3 129', label: 'робастных кандидатов', sub: 'прошли robustness-фильтр' },
        { value: '+28.7%', label: 'средняя доходность', sub: 'по площадке, 2025–2026' },
        { value: '3.28', label: 'Profit Factor', sub: 'средний по портфелям' },
        { value: '4.4%', label: 'макс. просадка', sub: 'портфельная DD' },
        { value: '6 бирж', label: 'подключено', sub: 'Bybit · Binance · Bitget + ещё' },
      ],
      modesTitle: 'Три режима для клиентов',
      modesSub: 'От пассивного дохода до полного контроля — выберите свой стиль',
      modePopular: 'Популярный',
      modes: [
        { title: 'Алгофонд', desc: 'Простое безопасное API-подключение — средства всегда остаются на вашей бирже. Никаких переводов. Подключаете ключ, платформа торгует за вас. Пассивный доход без лишней сложности.' },
        { title: 'Стратег', desc: 'Для тех кто хочет разобраться глубже. Подключите API-ключ, выберите отдельные стратегии из каталога и соберите собственную торговую систему в пару кликов.' },
        { title: 'Копитрейдинг', desc: '1 API‑ключ — и несколько копируемых аккаунтов. Торгуете своим софтом — поделитесь с друзьями. Без лишней мороки как на биржах.' },
      ],
      stratTitle: 'Стратегии',
      stratSub: '3 типа алгоритмов, отобранных из\u00a09108 бектестов с\u00a0robustness-фильтрацией',
      strats: [
        { desc: 'Пробой канала Дончиана с трейлинговым TP. Работает на mono и synthetic парах. Ловит направленный импульс и удерживает тренд.', tags: ['классика', 'арбитраж', 'trend-following'] },
        { desc: 'Возврат к среднему по Z-счёту на синтетическом инструменте. Торгует схождение/расхождение двух связанных активов.', tags: ['арбитраж', 'mean-reversion', 'stat-arb'] },
        { desc: 'Структурный пробой с Дончианом. Оптимален при смене рыночного режима и резких направленных движениях.', tags: ['классика', 'арбитраж', 'breakout'] },
      ],
      archTitle: 'Трёхконтурная архитектура',
      archSub: 'Runtime не зависит от Research. Research не влияет на клиентов. Каждый контур изолирован.',
      circuits: [
        { desc: 'Изолированный торговый контур. Нулевой даунтайм. Стратегии исполняются в отдельном сервисе — перезапуск API не влияет на торговлю.' },
        { desc: 'Backtesting, исторический sweep по 9108+ вариантам, cart. product оптимизация, checkpoint/resume при долгих прогонах. Out-of-sample валидация кандидатов.' },
        { desc: 'SaaS multi-tenant. Изоляция клиентов по api_key. Каталог офферов, тарифные лимиты, планы, мониторинг позиций. 3 режима: Strategy Client / Algofund / Custom.' },
      ],
      proofTitle: 'Доказанная методология',
      proofSub: 'Средние показатели по площадке на основе 9 108 бектестов, 2025–2026',
      proofRows: [
        { label: 'Типов стратегий', value: '3', note: 'DD + ZZ + StatArb' },
        { label: 'Период', value: '15+ мес', note: 'мульти ТФ, 2025–2026' },
        { label: 'Ср. доходность', value: '+28.7%', note: 'по портфелям площадки' },
        { label: 'Profit Factor', value: '3.28', note: '>3.0 = превосходно' },
        { label: 'Max Drawdown', value: '4.4%', note: 'портфельная' },
        { label: 'Сделок', value: '416', note: 'Win Rate 43.75%' },
      ],
      proofDisclaimer: '* Исторический бэктест на данных Bybit, 4h таймфрейм, с учётом комиссий 0.1% и проскальзывания 0.05%. Прошлые результаты не гарантируют будущую доходность.',
      exchTitle: 'Биржевые интеграции',
      exchSub: '6 бирж подключено прямо сейчас. Bybit — основной коннектор, остальные через ccxt / native.',
      exchReg: 'Регистрация →',
      ctaTitle: 'Готовы начать?',
      ctaSub: 'Зарегистрируйтесь как клиент, подключите API-ключ биржи и запустите первую стратегию за несколько минут. Или обратитесь для подключения по модели Алгофонда.',
      ctaBtn: 'Зарегистрироваться',
      ctaTg: 'Telegram для связи',
      footerLogin: 'Клиентский вход',
      footerRegister: 'Регистрация',
      footerAdmin: 'Администратор',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Торговля криптовалютой сопряжена с рисками. Исторические результаты не гарантируют будущую доходность.',
    },
    en: {
      heroTitle1: 'Algorithmic Trading',
      heroTitle2: 'as a Service',
      heroSub: 'Full-featured SaaS platform for automated crypto trading. Three strategy types, 9,108 backtests, robustness filtering and multi-tenant architecture. Bybit, Binance, Bitget, BingX, MEXC, Weex — all connected.',
      btnStart: 'Get Started',
      btnLogin: 'Log In',
      tagExchanges: '6 Exchanges · All Live',
      tagTimeframe: 'Multi Timeframe',
      tagClassicArb: 'classic + arbitrage ⓘ',
      tagClassicArbTip: 'Classic — single-instrument trading. Arbitrage — synthetic pairs of two assets to reduce market risk.',
      metrics: [
        { value: '9,108', label: 'backtests run', sub: 'historical sweep' },
        { value: '3,129', label: 'robust candidates', sub: 'passed robustness filter' },
        { value: '+28.7%', label: 'avg. return', sub: 'platform-wide, 2025–2026' },
        { value: '3.28', label: 'Profit Factor', sub: 'avg. across portfolios' },
        { value: '4.4%', label: 'max drawdown', sub: 'portfolio DD' },
        { value: '6 exchanges', label: 'connected', sub: 'Bybit · Binance · Bitget + more' },
      ],
      modesTitle: 'Three Client Modes',
      modesSub: 'From passive income to full control — choose your style',
      modePopular: 'Popular',
      modes: [
        { title: 'Algofund', desc: 'Simple secure API connection — funds always stay on your exchange. No transfers. Connect your key, the platform trades for you. Passive income without extra complexity.' },
        { title: 'Strategist', desc: 'For those who want to dive deeper. Connect an API key, pick individual strategies from the catalog and build your own trading system in a few clicks.' },
        { title: 'Copy Trading', desc: '1 API key — and multiple copied accounts. Trade with your own setup — share with friends. No extra hassle like on exchanges.' },
      ],
      stratTitle: 'Strategies',
      stratSub: '3 algorithm types selected from 9,108 backtests with robustness filtering',
      strats: [
        { desc: 'Donchian channel breakout with trailing TP. Works on mono and synthetic pairs. Catches directional momentum and rides the trend.', tags: ['classic', 'arbitrage', 'trend-following'] },
        { desc: 'Mean reversion by Z-score on a synthetic instrument. Trades convergence/divergence of two related assets.', tags: ['arbitrage', 'mean-reversion', 'stat-arb'] },
        { desc: 'Structural breakout with Donchian. Optimal during regime shifts and sharp directional moves.', tags: ['classic', 'arbitrage', 'breakout'] },
      ],
      archTitle: 'Three-Circuit Architecture',
      archSub: 'Runtime is independent of Research. Research doesn\'t affect clients. Each circuit is isolated.',
      circuits: [
        { desc: 'Isolated trading circuit. Zero downtime. Strategies execute in a separate service — API restarts don\'t affect trading.' },
        { desc: 'Backtesting, historical sweep across 9,108+ variants, Cartesian product optimization, checkpoint/resume for long runs. Out-of-sample candidate validation.' },
        { desc: 'SaaS multi-tenant. Client isolation by api_key. Offer catalog, tariff limits, plans, position monitoring. 3 modes: Strategy Client / Algofund / Custom.' },
      ],
      proofTitle: 'Proven Methodology',
      proofSub: 'Platform-wide averages based on 9,108 backtests, 2025–2026',
      proofRows: [
        { label: 'Strategy types', value: '3', note: 'DD + ZZ + StatArb' },
        { label: 'Period', value: '15+ mo', note: 'multi TF, 2025–2026' },
        { label: 'Avg. return', value: '+28.7%', note: 'across platform portfolios' },
        { label: 'Profit Factor', value: '3.28', note: '>3.0 = excellent' },
        { label: 'Max Drawdown', value: '4.4%', note: 'portfolio-level' },
        { label: 'Trades', value: '416', note: 'Win Rate 43.75%' },
      ],
      proofDisclaimer: '* Historical backtest on Bybit data, 4h timeframe, accounting for 0.1% fees and 0.05% slippage. Past results do not guarantee future performance.',
      exchTitle: 'Exchange Integrations',
      exchSub: '6 exchanges connected right now. Bybit — primary connector, others via ccxt / native.',
      exchReg: 'Register →',
      ctaTitle: 'Ready to Start?',
      ctaSub: 'Register as a client, connect your exchange API key and launch your first strategy in minutes. Or contact us for Algofund-style connection.',
      ctaBtn: 'Register',
      ctaTg: 'Telegram Contact',
      footerLogin: 'Client Login',
      footerRegister: 'Register',
      footerAdmin: 'Admin',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Cryptocurrency trading involves risks. Historical results do not guarantee future performance.',
    },
    tr: {
      heroTitle1: 'Algoritmik Ticaret',
      heroTitle2: 'Hizmet Olarak',
      heroSub: 'Otomatik kripto ticareti için tam özellikli SaaS platformu. Üç strateji türü, 9.108 geriye dönük test, sağlamlık filtreleme ve çok kiracılı mimari. Bybit, Binance, Bitget, BingX, MEXC, Weex — hepsi bağlı.',
      btnStart: 'Başlayın',
      btnLogin: 'Giriş Yap',
      tagExchanges: '6 Borsa · Hepsi Canlı',
      tagTimeframe: 'Çoklu Zaman Dilimi',
      tagClassicArb: 'klasik + arbitraj ⓘ',
      tagClassicArbTip: 'Klasik — tek enstrüman ticareti. Arbitraj — piyasa riskini azaltmak için iki varlıktan oluşan sentetik çiftler.',
      metrics: [
        { value: '9.108', label: 'geriye dönük test', sub: 'tarihsel tarama' },
        { value: '3.129', label: 'sağlam aday', sub: 'sağlamlık filtresini geçti' },
        { value: '+%28,7', label: 'ort. getiri', sub: 'platform geneli, 2025–2026' },
        { value: '3,28', label: 'Kâr Faktörü', sub: 'portföyler arası ort.' },
        { value: '%4,4', label: 'maks. düşüş', sub: 'portföy DD' },
        { value: '6 borsa', label: 'bağlı', sub: 'Bybit · Binance · Bitget + diğer' },
      ],
      modesTitle: 'Üç Müşteri Modu',
      modesSub: 'Pasif gelirden tam kontrole — tarzınızı seçin',
      modePopular: 'Popüler',
      modes: [
        { title: 'Algofon', desc: 'Basit ve güvenli API bağlantısı — fonlarınız her zaman borsanızda kalır. Transfer yok. Anahtarınızı bağlayın, platform sizin için işlem yapar. Karmaşıklık olmadan pasif gelir.' },
        { title: 'Stratejist', desc: 'Daha derine inmek isteyenler için. API anahtarı bağlayın, katalogdan stratejiler seçin ve birkaç tıklamayla kendi ticaret sisteminizi oluşturun.' },
        { title: 'Kopya Ticaret', desc: '1 API anahtarı — ve birden fazla kopyalanan hesap. Kendi kurulumunuzla işlem yapın — arkadaşlarınızla paylaşın. Borsalardaki gibi ekstra zahmet yok.' },
      ],
      stratTitle: 'Stratejiler',
      stratSub: 'Sağlamlık filtrelemesiyle 9.108 geriye dönük testten seçilen 3 algoritma türü',
      strats: [
        { desc: 'Takip eden TP ile Donchian kanal kırılması. Mono ve sentetik çiftlerde çalışır. Yönlü momentumu yakalar ve trendi sürdürür.', tags: ['klasik', 'arbitraj', 'trend-following'] },
        { desc: 'Sentetik enstrümanda Z-skoru ile ortalamaya dönüş. İki ilişkili varlığın yakınsama/uzaklaşmasını işlem yapar.', tags: ['arbitraj', 'mean-reversion', 'stat-arb'] },
        { desc: 'Donchian ile yapısal kırılma. Rejim değişikliklerinde ve keskin yönlü hareketlerde optimal.', tags: ['klasik', 'arbitraj', 'breakout'] },
      ],
      archTitle: 'Üç Devreli Mimari',
      archSub: 'Runtime, Research\'ten bağımsızdır. Research müşterileri etkilemez. Her devre izoledir.',
      circuits: [
        { desc: 'İzole ticaret devresi. Sıfır kesinti. Stratejiler ayrı bir serviste çalışır — API yeniden başlatmaları ticareti etkilemez.' },
        { desc: 'Geriye dönük test, 9.108+ varyant üzerinde tarihsel tarama, kartezyen çarpım optimizasyonu, uzun çalışmalar için kontrol noktası/devam. Örneklem dışı aday doğrulama.' },
        { desc: 'SaaS çok kiracılı. api_key ile müşteri izolasyonu. Teklif katalogu, tarife limitleri, planlar, pozisyon izleme. 3 mod: Strateji Müşterisi / Algofon / Özel.' },
      ],
      proofTitle: 'Kanıtlanmış Metodoloji',
      proofSub: '9.108 geriye dönük teste dayalı platform geneli ortalamaları, 2025–2026',
      proofRows: [
        { label: 'Strateji türü', value: '3', note: 'DD + ZZ + StatArb' },
        { label: 'Dönem', value: '15+ ay', note: 'çoklu TF, 2025–2026' },
        { label: 'Ort. getiri', value: '+%28,7', note: 'platform portföyleri genelinde' },
        { label: 'Kâr Faktörü', value: '3,28', note: '>3,0 = mükemmel' },
        { label: 'Maks. Düşüş', value: '%4,4', note: 'portföy düzeyinde' },
        { label: 'İşlemler', value: '416', note: 'Kazanma Oranı %43,75' },
      ],
      proofDisclaimer: '* Bybit verilerinde tarihsel geriye dönük test, 4s zaman dilimi, %0,1 komisyon ve %0,05 kayma dahil. Geçmiş sonuçlar gelecekteki performansı garanti etmez.',
      exchTitle: 'Borsa Entegrasyonları',
      exchSub: 'Şu anda 6 borsa bağlı. Bybit — ana bağlayıcı, diğerleri ccxt / native üzerinden.',
      exchReg: 'Kayıt Ol →',
      ctaTitle: 'Başlamaya Hazır mısınız?',
      ctaSub: 'Müşteri olarak kaydolun, borsa API anahtarınızı bağlayın ve ilk stratejinizi dakikalar içinde başlatın. Veya Algofon modeli ile bağlantı için bize ulaşın.',
      ctaBtn: 'Kayıt Ol',
      ctaTg: 'Telegram İletişim',
      footerLogin: 'Müşteri Girişi',
      footerRegister: 'Kayıt Ol',
      footerAdmin: 'Yönetici',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Kripto para ticareti risk içerir. Geçmiş sonuçlar gelecekteki performansı garanti etmez.',
    },
  };
  return t[lang] || t.en;
}

const STRATEGY_META = [
  { icon: <ThunderboltOutlined style={{ fontSize: 28, color: '#f5a623' }} />, name: 'DoubleDragon Breakout', code: 'DD_BattleToads' },
  { icon: <LineChartOutlined style={{ fontSize: 28, color: '#52c41a' }} />, name: 'StatArb Z-Score', code: 'stat_arb_zscore' },
  { icon: <BarChartOutlined style={{ fontSize: 28, color: '#1677ff' }} />, name: 'ZigZag Breakout', code: 'zz_breakout' },
];

const MODE_META = [
  { icon: <TeamOutlined style={{ fontSize: 32, color: '#1677ff' }} />, highlight: true },
  { icon: <RocketOutlined style={{ fontSize: 32, color: '#52c41a' }} />, highlight: false },
  { icon: <CopyOutlined style={{ fontSize: 32, color: '#f5a623' }} />, highlight: false },
];

const CIRCUIT_META = [
  { color: '#ff4d4f', icon: <ThunderboltOutlined />, title: 'Runtime Circuit' },
  { color: '#1677ff', icon: <BarChartOutlined />, title: 'Research Circuit' },
  { color: '#52c41a', icon: <TeamOutlined />, title: 'Client Circuit' },
];

const EXCHANGES = [
  { name: 'Bybit', status: 'live', note: 'primary', ref: 'https://www.bybit.com/invite?ref=P2GAX' },
  { name: 'Binance', status: 'live', note: 'ccxt', ref: 'https://www.binance.com/referral/earn-together/refer2earn-usdc/claim?hl=ru&ref=GRO_28502_9VNRB&utm_source=referral_entrance' },
  { name: 'Bitget', status: 'live', note: 'ccxt', ref: 'https://partner.bitget.com/bg/VJ90ZR' },
  { name: 'BingX', status: 'live', note: 'ccxt', ref: 'https://bingxdao.com/invite/AD0H6D/' },
  { name: 'MEXC', status: 'live', note: 'native', ref: 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12A4vC' },
  { name: 'Weex', status: 'live', note: 'native', ref: 'https://www.weex.com/register?ref=BTDD' },
];

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: '#0a0a0f',
    minHeight: '100vh',
    color: '#fff',
    fontFamily: "'Inter', 'Segoe UI', sans-serif",
    overflowX: 'hidden',
  },
  hero: {
    background: 'linear-gradient(135deg, #0a0a0f 0%, #0d1a2e 50%, #0a0a0f 100%)',
    padding: '80px 24px 60px',
    textAlign: 'center',
    position: 'relative',
  },
  heroBadge: {
    display: 'inline-block',
    background: 'rgba(22,119,255,0.15)',
    border: '1px solid rgba(22,119,255,0.4)',
    borderRadius: 20,
    padding: '6px 18px',
    fontSize: 13,
    color: '#4096ff',
    marginBottom: 24,
    letterSpacing: '0.05em',
  },
  heroTitle: {
    fontSize: 'clamp(32px, 6vw, 64px)',
    fontWeight: 800,
    lineHeight: 1.15,
    margin: '0 0 16px',
    background: 'linear-gradient(135deg, #ffffff 0%, #a0c4ff 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  },
  heroSub: {
    fontSize: 'clamp(16px, 2.5vw, 22px)',
    color: '#8899aa',
    maxWidth: 680,
    margin: '0 auto 36px',
    lineHeight: 1.6,
  },
  metricsStrip: {
    background: 'rgba(22,119,255,0.05)',
    borderTop: '1px solid rgba(22,119,255,0.15)',
    borderBottom: '1px solid rgba(22,119,255,0.15)',
    padding: '32px 24px',
    display: 'flex',
    flexWrap: 'wrap' as const,
    justifyContent: 'center',
    gap: 0,
  },
  metricItem: {
    textAlign: 'center',
    padding: '12px 28px',
    borderRight: '1px solid rgba(255,255,255,0.06)',
  },
  metricValue: {
    fontSize: 'clamp(24px, 4vw, 40px)',
    fontWeight: 800,
    color: '#4096ff',
    lineHeight: 1.1,
  },
  metricLabel: {
    fontSize: 13,
    color: '#aab4c0',
    marginTop: 4,
    lineHeight: 1.3,
  },
  metricSub: {
    fontSize: 11,
    color: '#556677',
    marginTop: 2,
  },
  section: {
    padding: '64px 24px',
    maxWidth: 1100,
    margin: '0 auto',
  },
  sectionTitle: {
    fontSize: 'clamp(22px, 3.5vw, 36px)',
    fontWeight: 700,
    color: '#fff',
    textAlign: 'center',
    marginBottom: 8,
  },
  sectionSub: {
    textAlign: 'center',
    color: '#778899',
    fontSize: 16,
    marginBottom: 48,
  },
  card: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: '28px 24px',
    flex: '1 1 280px',
    transition: 'border-color 0.2s, transform 0.2s',
  },
  cardHighlight: {
    background: 'rgba(22,119,255,0.07)',
    border: '1px solid rgba(22,119,255,0.35)',
    borderRadius: 16,
    padding: '28px 24px',
    flex: '1 1 280px',
  },
  stratCard: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 16,
    padding: '28px 24px',
    flex: '1 1 260px',
  },
  circuitCard: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.07)',
    borderRadius: 16,
    padding: '28px 24px',
    flex: '1 1 260px',
  },
  darkBg: {
    background: 'rgba(0,0,0,0.3)',
    borderTop: '1px solid rgba(255,255,255,0.05)',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    padding: '64px 24px',
  },
  ctaSection: {
    background: 'linear-gradient(135deg, #0d1a2e 0%, #0a0a0f 100%)',
    padding: '80px 24px',
    textAlign: 'center',
    borderTop: '1px solid rgba(22,119,255,0.2)',
  },
  footer: {
    background: '#050508',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    padding: '32px 24px',
    textAlign: 'center',
    color: '#445566',
    fontSize: 13,
  },
};

export default function Landing() {
  const { language, setLanguage } = useI18n();
  const tx = useLandingTexts(language);

  return (
    <div style={styles.page}>
      {/* ─── LANG SWITCHER ─── */}
      <div style={{ position: 'absolute', top: 16, right: 24, zIndex: 10, display: 'flex', gap: 8 }}>
        {(['ru', 'en', 'tr'] as UILanguage[]).map((lng) => (
          <button
            key={lng}
            onClick={() => setLanguage(lng)}
            style={{
              background: language === lng ? 'rgba(22,119,255,0.3)' : 'rgba(255,255,255,0.06)',
              border: language === lng ? '1px solid #4096ff' : '1px solid rgba(255,255,255,0.12)',
              color: language === lng ? '#4096ff' : '#778899',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: language === lng ? 700 : 400,
            }}
          >
            {lng.toUpperCase()}
          </button>
        ))}
      </div>

      {/* ─── HERO ─── */}
      <section style={styles.hero}>
        <div style={styles.heroBadge}>
          <ApiOutlined style={{ marginRight: 6 }} />
          Algorithmic Trading SaaS · v2.0 · Alpha
        </div>
        <h1 style={styles.heroTitle}>
          BTDD Platform
          <br />
          {tx.heroTitle1}
          <br />
          {tx.heroTitle2}
        </h1>
        <p style={styles.heroSub}>{tx.heroSub}</p>
        <Space size={16} wrap style={{ justifyContent: 'center' }}>
          <Button
            type="primary"
            size="large"
            icon={<RocketOutlined />}
            href="/client/register"
            style={{ height: 48, paddingInline: 28, fontSize: 16, borderRadius: 10 }}
          >
            {tx.btnStart}
          </Button>
          <Button
            size="large"
            href="/client/login"
            style={{
              height: 48,
              paddingInline: 28,
              fontSize: 16,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#fff',
            }}
          >
            {tx.btnLogin} <ArrowRightOutlined />
          </Button>
          <Button
            size="large"
            icon={<FileTextOutlined />}
            href="/whitepaper"
            style={{
              height: 48,
              paddingInline: 28,
              fontSize: 16,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#8899aa',
            }}
          >
            Whitepaper
          </Button>
        </Space>
        <div style={{ marginTop: 20 }}>
          <Tag color="green" style={{ fontSize: 12 }}>{tx.tagExchanges}</Tag>
          <Tag color="default" style={{ fontSize: 12 }}>{tx.tagTimeframe}</Tag>
          <Tag color="default" style={{ fontSize: 12, cursor: 'help' }} title={tx.tagClassicArbTip}>{tx.tagClassicArb}</Tag>
          <Tag color="blue" style={{ fontSize: 12 }}>Multi-tenant SaaS</Tag>
        </div>
      </section>

      {/* ─── METRICS STRIP ─── */}
      <div style={styles.metricsStrip}>
        {tx.metrics.map((m: any, i: number) => (
          <div
            key={i}
            style={{
              ...styles.metricItem,
              borderRight: i < tx.metrics.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
            }}
          >
            <div style={styles.metricValue}>{m.value}</div>
            <div style={styles.metricLabel}>{m.label}</div>
            <div style={styles.metricSub}>{m.sub}</div>
          </div>
        ))}
      </div>

      {/* ─── 3 CLIENT MODES ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>{tx.modesTitle}</div>
        <div style={styles.sectionSub}>{tx.modesSub}</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {MODE_META.map((m, i) => (
            <div key={i} style={m.highlight ? styles.cardHighlight : styles.card}>
              <div style={{ marginBottom: 12 }}>{m.icon}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 10 }}>
                {tx.modes[i].title}
                {m.highlight && (
                  <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>{tx.modePopular}</Tag>
                )}
              </div>
              <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6 }}>{tx.modes[i].desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── 3 STRATEGIES ─── */}
      <div style={styles.darkBg}>
        <div style={{ ...styles.section, padding: '0 24px' }}>
          <div style={styles.sectionTitle}>{tx.stratTitle}</div>
          <div style={styles.sectionSub}>{tx.stratSub}</div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {STRATEGY_META.map((s, i) => (
              <div key={s.code} style={styles.stratCard}>
                <div style={{ marginBottom: 12 }}>{s.icon}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{s.name}</div>
                <code style={{ fontSize: 11, color: '#556677', background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: 4 }}>
                  {s.code}
                </code>
                <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6, marginTop: 12 }}>{tx.strats[i].desc}</div>
                <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {tx.strats[i].tags.map((tag: string) => (
                    <Tag key={tag} style={{ fontSize: 11, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#aab4c0' }}>
                      {tag}
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── ARCHITECTURE 3-CIRCUIT ─── */}
      <div style={styles.section}>
        <div style={styles.sectionTitle}>
          <BulbOutlined style={{ marginRight: 10, color: '#f5a623' }} />
          {tx.archTitle}
        </div>
        <div style={styles.sectionSub}>{tx.archSub}</div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {CIRCUIT_META.map((c, i) => (
            <div key={c.title} style={{ ...styles.circuitCard, borderTopColor: c.color, borderTopWidth: 3 }}>
              <div style={{ fontSize: 24, color: c.color, marginBottom: 10 }}>{c.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 10 }}>{c.title}</div>
              <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6 }}>{tx.circuits[i].desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── BACKTEST PROOF ─── */}
      <div style={styles.darkBg}>
        <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center', padding: '0 24px' }}>
          <div style={styles.sectionTitle}>
            <TrophyOutlined style={{ marginRight: 10, color: '#f5a623' }} />
            {tx.proofTitle}
          </div>
          <div style={{ ...styles.sectionSub, marginBottom: 36 }}>{tx.proofSub}</div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 16,
          }}>
            {tx.proofRows.map((row: any) => (
              <div key={row.label} style={{
                background: 'rgba(22,119,255,0.06)',
                border: '1px solid rgba(22,119,255,0.2)',
                borderRadius: 12,
                padding: '20px 16px',
              }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#4096ff' }}>{row.value}</div>
                <div style={{ fontSize: 13, color: '#ccc', marginTop: 4 }}>{row.label}</div>
                <div style={{ fontSize: 11, color: '#556677' }}>{row.note}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 24, color: '#445566', fontSize: 12 }}>{tx.proofDisclaimer}</div>
        </div>
      </div>

      {/* ─── EXCHANGES ─── */}
      <div style={{ ...styles.section, textAlign: 'center' }}>
        <div style={styles.sectionTitle}>
          <GlobalOutlined style={{ marginRight: 10, color: '#1677ff' }} />
          {tx.exchTitle}
        </div>
        <div style={{ ...styles.sectionSub, marginBottom: 36 }}>{tx.exchSub}</div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
          {EXCHANGES.map((ex) => (
            <a key={ex.name} href={ex.ref} target="_blank" rel="noopener noreferrer" style={{
              background: 'rgba(82,196,26,0.07)',
              border: '1px solid rgba(82,196,26,0.28)',
              borderRadius: 12,
              padding: '16px 24px',
              minWidth: 110,
              textDecoration: 'none',
              transition: 'transform 0.2s',
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#73d13d' }}>{ex.name}</div>
              <Tag color="green" style={{ marginTop: 6, fontSize: 10 }}>✓ LIVE</Tag>
              <div style={{ fontSize: 10, color: '#445566', marginTop: 4 }}>{tx.exchReg}</div>
            </a>
          ))}
        </div>
      </div>

      {/* ─── CTA ─── */}
      <div style={styles.ctaSection}>
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <div style={{ fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 800, color: '#fff', marginBottom: 16 }}>
            {tx.ctaTitle}
          </div>
          <div style={{ color: '#8899aa', fontSize: 16, marginBottom: 36, lineHeight: 1.6 }}>
            {tx.ctaSub}
          </div>
          <Space size={16} wrap style={{ justifyContent: 'center' }}>
            <Button
              type="primary"
              size="large"
              icon={<RocketOutlined />}
              href="/client/register"
              style={{ height: 52, paddingInline: 32, fontSize: 16, borderRadius: 12 }}
            >
              {tx.ctaBtn}
            </Button>
            <Button
              size="large"
              icon={<ArrowRightOutlined />}
              href="https://t.me/yakovbyakov"
              target="_blank"
              style={{
                height: 52,
                paddingInline: 32,
                fontSize: 16,
                borderRadius: 12,
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#fff',
              }}
            >
              {tx.ctaTg}
            </Button>
          </Space>
        </div>
      </div>

      {/* ─── FOOTER ─── */}
      <footer style={styles.footer}>
        <div>
          <strong style={{ color: '#aaa' }}>BTDD Platform</strong>
          &nbsp;·&nbsp;Algorithmic Trading SaaS
          &nbsp;·&nbsp;Bybit · Binance · Bitget · BingX · MEXC · Weex
        </div>
        <Divider style={{ borderColor: 'rgba(255,255,255,0.06)', margin: '16px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'center', gap: 24, flexWrap: 'wrap' }}>
          <a href="/client/login" style={{ color: '#556677' }}>{tx.footerLogin}</a>
          <a href="/client/register" style={{ color: '#556677' }}>{tx.footerRegister}</a>
          <a href="/whitepaper" style={{ color: '#556677' }}>Whitepaper</a>
          <a href="/login" style={{ color: '#556677' }}>{tx.footerAdmin}</a>
        </div>
        <div style={{ marginTop: 16 }}>{tx.footerDisclaimer}</div>
      </footer>
    </div>
  );
}
