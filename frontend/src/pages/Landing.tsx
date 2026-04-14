import React, { useState, useCallback, useEffect } from 'react';
import { useI18n, UILanguage } from '../i18n';

/* ─── Theme definitions ─── */
type LandingTheme = 'fire' | 'neon' | 'classic' | 'light';

const THEMES: Record<LandingTheme, {
  bg: string; bgAlt: string; bgCard: string; bgGlass: string;
  text: string; textSec: string; textMuted: string;
  border: string; accent: string; accentGlow: string;
  heroGrad: string; ctaBg: string; navBg: string; navBgScroll: string;
  cardBorder: string; proofBg: string; proofAccent: string;
  greenAccent: string; greenBg: string; greenText: string;
  isDark: boolean;
}> = {
  fire: {
    bg: '#0c0a08', bgAlt: '#141210', bgCard: '#1a1614', bgGlass: 'rgba(26,22,20,0.85)',
    text: '#f0e8e0', textSec: '#aa9580', textMuted: '#6e5840',
    border: 'rgba(255,109,0,0.15)', accent: '#ff6d00', accentGlow: 'rgba(255,109,0,0.25)',
    heroGrad: 'radial-gradient(ellipse 80% 60% at 50% 20%, rgba(255,109,0,0.12) 0%, transparent 70%)',
    ctaBg: 'linear-gradient(135deg, #ff6d00 0%, #ff9100 100%)',
    navBg: 'transparent', navBgScroll: 'rgba(12,10,8,0.92)',
    cardBorder: 'rgba(255,109,0,0.12)', proofBg: 'rgba(255,109,0,0.06)', proofAccent: '#ff6d00',
    greenAccent: '#ff9100', greenBg: 'rgba(255,145,0,0.1)', greenText: '#ffab40',
    isDark: true,
  },
  neon: {
    bg: '#0a0f0d', bgAlt: '#0e1412', bgCard: '#121a16', bgGlass: 'rgba(18,26,22,0.85)',
    text: '#e8f0ec', textSec: '#7aa68e', textMuted: '#4a6e5a',
    border: 'rgba(0,230,118,0.15)', accent: '#00e676', accentGlow: 'rgba(0,230,118,0.2)',
    heroGrad: 'radial-gradient(ellipse 80% 60% at 50% 20%, rgba(0,230,118,0.1) 0%, transparent 70%)',
    ctaBg: 'linear-gradient(135deg, #00e676 0%, #69f0ae 100%)',
    navBg: 'transparent', navBgScroll: 'rgba(10,15,13,0.92)',
    cardBorder: 'rgba(0,230,118,0.12)', proofBg: 'rgba(0,230,118,0.06)', proofAccent: '#00e676',
    greenAccent: '#00e676', greenBg: 'rgba(0,230,118,0.1)', greenText: '#69f0ae',
    isDark: true,
  },
  classic: {
    bg: '#08090e', bgAlt: '#0d0f16', bgCard: '#12141e', bgGlass: 'rgba(18,20,30,0.85)',
    text: '#e0e4f0', textSec: '#8890aa', textMuted: '#555574',
    border: 'rgba(64,150,255,0.15)', accent: '#4096ff', accentGlow: 'rgba(64,150,255,0.2)',
    heroGrad: 'radial-gradient(ellipse 80% 60% at 50% 20%, rgba(64,150,255,0.1) 0%, transparent 70%)',
    ctaBg: 'linear-gradient(135deg, #4096ff 0%, #5aafff 100%)',
    navBg: 'transparent', navBgScroll: 'rgba(8,9,14,0.92)',
    cardBorder: 'rgba(64,150,255,0.12)', proofBg: 'rgba(64,150,255,0.06)', proofAccent: '#4096ff',
    greenAccent: '#4096ff', greenBg: 'rgba(64,150,255,0.1)', greenText: '#5aafff',
    isDark: true,
  },
  light: {
    bg: '#ffffff', bgAlt: '#f8fafc', bgCard: '#ffffff', bgGlass: 'rgba(255,255,255,0.92)',
    text: '#0f172a', textSec: '#64748b', textMuted: '#94a3b8',
    border: '#e2e8f0', accent: '#6366f1', accentGlow: 'rgba(99,102,241,0.15)',
    heroGrad: 'linear-gradient(180deg, #eef2ff 0%, #ffffff 100%)',
    ctaBg: 'linear-gradient(135deg, #6366f1 0%, #818cf8 100%)',
    navBg: 'transparent', navBgScroll: 'rgba(255,255,255,0.95)',
    cardBorder: '#e2e8f0', proofBg: '#eef2ff', proofAccent: '#6366f1',
    greenAccent: '#10b981', greenBg: '#dcfce7', greenText: '#166534',
    isDark: false,
  },
};

const THEME_OPTS: { value: LandingTheme; icon: string; label: string }[] = [
  { value: 'fire', icon: '🟠', label: 'Fire' },
  { value: 'neon', icon: '🟢', label: 'Neon' },
  { value: 'classic', icon: '🔵', label: 'Classic' },
  { value: 'light', icon: '⚪', label: 'Light' },
];

/* ─── Localised content ─── */
function useLandingTexts(lang: UILanguage) {
  const t: Record<UILanguage, Record<string, any>> = {
    ru: {
      navStrategies: 'Стратегии',
      navExchanges: 'Биржи',
      navSecurity: 'Безопасность',
      navPricing: 'Тарифы',
      navFaq: 'FAQ',
      heroTitle1: 'Алгоритмическая торговля',
      heroTitle2: 'как сервис',
      heroSub: 'SaaS-платформа для автоматической торговли на криптобиржах. Три типа стратегий, 9 108 бектестов, robustness-фильтрация. Bybit, Binance, Bitget, BingX, MEXC, Weex — всё подключено.',
      btnStart: 'Начать бесплатно',
      btnLogin: 'Войти',
      betaBadge: 'Бесплатно в бета',
      metrics: [
        { value: '9 108', label: 'бектестов' },
        { value: '3 129', label: 'робастных' },
        { value: '+28.7%', label: 'доходность' },
        { value: '3.28', label: 'Profit Factor' },
      ],
      modesTitle: 'Три режима для клиентов',
      modesSub: 'От пассивного дохода до полного контроля — выберите свой формат',
      modePopular: 'Популярный',
      modes: [
        { title: 'Алгофонд', desc: 'Простое безопасное API-подключение — средства всегда остаются на вашей бирже. Никаких переводов. Подключаете ключ, платформа торгует за вас.' },
        { title: 'Стратег', desc: 'Для тех, кто хочет разобраться глубже. Подключите API-ключ, выберите стратегии из каталога и соберите собственную торговую систему.' },
        { title: 'Копитрейдинг', desc: 'Один API-ключ — несколько копируемых аккаунтов. Торгуете и делитесь с друзьями — без ограничений биржевого копитрейдинга.' },
      ],
      stratTitle: 'Стратегии',
      stratSub: '3 типа алгоритмов из\u00a09 108 бектестов с\u00a0robustness-фильтрацией',
      strats: [
        { name: 'DoubleDragon Breakout', desc: 'Пробой канала Дончиана с трейлинговым TP. Ловит направленный импульс и удерживает тренд.', tags: ['классика', 'арбитраж', 'trend'] },
        { name: 'StatArb Z-Score', desc: 'Возврат к среднему по Z-счёту на синтетическом инструменте. Торгует схождение/расхождение активов.', tags: ['арбитраж', 'mean-reversion'] },
        { name: 'ZigZag Breakout', desc: 'Структурный пробой с Дончианом. Оптимален при смене рыночного режима и резких движениях.', tags: ['классика', 'breakout'] },
      ],
      archTitle: 'Трёхконтурная архитектура',
      archSub: 'Runtime не зависит от Research. Research не влияет на клиентов. Каждый контур изолирован.',
      circuits: [
        { title: 'Runtime', desc: 'Изолированный торговый контур. Нулевой даунтайм. Перезапуск API не влияет на торговлю.' },
        { title: 'Research', desc: 'Backtesting, sweep по 9 108+ вариантам, оптимизация, out-of-sample валидация кандидатов.' },
        { title: 'Client', desc: 'SaaS мульти-тенант. Изоляция по API-ключу. Каталог офферов, мониторинг позиций.' },
      ],
      proofTitle: 'Доказанная методология',
      proofSub: 'Средние показатели по площадке · 9 108 бектестов · 2025–2026',
      proofRows: [
        { label: 'Стратегий', value: '3' },
        { label: 'Период', value: '15+ мес' },
        { label: 'Доходность', value: '+28.7%' },
        { label: 'Profit Factor', value: '3.28' },
        { label: 'Max DD', value: '4.4%' },
        { label: 'Сделок', value: '416' },
      ],
      proofDisclaimer: '* Бэктест на данных Bybit, 4h, комиссии 0.1%, проскальзывание 0.05%. Прошлые результаты не гарантируют будущую доходность.',
      exchTitle: 'Биржевые интеграции',
      exchSub: '6 бирж подключено. Bybit — основной коннектор.',
      exchReg: 'Регистрация →',
      securityTitle: 'Безопасность',
      securitySub: 'Ваши средства никогда не покидают биржу.',
      securityCards: [
        { icon: '🔒', title: 'Read-only ключи', desc: 'Мы не запрашиваем права на вывод. Активы остаются на вашей бирже.' },
        { icon: '🛡️', title: 'AES-256 шифрование', desc: 'API-ключи зашифрованы. Даже наша команда не имеет доступа в открытом виде.' },
        { icon: '✅', title: 'Нет доступа к средствам', desc: 'Только торговые сигналы. Мы не можем выводить или переводить активы.' },
        { icon: '⏰', title: '99.9% аптайм', desc: 'Резервная инфраструктура для круглосуточной работы стратегий.' },
      ],
      faqTitle: 'Частые вопросы',
      faqItems: [
        { q: 'Это действительно бесплатно?', a: 'Да. В бета-тест все функции бесплатны. Позже будут платные тарифы, но бесплатный останется навсегда.' },
        { q: 'Могу ли я потерять деньги?', a: 'Любая торговля — это риск. Стратегии бэктестированы, но прошлые результаты не гарантируют будущее. Не торгуйте на средства, которые не можете потерять.' },
        { q: 'Мой аккаунт в безопасности?', a: 'Мы используем read-only API-ключи с разрешением на торговлю. Нет доступа к выводу средств.' },
        { q: 'Какие биржи?', a: 'Bybit, Binance, Bitget, BingX, MEXC, Weex. Новые добавляются регулярно.' },
        { q: 'Нужно программирование?', a: 'Нет. Подключите биржу, выберите стратегию, активируйте — всё через интерфейс.' },
      ],
      discountTitle: '🔥 СЕЙЧАС БЕСПЛАТНО',
      discountSub: 'Все тарифы доступны бесплатно. Подключайте API-ключ и торгуйте.',
      discountBadge: 'Бесплатно',
      discountNote: 'Ранние пользователи сохранят скидку 90% при запуске платных тарифов.',
      discountPlans: [
        { title: 'Strategy 20', old: '$20' }, { title: 'Strategy 50', old: '$50' }, { title: 'Strategy 100', old: '$100' },
        { title: 'Algofund 20', old: '$20' }, { title: 'Algofund 50', old: '$50' }, { title: 'Algofund 100', old: '$100' },
      ],
      discountCta: 'Начать бесплатно',
      ctaTitle: 'Готовы торговать умнее?',
      ctaSub: 'Зарегистрируйтесь, подключите API-ключ и запустите первую стратегию за минуты.',
      ctaBtn: 'Зарегистрироваться',
      ctaTg: 'Написать в Telegram',
      footerLogin: 'Вход', footerRegister: 'Регистрация', footerAdmin: 'Админ',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Торговля криптовалютой сопряжена с рисками.',
    },
    en: {
      navStrategies: 'Strategies', navExchanges: 'Exchanges', navSecurity: 'Security', navPricing: 'Pricing', navFaq: 'FAQ',
      heroTitle1: 'Algorithmic Trading', heroTitle2: 'as a Service',
      heroSub: 'Automated crypto trading with 9,108+ backtested strategies across 6 exchanges. Three algorithm types, robustness filtering. Connect and trade — no coding required.',
      btnStart: 'Start Free', btnLogin: 'Log In', betaBadge: 'Free During Beta',
      metrics: [
        { value: '9,108', label: 'backtests' }, { value: '3,129', label: 'robust' },
        { value: '+28.7%', label: 'avg return' }, { value: '3.28', label: 'Profit Factor' },
      ],
      modesTitle: 'Three Client Modes', modesSub: 'From passive income to full control',
      modePopular: 'Popular',
      modes: [
        { title: 'Algofund', desc: 'Secure API connection — funds stay on your exchange. Connect your key, the platform trades for you. Hands-off income.' },
        { title: 'Strategist', desc: 'Full control. Pick strategies from the catalog, build a custom portfolio in clicks.' },
        { title: 'Copy Trading', desc: 'One API key — multiple mirrored accounts. Share your setup without exchange restrictions.' },
      ],
      stratTitle: 'Strategies', stratSub: '3 algorithm types from 9,108 backtests with robustness filtering',
      strats: [
        { name: 'DoubleDragon Breakout', desc: 'Donchian channel breakout with trailing TP. Captures momentum and rides the trend.', tags: ['classic', 'arbitrage', 'trend'] },
        { name: 'StatArb Z-Score', desc: 'Mean reversion via Z-score on synthetic instruments. Trades convergence of correlated assets.', tags: ['arbitrage', 'mean-reversion'] },
        { name: 'ZigZag Breakout', desc: 'Structural breakout using Donchian. Best during regime changes and sharp moves.', tags: ['classic', 'breakout'] },
      ],
      archTitle: 'Three-Circuit Architecture', archSub: 'Runtime, Research, Client — each fully isolated.',
      circuits: [
        { title: 'Runtime', desc: 'Isolated trading circuit. Zero downtime. API restarts never interrupt live trading.' },
        { title: 'Research', desc: 'Backtesting engine: 9,108+ parameter sweep, optimization, out-of-sample validation.' },
        { title: 'Client', desc: 'Multi-tenant SaaS. Client isolation by API key. Offer catalog, position monitoring.' },
      ],
      proofTitle: 'Proven Methodology', proofSub: 'Platform averages · 9,108 backtests · 2025–2026',
      proofRows: [
        { label: 'Strategies', value: '3' }, { label: 'Period', value: '15+ mo' },
        { label: 'Avg Return', value: '+28.7%' }, { label: 'Profit Factor', value: '3.28' },
        { label: 'Max DD', value: '4.4%' }, { label: 'Trades', value: '416' },
      ],
      proofDisclaimer: '* Backtest on Bybit 4h data, 0.1% fees, 0.05% slippage. Past performance ≠ future results.',
      exchTitle: 'Exchange Integrations', exchSub: '6 exchanges live. Bybit primary.', exchReg: 'Sign Up →',
      securityTitle: 'Security First', securitySub: 'Your funds never leave your exchange.',
      securityCards: [
        { icon: '🔒', title: 'Read-Only Keys', desc: 'No withdrawal permissions. Funds stay on your exchange.' },
        { icon: '🛡️', title: 'AES-256 Encryption', desc: 'All API keys encrypted at rest. Even our team can\'t read them.' },
        { icon: '✅', title: 'No Fund Access', desc: 'Trade signals only. We can\'t move or withdraw your assets.' },
        { icon: '⏰', title: '99.9% Uptime', desc: 'Redundant infrastructure for 24/7 strategy execution.' },
      ],
      faqTitle: 'FAQ',
      faqItems: [
        { q: 'Is it really free?', a: 'Yes. All features are free during beta. Free tier stays forever.' },
        { q: 'Can I lose money?', a: 'All trading carries risk. Strategies are backtested but past performance ≠ future results.' },
        { q: 'Is my account safe?', a: 'We use read-only API keys with trade-only permissions. No withdrawal access.' },
        { q: 'Which exchanges?', a: 'Bybit, Binance, Bitget, BingX, MEXC, Weex. More coming.' },
        { q: 'Need coding?', a: 'No. Connect exchange, pick strategy, activate. All point-and-click.' },
      ],
      discountTitle: '🔥 FREE NOW', discountSub: 'All plans free during beta. Connect your API key and trade.',
      discountBadge: 'Free', discountNote: 'Early users keep 90% discount when pricing launches.',
      discountPlans: [
        { title: 'Strategy 20', old: '$20' }, { title: 'Strategy 50', old: '$50' }, { title: 'Strategy 100', old: '$100' },
        { title: 'Algofund 20', old: '$20' }, { title: 'Algofund 50', old: '$50' }, { title: 'Algofund 100', old: '$100' },
      ],
      discountCta: 'Start Free',
      ctaTitle: 'Ready to trade smarter?', ctaSub: 'Sign up, connect API key, launch your first strategy in minutes.',
      ctaBtn: 'Sign Up Free', ctaTg: 'Telegram',
      footerLogin: 'Login', footerRegister: 'Sign Up', footerAdmin: 'Admin',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Crypto trading involves risk.',
    },
    tr: {
      navStrategies: 'Stratejiler', navExchanges: 'Borsalar', navSecurity: 'Güvenlik', navPricing: 'Fiyatlar', navFaq: 'SSS',
      heroTitle1: 'Algoritmik Ticaret', heroTitle2: 'Hizmet Olarak',
      heroSub: '6 borsada 9.108+ backtest\'li otomatik kripto ticaret platformu. Üç algoritma türü, sağlamlık filtreleme. Kod bilgisi gerekmez.',
      btnStart: 'Ücretsiz Başla', btnLogin: 'Giriş', betaBadge: 'Betada Ücretsiz',
      metrics: [
        { value: '9.108', label: 'backtest' }, { value: '3.129', label: 'sağlam' },
        { value: '+%28,7', label: 'ort getiri' }, { value: '3,28', label: 'Kâr Faktörü' },
      ],
      modesTitle: 'Üç Müşteri Modu', modesSub: 'Pasif gelirden tam kontrole',
      modePopular: 'Popüler',
      modes: [
        { title: 'Algofon', desc: 'Güvenli API bağlantısı — fonlar borsanızda kalır. Anahtarı bağlayın, platform işlem yapar.' },
        { title: 'Stratejist', desc: 'Tam kontrol. Katalogdan strateji seçin, özel portföy oluşturun.' },
        { title: 'Kopya Ticaret', desc: 'Bir API anahtarı — birden fazla hesap. Borsa kısıtlaması olmadan paylaşın.' },
      ],
      stratTitle: 'Stratejiler', stratSub: '9.108 backtest\'ten 3 algoritma türü',
      strats: [
        { name: 'DoubleDragon Breakout', desc: 'Donchian kanal kırılması. Momentumu yakalar ve trendi sürdürür.', tags: ['klasik', 'arbitraj', 'trend'] },
        { name: 'StatArb Z-Score', desc: 'Z-skoru ile ortalamaya dönüş. İlişkili varlıkların yakınsamasını işler.', tags: ['arbitraj', 'mean-reversion'] },
        { name: 'ZigZag Breakout', desc: 'Yapısal kırılma. Rejim değişikliklerinde en iyi performans.', tags: ['klasik', 'breakout'] },
      ],
      archTitle: 'Üç Devreli Mimari', archSub: 'Runtime, Research, Client — her biri tamamen izole.',
      circuits: [
        { title: 'Runtime', desc: 'İzole ticaret devresi. Sıfır kesinti. API yeniden başlatmaları ticareti etkilemez.' },
        { title: 'Research', desc: 'Backtest motoru: 9.108+ parametre taraması, optimizasyon, doğrulama.' },
        { title: 'Client', desc: 'Çok kiracılı SaaS. API anahtarına göre izolasyon. Kota yönetimi.' },
      ],
      proofTitle: 'Kanıtlanmış Metodoloji', proofSub: 'Platform ortalamaları · 9.108 backtest · 2025–2026',
      proofRows: [
        { label: 'Strateji', value: '3' }, { label: 'Dönem', value: '15+ ay' },
        { label: 'Getiri', value: '+%28,7' }, { label: 'Kâr Faktörü', value: '3,28' },
        { label: 'Maks DD', value: '%4,4' }, { label: 'İşlem', value: '416' },
      ],
      proofDisclaimer: '* Bybit 4s, %0,1 komisyon, %0,05 kayma. Geçmiş performans ≠ gelecek.',
      exchTitle: 'Borsa Entegrasyonları', exchSub: '6 borsa bağlı. Bybit ana.', exchReg: 'Kayıt →',
      securityTitle: 'Güvenlik', securitySub: 'Fonlarınız asla borsanızdan ayrılmaz.',
      securityCards: [
        { icon: '🔒', title: 'Salt Okunur Anahtarlar', desc: 'Çekim izni yok. Fonlar borsanızda kalır.' },
        { icon: '🛡️', title: 'AES-256 Şifreleme', desc: 'Tüm API anahtarları şifreli. Ekibimiz bile okuyamaz.' },
        { icon: '✅', title: 'Fon Erişimi Yok', desc: 'Sadece sinyal. Varlık taşıma veya çekme yapamayız.' },
        { icon: '⏰', title: '%99,9 Çalışma', desc: 'Yedekli altyapı ile 7/24 strateji çalışması.' },
      ],
      faqTitle: 'SSS',
      faqItems: [
        { q: 'Gerçekten ücretsiz mi?', a: 'Evet. Beta döneminde tüm özellikler ücretsiz. Ücretsiz plan kalıcı.' },
        { q: 'Para kaybedebilir miyim?', a: 'Her ticaret risk taşır. Backtest geçmiş performanstır, gelecek garantisi değil.' },
        { q: 'Hesabım güvende mi?', a: 'Salt okunur API anahtarları kullanıyoruz. Çekim erişimi yok.' },
        { q: 'Hangi borsalar?', a: 'Bybit, Binance, Bitget, BingX, MEXC, Weex. Yenileri ekleniyor.' },
        { q: 'Kod gerekli mi?', a: 'Hayır. Bağla, seç, aktive et. Hepsi arayüzde.' },
      ],
      discountTitle: '🔥 ŞU AN ÜCRETSİZ', discountSub: 'Tüm planlar ücretsiz. API anahtarınızı bağlayın.',
      discountBadge: 'Ücretsiz', discountNote: 'Erken kullanıcılar %90 indirim korur.',
      discountPlans: [
        { title: 'Strategy 20', old: '$20' }, { title: 'Strategy 50', old: '$50' }, { title: 'Strategy 100', old: '$100' },
        { title: 'Algofund 20', old: '$20' }, { title: 'Algofund 50', old: '$50' }, { title: 'Algofund 100', old: '$100' },
      ],
      discountCta: 'Ücretsiz Başla',
      ctaTitle: 'Hazır mısınız?', ctaSub: 'Kayıt olun, API bağlayın, dakikalar içinde başlayın.',
      ctaBtn: 'Ücretsiz Kayıt', ctaTg: 'Telegram',
      footerLogin: 'Giriş', footerRegister: 'Kayıt', footerAdmin: 'Yönetici',
      footerDisclaimer: '© 2025–2026 BTDD Platform. Kripto ticareti risk içerir.',
    },
  };
  return t[lang] || t.en;
}

const EXCHANGES = [
  { name: 'Bybit', ref: 'https://www.bybit.com/invite?ref=P2GAX' },
  { name: 'Binance', ref: 'https://www.binance.com/referral/earn-together/refer2earn-usdc/claim?hl=ru&ref=GRO_28502_9VNRB&utm_source=referral_entrance' },
  { name: 'Bitget', ref: 'https://partner.bitget.com/bg/VJ90ZR' },
  { name: 'BingX', ref: 'https://bingxdao.com/invite/AD0H6D/' },
  { name: 'MEXC', ref: 'https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-12A4vC' },
  { name: 'Weex', ref: 'https://www.weex.com/register?ref=BTDD' },
];

export default function Landing() {
  const { language, setLanguage } = useI18n();
  const tx = useLandingTexts(language);
  const [scrolled, setScrolled] = useState(false);
  const [theme, setTheme] = useState<LandingTheme>(() => {
    const s = localStorage.getItem('btddLandingTheme');
    return (s === 'fire' || s === 'neon' || s === 'classic' || s === 'light') ? s : 'fire';
  });

  const T = THEMES[theme];

  const switchTheme = useCallback((t: LandingTheme) => {
    setTheme(t);
    localStorage.setItem('btddLandingTheme', t);
  }, []);

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 10);
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, []);

  const btnStyle = (primary?: boolean): React.CSSProperties => primary ? {
    display: 'inline-block', padding: '12px 28px', borderRadius: 10, fontWeight: 700, fontSize: 15,
    background: T.ctaBg, color: T.isDark ? '#0a0a0a' : '#fff', textDecoration: 'none',
    border: 'none', cursor: 'pointer', transition: 'transform 0.15s',
  } : {
    display: 'inline-block', padding: '12px 28px', borderRadius: 10, fontWeight: 600, fontSize: 15,
    border: `1.5px solid ${T.border}`, color: T.textSec, background: 'transparent', textDecoration: 'none',
    cursor: 'pointer', transition: 'border-color 0.15s',
  };

  const sectionStyle = (alt?: boolean): React.CSSProperties => ({
    padding: '80px 24px', background: alt ? T.bgAlt : T.bg,
  });

  const cardStyle: React.CSSProperties = {
    background: T.bgCard, border: `1px solid ${T.cardBorder}`, borderRadius: 14, padding: '24px 20px',
  };

  const headingStyle: React.CSSProperties = {
    fontSize: 'clamp(22px, 3.5vw, 34px)', fontWeight: 800, textAlign: 'center', marginBottom: 8, color: T.text,
  };

  return (
    <div style={{ background: T.bg, minHeight: '100vh', color: T.text, fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>

      {/* ─── NAV ─── */}
      <nav style={{
        position: 'fixed', top: 0, width: '100%', zIndex: 100, padding: '12px 0',
        background: scrolled ? T.navBgScroll : T.navBg,
        backdropFilter: scrolled ? 'blur(12px)' : 'none',
        borderBottom: scrolled ? `1px solid ${T.border}` : '1px solid transparent',
        transition: 'all 0.25s',
      }}>
        <div style={{ maxWidth: 1140, margin: '0 auto', padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: 20, color: T.text, letterSpacing: -0.5 }}>
            BTDD<span style={{ color: T.accent }}>.</span>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
            {[['#strategies', tx.navStrategies], ['#exchanges', tx.navExchanges], ['#security', tx.navSecurity], ['#pricing', tx.navPricing], ['#faq', tx.navFaq]].map(([href, label]) => (
              <a key={href} href={href} style={{ color: T.textSec, fontSize: 13, fontWeight: 500, textDecoration: 'none' }}>{label}</a>
            ))}
            <div style={{ width: 1, height: 16, background: T.border, margin: '0 2px' }} />
            {THEME_OPTS.map(o => (
              <button key={o.value} onClick={() => switchTheme(o.value)} title={o.label} style={{
                background: theme === o.value ? T.accentGlow : 'transparent',
                border: theme === o.value ? `1px solid ${T.accent}` : `1px solid ${T.isDark ? 'rgba(255,255,255,0.1)' : T.border}`,
                borderRadius: 5, padding: '2px 6px', fontSize: 13, cursor: 'pointer', lineHeight: 1,
              }}>{o.icon}</button>
            ))}
            <div style={{ width: 1, height: 16, background: T.border, margin: '0 2px' }} />
            {(['ru', 'en', 'tr'] as UILanguage[]).map(lng => (
              <button key={lng} onClick={() => setLanguage(lng)} style={{
                background: language === lng ? T.accentGlow : 'transparent',
                border: language === lng ? `1px solid ${T.accent}` : `1px solid ${T.isDark ? 'rgba(255,255,255,0.1)' : T.border}`,
                color: language === lng ? T.accent : T.textSec,
                borderRadius: 5, padding: '2px 7px', fontSize: 11, cursor: 'pointer', fontWeight: language === lng ? 700 : 400,
              }}>{lng.toUpperCase()}</button>
            ))}
            <a href="/client/register" style={{
              ...btnStyle(true), padding: '7px 18px', fontSize: 13,
            }}>{tx.btnStart}</a>
          </div>
        </div>
      </nav>

      {/* ─── HERO ─── */}
      <section style={{ paddingTop: 100, paddingBottom: 60, textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: T.heroGrad, pointerEvents: 'none' }} />
        <div style={{ position: 'relative', zIndex: 1, padding: '0 24px' }}>
          <span style={{
            display: 'inline-block', background: T.greenBg, color: T.greenText,
            fontSize: 12, fontWeight: 700, padding: '5px 16px', borderRadius: 20,
            marginBottom: 24, letterSpacing: 0.5,
          }}>
            {tx.betaBadge}
          </span>
          <h1 style={{
            fontSize: 'clamp(36px, 6vw, 64px)', fontWeight: 900, lineHeight: 1.08,
            margin: '0 auto 20px', maxWidth: 700,
          }}>
            {tx.heroTitle1}<br />
            <span style={{ color: T.accent }}>{tx.heroTitle2}</span>
          </h1>
          <p style={{ fontSize: 'clamp(15px, 2vw, 19px)', color: T.textSec, maxWidth: 580, margin: '0 auto 36px', lineHeight: 1.7 }}>
            {tx.heroSub}
          </p>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 52, flexWrap: 'wrap' }}>
            <a href="/client/register" style={btnStyle(true)}>{tx.btnStart}</a>
            <a href="/client/login" style={btnStyle()}>{tx.btnLogin}</a>
            <a href="/whitepaper" style={btnStyle()}>Whitepaper</a>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: 40, flexWrap: 'wrap' }}>
            {tx.metrics.map((m: any, i: number) => (
              <div key={i} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 'clamp(28px, 4.5vw, 44px)', fontWeight: 900, color: T.accent, lineHeight: 1.1 }}>{m.value}</div>
                <div style={{ fontSize: 13, color: T.textSec, marginTop: 4 }}>{m.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── EXCHANGE STRIP ─── */}
      <div style={{ padding: '28px 0', borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 32, flexWrap: 'wrap', opacity: 0.5 }}>
          {EXCHANGES.map(ex => (
            <a key={ex.name} href={ex.ref} target="_blank" rel="noopener noreferrer"
              style={{ fontSize: 14, fontWeight: 700, color: T.textSec, textDecoration: 'none', letterSpacing: 0.5 }}>
              {ex.name}
            </a>
          ))}
        </div>
      </div>

      {/* ─── MODES ─── */}
      <section style={sectionStyle()}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.modesTitle}</h2>
          <p style={{ textAlign: 'center', color: T.textSec, fontSize: 15, marginBottom: 48 }}>{tx.modesSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {[0, 1, 2].map(i => {
              const hl = i === 0;
              return (
                <div key={i} style={{
                  ...cardStyle,
                  border: hl ? `1.5px solid ${T.accent}` : cardStyle.border,
                  background: hl ? T.proofBg : cardStyle.background,
                  position: 'relative',
                }}>
                  {hl && <span style={{
                    position: 'absolute', top: -10, right: 16, background: T.ctaBg, color: T.isDark ? '#0a0a0a' : '#fff',
                    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 10,
                  }}>{tx.modePopular}</span>}
                  <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 10, color: T.text }}>{tx.modes[i].title}</div>
                  <div style={{ color: T.textSec, fontSize: 14, lineHeight: 1.65 }}>{tx.modes[i].desc}</div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ─── STRATEGIES ─── */}
      <section id="strategies" style={sectionStyle(true)}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.stratTitle}</h2>
          <p style={{ textAlign: 'center', color: T.textSec, fontSize: 15, marginBottom: 48 }}>{tx.stratSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {tx.strats.map((s: any, i: number) => (
              <div key={i} style={cardStyle}>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.accent, marginBottom: 4 }}>{s.name}</div>
                <div style={{ color: T.textSec, fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>{s.desc}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {s.tags.map((tag: string) => (
                    <span key={tag} style={{
                      fontSize: 10, background: T.accentGlow, border: `1px solid ${T.border}`,
                      color: T.accent, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                    }}>{tag}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── ARCHITECTURE ─── */}
      <section style={sectionStyle()}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.archTitle}</h2>
          <p style={{ textAlign: 'center', color: T.textSec, fontSize: 15, marginBottom: 48 }}>{tx.archSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>
            {[
              { color: '#ef4444' }, { color: T.accent }, { color: '#10b981' },
            ].map((c, i) => (
              <div key={i} style={{ ...cardStyle, borderTop: `3px solid ${c.color}` }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>{tx.circuits[i].title}</div>
                <div style={{ color: T.textSec, fontSize: 14, lineHeight: 1.6 }}>{tx.circuits[i].desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── PROOF — 6 cards in 1 row ─── */}
      <section style={sectionStyle(true)}>
        <div style={{ maxWidth: 1140, margin: '0 auto', textAlign: 'center' }}>
          <h2 style={headingStyle}>{tx.proofTitle}</h2>
          <p style={{ color: T.textSec, fontSize: 15, marginBottom: 36 }}>{tx.proofSub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
            {tx.proofRows.map((row: any, i: number) => (
              <div key={i} style={{
                background: T.proofBg, border: `1px solid ${T.cardBorder}`, borderRadius: 12, padding: '20px 12px',
              }}>
                <div style={{ fontSize: 'clamp(20px, 2.5vw, 30px)', fontWeight: 900, color: T.proofAccent, lineHeight: 1.1 }}>{row.value}</div>
                <div style={{ fontSize: 12, color: T.textSec, marginTop: 6 }}>{row.label}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 20, color: T.textMuted, fontSize: 11 }}>{tx.proofDisclaimer}</div>
        </div>
      </section>

      {/* ─── EXCHANGES ─── */}
      <section id="exchanges" style={{ ...sectionStyle(), textAlign: 'center' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.exchTitle}</h2>
          <p style={{ color: T.textSec, fontSize: 15, marginBottom: 36 }}>{tx.exchSub}</p>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center' }}>
            {EXCHANGES.map(ex => (
              <a key={ex.name} href={ex.ref} target="_blank" rel="noopener noreferrer" style={{
                ...cardStyle, padding: '14px 24px', minWidth: 110, textDecoration: 'none', textAlign: 'center',
              }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{ex.name}</div>
                <div style={{ fontSize: 10, color: T.greenAccent, fontWeight: 700, marginTop: 3 }}>✓ LIVE</div>
                <div style={{ fontSize: 11, color: T.accent, marginTop: 3 }}>{tx.exchReg}</div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* ─── SECURITY ─── */}
      <section id="security" style={sectionStyle(true)}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.securityTitle}</h2>
          <p style={{ textAlign: 'center', color: T.textSec, fontSize: 15, marginBottom: 48 }}>{tx.securitySub}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
            {tx.securityCards.map((c: any, i: number) => (
              <div key={i} style={cardStyle}>
                <div style={{ fontSize: 26, marginBottom: 10 }}>{c.icon}</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6, color: T.text }}>{c.title}</div>
                <div style={{ color: T.textSec, fontSize: 13, lineHeight: 1.6 }}>{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ─── FREE PRICING ─── */}
      <section id="pricing" style={{ ...sectionStyle(), textAlign: 'center' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <div style={{
            display: 'inline-block', background: T.ctaBg, color: T.isDark ? '#0a0a0a' : '#fff',
            fontSize: 'clamp(22px, 4vw, 38px)', fontWeight: 900, padding: '12px 36px', borderRadius: 14, marginBottom: 20,
          }}>
            {tx.discountTitle}
          </div>
          <p style={{ color: T.textSec, fontSize: 16, maxWidth: 500, margin: '0 auto 12px', lineHeight: 1.6 }}>{tx.discountSub}</p>
          <div style={{
            display: 'inline-block', background: T.greenBg, borderRadius: 8, padding: '6px 20px',
            fontSize: 13, color: T.greenText, fontWeight: 600, marginBottom: 32,
          }}>{tx.discountNote}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12, maxWidth: 900, margin: '0 auto 32px' }}>
            {tx.discountPlans.map((p: any, i: number) => (
              <div key={i} style={{ ...cardStyle, padding: '16px 12px', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: T.textSec, fontWeight: 600, marginBottom: 6 }}>{p.title}</div>
                <div style={{ fontSize: 14, color: T.textMuted, textDecoration: 'line-through' }}>{p.old}</div>
                <div style={{ fontSize: 28, fontWeight: 900, color: T.greenAccent }}>$0</div>
                <span style={{
                  fontSize: 10, fontWeight: 700, background: T.greenBg, color: T.greenText,
                  padding: '2px 6px', borderRadius: 8,
                }}>{tx.discountBadge}</span>
              </div>
            ))}
          </div>
          <a href="/client/register" style={{ ...btnStyle(true), padding: '14px 40px', fontSize: 17 }}>{tx.discountCta}</a>
        </div>
      </section>

      {/* ─── FAQ ─── */}
      <section id="faq" style={sectionStyle(true)}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h2 style={headingStyle}>{tx.faqTitle}</h2>
          <div style={{ marginTop: 32 }}>
            {tx.faqItems.map((item: any, i: number) => (
              <FaqItem key={i} question={item.q} answer={item.a} defaultOpen={i === 0} T={T} />
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section style={{ padding: '80px 24px', background: T.isDark ? 'rgba(0,0,0,0.4)' : '#0f172a', textAlign: 'center' }}>
        <h2 style={{ fontSize: 'clamp(24px, 4vw, 38px)', fontWeight: 900, color: '#fff', marginBottom: 12 }}>{tx.ctaTitle}</h2>
        <p style={{ color: '#94a3b8', fontSize: 15, marginBottom: 32, lineHeight: 1.6 }}>{tx.ctaSub}</p>
        <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/client/register" style={{ ...btnStyle(true), color: '#fff' }}>{tx.ctaBtn}</a>
          <a href="https://t.me/yakovbyakov" target="_blank" rel="noopener noreferrer" style={{
            display: 'inline-block', padding: '12px 28px', borderRadius: 10, fontWeight: 600, fontSize: 15,
            border: '1.5px solid rgba(255,255,255,0.15)', color: '#fff', background: 'transparent', textDecoration: 'none',
          }}>{tx.ctaTg}</a>
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer style={{ padding: '40px 24px', borderTop: `1px solid ${T.border}`, background: T.bg }}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 32, marginBottom: 24 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 18, color: T.text }}>BTDD<span style={{ color: T.accent }}>.</span></div>
              <p style={{ color: T.textMuted, fontSize: 13, marginTop: 6 }}>Algorithmic trading as a service.</p>
            </div>
            <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
              {[
                [tx.navStrategies, '#strategies'], [tx.navExchanges, '#exchanges'], [tx.navSecurity, '#security'],
                [tx.navPricing, '#pricing'], [tx.navFaq, '#faq'], ['Whitepaper', '/whitepaper'],
              ].map(([l, h]) => (
                <a key={h} href={h} style={{ color: T.textSec, fontSize: 13, textDecoration: 'none' }}>{l}</a>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {[
                ['Telegram', 'https://t.me/BTDD_Live'], ['Chat', 'https://t.me/BTDD_Discuss'],
                ['Medium', 'https://medium.com/@foresterufa'], ['LinkedIn', 'https://www.linkedin.com/in/alekseilazarev'],
              ].map(([l, h]) => (
                <a key={h} href={h} target="_blank" rel="noopener noreferrer" style={{ color: T.textMuted, fontSize: 12, textDecoration: 'none' }}>{l}</a>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginBottom: 16 }}>
            <a href="/client/login" style={{ color: T.textMuted, fontSize: 12, textDecoration: 'none' }}>{tx.footerLogin}</a>
            <a href="/client/register" style={{ color: T.textMuted, fontSize: 12, textDecoration: 'none' }}>{tx.footerRegister}</a>
            <a href="/login" style={{ color: T.textMuted, fontSize: 12, textDecoration: 'none' }}>{tx.footerAdmin}</a>
          </div>
          <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 16, textAlign: 'center', color: T.textMuted, fontSize: 12 }}>
            {tx.footerDisclaimer}
          </div>
        </div>
      </footer>
    </div>
  );
}

function FaqItem({ question, answer, defaultOpen = false, T }: {
  question: string; answer: string; defaultOpen?: boolean; T: typeof THEMES['fire'];
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ borderBottom: `1px solid ${T.border}`, padding: '16px 0' }}>
      <div onClick={() => setOpen(!open)} style={{
        fontWeight: 700, fontSize: 15, cursor: 'pointer', display: 'flex',
        justifyContent: 'space-between', alignItems: 'center', color: T.text,
      }}>
        {question}
        <span style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none', color: T.textMuted, fontSize: 12 }}>▾</span>
      </div>
      {open && <div style={{ color: T.textSec, fontSize: 14, marginTop: 10, lineHeight: 1.65 }}>{answer}</div>}
    </div>
  );
}
