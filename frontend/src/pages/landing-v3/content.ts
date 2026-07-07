import type { VitrineTile } from './types';

export const VITRINE_EXPAND: VitrineTile[] = [
  { name: 'Hedge Bomb Suite', ret: '+76%', meta: 'хедж · 24 стр', stroke: '#a78bfa', sparkPath: 'M0,17 L25,15 L50,10 L80,5' },
  { name: 'Balanced Shield DCA', ret: '+54%', meta: 'shield · DD 8%', stroke: '#60a5fa', sparkPath: 'M0,20 L30,18 L60,12 L80,8' },
  { name: 'Cloud Stars 1.2', ret: '+112%', meta: 'cloud · curated', stroke: '#f0c419', sparkPath: 'M0,21 L15,19 L35,14 L55,9 L80,4' },
];

export const VITRINE_MAIN: VitrineTile[] = [
  { name: 'Synth Stable Union v4.4', ret: '+142%', meta: '36 стр · PF 1.6', stroke: '#60a5fa', sparkPath: 'M0,20 L20,17 L40,12 L60,7 L80,3' },
  { name: 'TV Momentum Cloud', ret: '+89%', meta: 'L400 · DD 11%', stroke: '#f0c419', sparkPath: 'M0,18 L20,15 L40,11 L60,7 L80,4' },
  { name: 'Mega Synth Shield', ret: '+218%', meta: 'union · PF 1.8', stroke: '#4ade80', sparkPath: 'M0,19 L20,16 L40,11 L60,6 L80,2' },
];

export const ENGINE_CHIPS = [
  { title: 'Stat-arb', short: 'поиск раскорреляции пар', more: 'Z-score входы, хедж по корзине, walk-forward отбор.' },
  { title: 'Синтетика', short: 'хедж и декорреляция', more: 'Портфели с низкой корреляцией, union-карточки.' },
  { title: 'AI-свип', short: 'автооптимизация параметров', more: 'Сотни прогонов, отбор по DD и PF.' },
  { title: 'Order block', short: 'структурные входы', more: 'Уровни ликвидности и структура рынка.' },
  { title: 'Shield DCA', short: 'защита просадки', more: 'Макро-оверлеи и circuit breaker.' },
  { title: 'Мульти-TF', short: '1m — 1d в портфеле', more: 'Разные интервалы в одной ТС.' },
  { title: 'TradingView', short: 'алерты → исполнение (α)', more: 'Webhook из Pine, ваш ключ, наш runtime.' },
];
