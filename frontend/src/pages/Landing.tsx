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
} from '@ant-design/icons';

const { Title, Paragraph, Text } = Typography;

const METRICS = [
  { value: '9 108', label: 'бектестов прогнано', sub: 'исторический sweep' },
  { value: '3 129', label: 'робастных кандидатов', sub: 'прошли robustness-фильтр' },
  { value: '+28.7%', label: 'доходность портфеля', sub: 'full-range, 4h, 2025–2026' },
  { value: '3.28', label: 'Profit Factor', sub: 'на 416 сделках в портфеле' },
  { value: '4.4%', label: 'макс. просадка', sub: 'портфельная DD' },
  { value: '6 бирж', label: 'подключено', sub: 'Bybit · Binance · Bitget + ещё' },
];

const STRATEGIES = [
  {
    icon: <ThunderboltOutlined style={{ fontSize: 28, color: '#f5a623' }} />,
    name: 'DoubleDragon Breakout',
    code: 'DD_BattleToads',
    desc: 'Пробой канала Дончиана с трейлинговым TP. Работает на mono и synthetic парах. Ловит направленный импульс и удерживает тренд.',
    tags: ['mono', 'synthetic', 'trend-following'],
  },
  {
    icon: <LineChartOutlined style={{ fontSize: 28, color: '#52c41a' }} />,
    name: 'StatArb Z-Score',
    code: 'stat_arb_zscore',
    desc: 'Возврат к среднему по Z-счёту на синтетическом инструменте. Торгует схождение/расхождение двух связанных активов.',
    tags: ['synthetic', 'mean-reversion', 'stat-arb'],
  },
  {
    icon: <BarChartOutlined style={{ fontSize: 28, color: '#1677ff' }} />,
    name: 'ZigZag Breakout',
    code: 'zz_breakout',
    desc: 'Структурный пробой с Дончианом. Оптимален при смене рыночного режима и резких направленных движениях.',
    tags: ['mono', 'synthetic', 'breakout'],
  },
];

const CLIENT_MODES = [
  {
    icon: <TeamOutlined style={{ fontSize: 32, color: '#1677ff' }} />,
    title: 'Алгофонд',
    desc: 'Клиент отдаёт депозит под управление. Видит единую торговую систему, эквити-кривую, статистику. Подаёт заявки на старт/стоп. Никакой лишней сложности.',
    highlight: true,
  },
  {
    icon: <RocketOutlined style={{ fontSize: 32, color: '#52c41a' }} />,
    title: 'Стратег',
    desc: 'Продвинутый пользователь. Подключает свои API-ключи биржи, выбирает стратегии из каталога, настраивает риск-профиль и запускает автоторговлю в рамках выбранного тарифа.',
    highlight: false,
  },
  {
    icon: <CopyOutlined style={{ fontSize: 32, color: '#f5a623' }} />,
    title: 'Копитрейдинг',
    desc: 'Подключается к готовой торговой системе другого подписчика. Автоматически повторяет сделки ведущего трейдера с настройкой риска под свой размер депозита.',
    highlight: false,
  },
];

const CIRCUITS = [
  {
    color: '#ff4d4f',
    icon: <ThunderboltOutlined />,
    title: 'Runtime Circuit',
    desc: 'Изолированный торговый контур. Нулевой даунтайм. Стратегии исполняются в отдельном сервисе — перезапуск API не влияет на торговлю.',
  },
  {
    color: '#1677ff',
    icon: <BarChartOutlined />,
    title: 'Research Circuit',
    desc: 'Backtesting, исторический sweep по 9108+ вариантам, cart. product оптимизация, checkpoint/resume при долгих прогонах. Out-of-sample валидация кандидатов.',
  },
  {
    color: '#52c41a',
    icon: <TeamOutlined />,
    title: 'Client Circuit',
    desc: 'SaaS multi-tenant. Изоляция клиентов по api_key. Каталог офферов, тарифные лимиты, планы, мониторинг позиций. 3 режима: Strategy Client / Algofund / Custom.',
  },
];

const EXCHANGES = [
  { name: 'Bybit', status: 'live', note: 'primary' },
  { name: 'Binance', status: 'live', note: 'ccxt' },
  { name: 'Bitget', status: 'live', note: 'ccxt' },
  { name: 'BingX', status: 'live', note: 'ccxt' },
  { name: 'MEXC', status: 'live', note: 'ccxt' },
  { name: 'Weex', status: 'live', note: 'native' },
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
  return (
    <div style={styles.page}>
      {/* ─── HERO ─── */}
      <section style={styles.hero}>
        <div style={styles.heroBadge}>
          <ApiOutlined style={{ marginRight: 6 }} />
          Algorithmic Trading SaaS · v2.0 · Alpha
        </div>
        <h1 style={styles.heroTitle}>
          BTDD Platform
          <br />
          Алгоритмическая торговля
          <br />
          как сервис
        </h1>
        <p style={styles.heroSub}>
          Полноценная SaaS-платформа для автоматической торговли на криптобиржах.
          Три типа стратегий, 9 108 бектестов, robustness-фильтрация
          и мульти-тенантная архитектура. Bybit, Binance, Bitget, BingX, MEXC, Weex — всё подключено.
        </p>
        <Space size={16} wrap style={{ justifyContent: 'center' }}>
          <Button
            type="primary"
            size="large"
            icon={<RocketOutlined />}
            href="/client/register"
            style={{ height: 48, paddingInline: 28, fontSize: 16, borderRadius: 10 }}
          >
            Начать работу
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
            Войти <ArrowRightOutlined />
          </Button>
        </Space>
        <div style={{ marginTop: 20 }}>
          <Tag color="green" style={{ fontSize: 12 }}>6 бирж · All Live</Tag>
          <Tag color="default" style={{ fontSize: 12 }}>4h timeframe</Tag>
          <Tag color="default" style={{ fontSize: 12 }}>mono + synthetic</Tag>
          <Tag color="blue" style={{ fontSize: 12 }}>Multi-tenant SaaS</Tag>
        </div>
      </section>

      {/* ─── METRICS STRIP ─── */}
      <div style={styles.metricsStrip}>
        {METRICS.map((m, i) => (
          <div
            key={i}
            style={{
              ...styles.metricItem,
              borderRight: i < METRICS.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
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
        <div style={styles.sectionTitle}>Три режима для клиентов</div>
        <div style={styles.sectionSub}>
          От пассивного инвестора до продвинутого трейдера — у каждого свой путь
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {CLIENT_MODES.map((m) => (
            <div key={m.title} style={m.highlight ? styles.cardHighlight : styles.card}>
              <div style={{ marginBottom: 12 }}>{m.icon}</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 10 }}>
                {m.title}
                {m.highlight && (
                  <Tag color="blue" style={{ marginLeft: 8, fontSize: 11 }}>Популярный</Tag>
                )}
              </div>
              <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6 }}>{m.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── 3 STRATEGIES ─── */}
      <div style={styles.darkBg}>
        <div style={{ ...styles.section, padding: '0 24px' }}>
          <div style={styles.sectionTitle}>Стратегии</div>
          <div style={styles.sectionSub}>
            3 типа алгоритмов, отобранных из&nbsp;9108 бектестов с&nbsp;robustness-фильтрацией
          </div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {STRATEGIES.map((s) => (
              <div key={s.code} style={styles.stratCard}>
                <div style={{ marginBottom: 12 }}>{s.icon}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{s.name}</div>
                <code style={{ fontSize: 11, color: '#556677', background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: 4 }}>
                  {s.code}
                </code>
                <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6, marginTop: 12 }}>{s.desc}</div>
                <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {s.tags.map((tag) => (
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
          Трёхконтурная архитектура
        </div>
        <div style={styles.sectionSub}>
          Runtime не зависит от Research. Research не влияет на клиентов. Каждый контур изолирован.
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {CIRCUITS.map((c) => (
            <div key={c.title} style={{ ...styles.circuitCard, borderTopColor: c.color, borderTopWidth: 3 }}>
              <div style={{ fontSize: 24, color: c.color, marginBottom: 10 }}>{c.icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 10 }}>{c.title}</div>
              <div style={{ color: '#8899aa', fontSize: 14, lineHeight: 1.6 }}>{c.desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── BACKTEST PROOF ─── */}
      <div style={styles.darkBg}>
        <div style={{ maxWidth: 900, margin: '0 auto', textAlign: 'center', padding: '0 24px' }}>
          <div style={styles.sectionTitle}>
            <TrophyOutlined style={{ marginRight: 10, color: '#f5a623' }} />
            Доказанная методология
          </div>
          <div style={{ ...styles.sectionSub, marginBottom: 36 }}>
            Портфельный бэктест: 6 стратегий IPUSDT/ZECUSDT, full-range 2025–2026
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 16,
          }}>
            {[
              { label: 'Стратегий в портфеле', value: '6', note: 'DD + ZZ, synthetic' },
              { label: 'Период', value: '15+ мес', note: '4h bars, 2025–2026' },
              { label: 'Доходность', value: '+28.7%', note: 'full-range' },
              { label: 'Profit Factor', value: '3.28', note: '>3.0 = превосходно' },
              { label: 'Max Drawdown', value: '4.4%', note: 'портфельная' },
              { label: 'Сделок', value: '416', note: 'Win Rate 43.75%' },
            ].map((row) => (
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
          <div style={{ marginTop: 24, color: '#445566', fontSize: 12 }}>
            * Исторический бэктест на данных Bybit, 4h таймфрейм, с учётом комиссий 0.1% и проскальзывания 0.05%.
            Прошлые результаты не гарантируют будущую доходность.
          </div>
        </div>
      </div>

      {/* ─── EXCHANGES ─── */}
      <div style={{ ...styles.section, textAlign: 'center' }}>
        <div style={styles.sectionTitle}>
          <GlobalOutlined style={{ marginRight: 10, color: '#1677ff' }} />
          Биржевые интеграции
        </div>
        <div style={{ ...styles.sectionSub, marginBottom: 36 }}>
          6 бирж подключено прямо сейчас. Bybit — основной коннектор, остальные через ccxt / native.
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
          {EXCHANGES.map((ex) => (
            <div key={ex.name} style={{
              background: 'rgba(82,196,26,0.07)',
              border: '1px solid rgba(82,196,26,0.28)',
              borderRadius: 12,
              padding: '16px 24px',
              minWidth: 110,
            }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#73d13d' }}>
                {ex.name}
              </div>
              <Tag color="green" style={{ marginTop: 6, fontSize: 10 }}>✓ LIVE</Tag>
              <div style={{ fontSize: 10, color: '#445566', marginTop: 4 }}>{ex.note}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ─── CTA ─── */}
      <div style={styles.ctaSection}>
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <div style={{ fontSize: 'clamp(24px, 4vw, 42px)', fontWeight: 800, color: '#fff', marginBottom: 16 }}>
            Готовы начать?
          </div>
          <div style={{ color: '#8899aa', fontSize: 16, marginBottom: 36, lineHeight: 1.6 }}>
            Зарегистрируйтесь как клиент, подключите API-ключ биржи
            и запустите первую стратегию за несколько минут.
            Или обратитесь для подключения по модели Алгофонда.
          </div>
          <Space size={16} wrap style={{ justifyContent: 'center' }}>
            <Button
              type="primary"
              size="large"
              icon={<RocketOutlined />}
              href="/client/register"
              style={{ height: 52, paddingInline: 32, fontSize: 16, borderRadius: 12 }}
            >
              Зарегистрироваться
            </Button>
            <Button
              size="large"
              icon={<ArrowRightOutlined />}
              href="https://t.me/"
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
              Telegram для связи
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
          <a href="/client/login" style={{ color: '#556677' }}>Клиентский вход</a>
          <a href="/client/register" style={{ color: '#556677' }}>Регистрация</a>
          <a href="/login" style={{ color: '#556677' }}>Администратор</a>
        </div>
        <div style={{ marginTop: 16 }}>
          © 2025–2026 BTDD Platform. Торговля криптовалютой сопряжена с рисками.
          Исторические результаты не гарантируют будущую доходность.
        </div>
      </footer>
    </div>
  );
}
