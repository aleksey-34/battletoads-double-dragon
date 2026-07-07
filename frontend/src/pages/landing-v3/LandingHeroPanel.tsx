import React, { useEffect, useMemo, useState } from 'react';
import { buildCoinChartSvg } from './chartUtils';
import type { LandingDemoPayload, LandingDemoTrade, VitrineTile } from './types';
import { VITRINE_EXPAND, VITRINE_MAIN } from './content';

function VitrineTileCard({ tile }: { tile: VitrineTile }) {
  return (
    <article className="v-tile">
      <strong>{tile.name}</strong>
      <div className="ret">{tile.ret}</div>
      <div className="meta">{tile.meta}</div>
      <svg viewBox="0 0 80 22" preserveAspectRatio="none" aria-hidden>
        <path fill="none" stroke={tile.stroke} strokeWidth="2" d={tile.sparkPath} />
      </svg>
      <a className="v-btn" href="/client/register">Подключить</a>
    </article>
  );
}

function VitrineRail() {
  return (
    <div className="vitrine-wrap">
      <div className="vitrine-slot">
        <aside className="vitrine-rail" aria-label="Витрина торговых систем">
        <div className="vitrine-col vitrine-col--expand" aria-hidden>
          <div className="vitrine-rail__head" style={{ visibility: 'hidden' }}>·</div>
          {VITRINE_EXPAND.map((tile) => (
            <VitrineTileCard key={tile.name} tile={tile} />
          ))}
        </div>
        <div className="vitrine-col vitrine-col--main">
          <div className="vitrine-rail__head">Витрина</div>
          {VITRINE_MAIN.map((tile) => (
            <VitrineTileCard key={tile.name} tile={tile} />
          ))}
        </div>
        </aside>
      </div>
    </div>
  );
}

export default function LandingHeroPanel() {
  const [demo, setDemo] = useState<LandingDemoPayload | null>(null);
  const [activeTrade, setActiveTrade] = useState<LandingDemoTrade | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        let res = await fetch('/api/public/landing-demo-trades');
        if (!res.ok) res = await fetch('/landing-demo-trades.json');
        if (!res.ok) return;
        const data = await res.json() as LandingDemoPayload;
        if (!cancelled) setDemo(data);
      } catch {
        /* preview offline */
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  const trades = demo?.trades || [];
  const coinSvg = useMemo(
    () => (activeTrade ? buildCoinChartSvg(activeTrade) : ''),
    [activeTrade],
  );

  const coinTitle = activeTrade
    ? `${activeTrade.symbol} · ${activeTrade.interval} · ${activeTrade.pnlPct > 0 ? '+' : ''}${activeTrade.pnlPct}%`
    : '';

  const syms = Array.from(new Set(trades.map((t) => t.symbol))).slice(0, 2);

  return (
    <div className="hero-visual">
      <div className="showcase" aria-label="Демо кабинета">
        <div className="showcase-head">
          <div className="showcase-head-left">
            <span className="showcase-label">Демо кабинета</span>
            <span className="live-dot" title="Runtime active" />
          </div>
          <div className="period-tabs">
            <span className="on">1д</span>
            <span>7д</span>
            <span>30д</span>
          </div>
        </div>
        <div className="showcase-body">
          <div className="chart-zone">
            <div className="chart-toolbar">
              <div className="chart-tags">
                <span className="tag eq">Equity <b>$12 840</b></span>
                <span className="tag pnl">PnL <b>+$1 240</b></span>
                <span className="tag dd">DD <b>8.2%</b></span>
                <span className="tag">UPNL <b style={{ color: '#a78bfa' }}>+$186</b></span>
              </div>
            </div>
            <div className="open-pos">
              {trades.length > 0 && (
                <>
                  <span className="pos-label">{trades.length} лучших сделок</span>
                  {syms.map((s) => (
                    <span key={s} className="sym-tag">{s}</span>
                  ))}
                  <span className="pos-label">· {demo?.rotateAfter || 'ежедневно'}</span>
                </>
              )}
            </div>
            <div className="chart-wrap">
              <div className={`coin-title${activeTrade ? ' on' : ''}`}>{coinTitle}</div>
              <svg
                className={`chart-layer equity-view${activeTrade ? ' dim' : ''}`}
                viewBox="0 0 400 200"
                preserveAspectRatio="none"
                aria-hidden={!!activeTrade}
              >
                <defs>
                  <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity=".35" />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <g className="chart-grid">
                  <line x1="0" y1="50" x2="400" y2="50" />
                  <line x1="0" y1="100" x2="400" y2="100" />
                  <line x1="0" y1="150" x2="400" y2="150" />
                  <line x1="100" y1="0" x2="100" y2="200" />
                  <line x1="200" y1="0" x2="200" y2="200" />
                  <line x1="300" y1="0" x2="300" y2="200" />
                </g>
                <path className="chart-fill" fill="url(#eqFill)" d="M0,160 L40,155 L80,148 L120,130 L160,125 L200,110 L240,95 L280,88 L320,72 L360,58 L400,45 L400,200 L0,200 Z" />
                <path className="chart-line" d="M0,160 L40,155 L80,148 L120,130 L160,125 L200,110 L240,95 L280,88 L320,72 L360,58 L400,45" />
              </svg>
              {activeTrade && (
                <svg
                  className="chart-layer coin-view on"
                  viewBox="0 0 400 200"
                  preserveAspectRatio="none"
                  dangerouslySetInnerHTML={{ __html: coinSvg }}
                />
              )}
            </div>
            <div className="chart-hint">Наведи на сделку — реальный график цены с входом и выходом</div>
          </div>
          <aside className="trades-panel">
            <h4>Сделки · лучшие</h4>
            <div className="trades-live">
              <span className="live-dot" style={{ width: 5, height: 5 }} />
              live · обновление раз в сутки
            </div>
            {trades.map((t) => {
              const sideCls = t.side === 'long' ? 'in' : 'out';
              const sideLbl = t.side === 'long' ? 'LONG' : 'SHORT';
              const pnl = `${t.pnlPct > 0 ? '+' : ''}${t.pnlPct}%`;
              return (
                <div
                  key={t.id}
                  className={`trade-row${activeTrade?.id === t.id ? ' active' : ''}`}
                  onMouseEnter={() => setActiveTrade(t)}
                  onMouseLeave={() => setActiveTrade(null)}
                >
                  <span>
                    <span className={sideCls}>{sideLbl}</span>
                    {' '}
                    {t.short}
                  </span>
                  <span className="pnl">{pnl}</span>
                </div>
              );
            })}
          </aside>
        </div>
      </div>
      <VitrineRail />
    </div>
  );
}
