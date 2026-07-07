import React, { useEffect } from 'react';
import LandingHeroPanel from './LandingHeroPanel';
import { ENGINE_CHIPS } from './content';
import './landing-v3.css';

export default function LandingPage() {
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  return (
    <div className="landing-v3-root">
      <header className="nav">
        <div className="wrap nav-in">
          <div className="logo">BattleToads</div>
          <nav className="links">
            <a href="#engine">Движок</a>
            <a href="#offer">Режимы</a>
            <a href="#pricing">Тарифы</a>
            <a href="#venture">Инвесторам</a>
          </nav>
          <div>
            <a className="btn" href="/client/login">Войти</a>
            <a className="btn btn-gold" href="/client/register">Регистрация</a>
          </div>
        </div>
      </header>

      <main className="wrap">
        <section className="hero">
          <div>
            <div className="eyebrow">Cloud trading platform</div>
            <h1>
              Алгоритмы торгуют.
              <br />
              <em>Средства в безопасности.</em>
            </h1>
            <p className="lead">
              Подключите API-ключ — торговля в облаке, деньги остаются на бирже под вашим ключом.
              Бэктесты, мониторинг и витрина стратегий в одном кабинете.
            </p>
            <div className="hero-cta">
              <a className="btn btn-gold" href="/client/register">Открыть кабинет</a>
            </div>
          </div>
          <LandingHeroPanel />
        </section>

        <section id="engine">
          <h2>Что внутри движка</h2>
          <p className="sub">Исследовательский контур: сотни конфигураций, walk-forward, портфельная сборка.</p>
          <div className="chips">
            {ENGINE_CHIPS.map((chip, i) => (
              <div key={chip.title} className="chip" style={{ animationDelay: `${0.05 + i * 0.05}s` }}>
                <strong>{chip.title}</strong>
                <span>{chip.short}</span>
                <span className="chip-more">{chip.more}</span>
              </div>
            ))}
          </div>
          <div className="strat-grid">
            <article className="strat-card">
              <div className="ico">📊</div>
              <h3>Бэктест + витрина</h3>
              <p>Каждая система с кривой equity, PF и max DD до подключения к live.</p>
            </article>
            <article className="strat-card">
              <div className="ico">⚡</div>
              <h3>Исполнение 24/7</h3>
              <p>Runtime в облаке: сигналы, риск-лимиты, ребаланс без терминала.</p>
            </article>
            <article className="strat-card">
              <div className="ico">🔐</div>
              <h3>Только API</h3>
              <p>Ключи с правом торговли, без вывода. Остановка — в один клик.</p>
            </article>
          </div>
        </section>

        <section id="offer">
          <h2>Четыре режима работы</h2>
          <p className="sub">Портфель, сборка, копирование или сигнал из TradingView — выбирается при регистрации.</p>
          <div className="pillars">
            <article className="pillar">
              <div className="num">01</div>
              <h3>Готовый портфель</h3>
              <p className="pillar-short">Торговая система с бэктестом — подключили и контролируете риск.</p>
              <p className="pillar-long">Портфель из десятков стратегий собран и протестирован. Выбираете ТС на витрине, задаёте риск — runtime исполняет 24/7.</p>
              <a href="/client/register">Пассивный режим →</a>
            </article>
            <article className="pillar">
              <div className="num">02</div>
              <h3>Сборка из каталога</h3>
              <p className="pillar-short">Сотни оферов с метриками — свой набор стратегий.</p>
              <p className="pillar-long">Фильтр по паре, таймфрейму, доходности и просадке. Сохраняете конфигурацию и масштабируете.</p>
              <a href="/client/register">Активный режим →</a>
            </article>
            <article className="pillar">
              <div className="num">03</div>
              <h3>Копирование сигналов</h3>
              <p className="pillar-short">Мастер-счёт и подписчики на одном API-контуре.</p>
              <p className="pillar-long">Для партнёров и закрытых групп без лимитов биржевого copy-trade.</p>
              <a href="/partner/login">Партнёрам →</a>
            </article>
            <article className="pillar">
              <span className="alpha-badge">ALPHA</span>
              <div className="num">04</div>
              <h3>TradingView алерты</h3>
              <p className="pillar-short">Своя стратегия с TradingView — мы исполняем.</p>
              <p className="pillar-long">Webhook из Pine → облачный runtime на вашем API-ключе. Доступно в бета-программе.</p>
              <a href="/client/register">Режим TV →</a>
            </article>
          </div>
        </section>

        <section id="pricing">
          <h2>Модели оплаты</h2>
          <p className="sub">Бета сейчас, после запуска — фикс или процент с прибыли.</p>
          <div className="pricing">
            <div className="plan featured">
              <span className="badge">Сейчас</span>
              <h3>Бета</h3>
              <p className="hint">Полный доступ без абонплаты</p>
              <p className="price"><span className="strike">$99/мес</span> $0</p>
              <ul>
                <li>Все режимы, включая TV α</li>
                <li>Мониторинг и витрина</li>
                <li>Без комиссии с прибыли</li>
              </ul>
              <div className="pick">Для старта</div>
            </div>
            <div className="plan">
              <h3>Фикс</h3>
              <p className="hint">Предсказуемый ежемесячный платёж</p>
              <p className="price">$99<span style={{ fontSize: 15, color: 'var(--muted)' }}>/мес</span></p>
              <ul>
                <li>Не платите много с профита</li>
                <li>Комиссия с PnL ниже или нулевая</li>
                <li>Стабильный бюджет</li>
              </ul>
              <div className="pick">Долгая работа</div>
            </div>
            <div className="plan">
              <h3>% с прибыли</h3>
              <p className="hint">Только с новой прибыли (HWM)</p>
              <p className="price">40%</p>
              <ul>
                <li>Нет абонплаты</li>
                <li>В минус — комиссия 0</li>
                <li>Меньше риска на старте</li>
              </ul>
              <div className="pick">Без фикса в месяц</div>
            </div>
          </div>
        </section>

        <section id="venture">
          <div className="venture">
            <div>
              <h2 style={{ marginBottom: 8 }}>Для инвесторов и венчуров</h2>
              <p style={{ margin: 0, color: 'var(--muted)', maxWidth: '52ch' }}>
                Unit-экономика, архитектура runtime и due diligence — в whitepaper.
              </p>
            </div>
            <a className="btn btn-gold" href="/whitepaper">Whitepaper →</a>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          © BattleToads · <a href="/whitepaper">Документы</a>
        </div>
      </footer>
    </div>
  );
}
