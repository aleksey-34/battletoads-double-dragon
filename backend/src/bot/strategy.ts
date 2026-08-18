
import { MarketMode, Strategy, StrategyType } from '../config/settings';
import {
  applySymbolRiskSettings,
  closePosition,
  getBalances,
  getAllSymbols,
  getPositions,
  isRateLimitError,
  placeOrder,
} from './exchange';
import {
  capBalancedLegQty,
  clampQtyString,
  effectiveMaxQty,
} from './orderQtyGuard';
import { recordLiveTradeEvent } from '../analytics/liveReconciliation';
import logger from '../utils/logger';
import { computeChannelWidthLotMultiplier } from '../services/strategy/sizing';
import { clearMacroShieldPartialState, evaluateMacroShieldExit, getMacroExitOverlayForApiKey, isMacroShieldEnabledForApiKey } from './macroExitShield';
import { getStatArbEntryGateForApiKey, passesStatArbEntryGateLive } from './statArbEntryGate';
import { getOrderBlockEntryGateForApiKey, passesOrderBlockEntryGateLive } from './orderBlockEntryGate';
import {
  buildZzPivotLevelSeries,
  computeZzPivotEntrySignal,
  isZzPivotStrategyType,
  normalizeZzPivotStrategyType,
  zzPivotVariantFromType,
} from './zzPivotLevels';
import { computeCtFractalSignalAtIndex, isCtFractalStrategyType } from './ctFractalSignal';
import {
  computeMomentumScalpSignalAtIndex,
  extractMomentumScalpParams,
  isMomentumScalpStrategyType,
  momentumScalpTpSlPrices,
} from './momentumScalpSignal';
import {
  evaluateMrs2Bar,
  extractMrs2Params,
  isMrs2StrategyType,
  mrs2WarmupBars,
  parseMrs2PendingLimits,
} from './mrs2Signal';
import {
  cancelMrs2RestingLimits,
  parseMrs2PendingWithOrders,
  serializeMrs2PendingWithOrders,
  syncMrs2RestingEntryLimits,
  type Mrs2PendingWithOrders,
} from './mrs2LiveOrders';
import { acquireApiKeyPairEntryLock, acquireSystemEntryLock } from './strategy/mutex';
import {
  buildBalancedQtyPlan,
  buildSingleQtyPlan,
  loadQtyRules,
  MAX_ENTRY_OVERSIZE_FRACTION,
  MAX_POST_OPEN_SHARE_ERROR,
  validateLiveLegBalance,
} from './strategy/sizing';
import type { BalancedQtyPlan, SingleQtyPlan } from './strategy/sizing';

import type {
  StrategySignal,
  StrategyDraft,
  ParsedSyntheticCandle,
  ExecuteStrategyOptions,
  ExecutionCandleContext,
  ComputedSignal,
  StrategyExecutionSource,
} from './strategy/types';
import {
  normalizeStrategy,
  normalizeStrategyType,
  normalizeMarketMode,
  normalizeSymbol,
  normalizeSymbolKey,
  normalizeInterval,
  normalizeCoef,
  normalizeZscoreExit,
  normalizeZscoreStop,
  intervalToMs,
  validateStrategyBinding,
  DEFAULT_STRATEGY,
  getStrategySymbols,
  getStrategyPairKey,
  safeNumber,
  safeBoolean,
} from './strategy/normalize';
import { computeSignal } from './strategy/signals';
import { getCycleSignalCache, makeSignalGroupKey } from './strategy/cycle/cache';
import { POSITION_ALIGNMENT_EXCLUDED_API_KEYS } from './strategy/cycle/algofundSync';
import { countExchangeOpenPositions } from './strategy/cycle/positionGuards';
import {
  ENTRY_OVERSIZE_COOLDOWN_MS,
  ENTRY_OVERSIZE_SKIP_ACTION,
  decideEntryOversizeGate,
  isEntryOversizeCoolingDown,
  markEntryOversizeBlocked,
  shouldLogEntryOversizeBlock,
} from './strategy/cycle/entryOversizeCooldown';
import {
  TRAILING_RATIO_EPSILON,
  RESYNC_CONFIRM_MS,
  cancelStrategyWorkingOrders,
  closeStrategyExposure,
  inferMonoStateFromPosition,
  inferSyntheticStateFromPair,
  loadPairPositionsForValidation,
  loadSinglePositionForValidation,
  partialTpTriggeredByStrategy,
  persistProcessedClosedBar,
  hydrateProcessedClosedBarMemory,
  isClosedBarAlreadyProcessed,
  rememberProcessedClosedBar,
  closedBarDedupeKey,
  resyncPendingFlatByStrategy,
  resolveExecutionCandleContext,
} from './strategy/execution';
import {
  getLatestMarketClose,
  loadStrategyCandles,
} from './strategy/candles';
import {
  getStrategies,
  getStrategySummaries,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  copyStrategyBlock,
  formatActionError,
  getStrategyRow,
  getApiKeyId,
  computeSignalTotalNotional,
  extractUsdtBalance,
  extractUsdtBalanceParts,
} from './strategy/crud';
export type { StrategySummary } from './strategy/types';
export {
  getStrategies,
  getStrategySummaries,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  copyStrategyBlock,
  formatActionError,
};
export { runAutoStrategiesCycle } from './strategy/cycle/autoRun';
export { cancelStrategyWorkingOrders, closeStrategyExposure } from './strategy/execution';


export const executeStrategy = async (
  apiKeyName: string,
  strategyId: number,
  options?: ExecuteStrategyOptions
) => {
  // Lock holder for the trading-system entry critical section.
  // Acquired during OP-limit check (only if system is found) and released at
  // function exit so all post-check ops (placeOrder, state UPDATE) are serialized
  // against other strategies of the same TS within this process.
  let releaseSystemLock: (() => void) | null = null;
  // Cross-TS pair lock: serializes entry on the same (api_key, pair_key) across
  // ALL trading systems of one api_key. Without this, two strategies belonging
  // to different TSs could pyramid the same exchange position.
  let releasePairLock: (() => void) | null = null;
  try {
  const existingRow = await getStrategyRow(apiKeyName, strategyId);
  const strategy = normalizeStrategy(existingRow);

  const executionSource: StrategyExecutionSource = options?.source || 'manual';
  const closedBarOnly = options?.closedBarOnly !== false;
  const dedupeClosedBar = options?.dedupeClosedBar === true;

  if (!strategy.is_active || !strategy.auto_update) {
    return {
      result: 'Strategy is paused',
      action: 'paused',
    };
  }

  const mergedStrategy: Strategy = {
    ...strategy,
  };
  const isPositionAlignmentExcluded = POSITION_ALIGNMENT_EXCLUDED_API_KEYS.has(apiKeyName);
  const marketMode = normalizeMarketMode(mergedStrategy.market_mode);
  const isMono = marketMode === 'mono';
  const positionLabel = isMono ? 'position' : 'synthetic position';

  // Execution must follow persisted strategy settings only.
  // This prevents stale UI/chart payloads from silently mutating strategy pairs.
  const executionBindingPatch: Partial<Strategy> = {};

  if (!mergedStrategy.base_symbol) {
    throw new Error('Strategy requires a base symbol');
  }

  if (!isMono && !mergedStrategy.quote_symbol) {
    throw new Error('Synthetic strategy requires a quote symbol');
  }

  if (!isMono && mergedStrategy.base_symbol === mergedStrategy.quote_symbol) {
    throw new Error('Base and quote symbols must be different');
  }

  const signalLength = Math.max(2, Math.floor(mergedStrategy.price_channel_length));
  const strategyTypeNorm = normalizeStrategyType(mergedStrategy.strategy_type);
  const lookback = (strategyTypeNorm === 'stat_arb_zscore' || strategyTypeNorm === 'CT_Fractal')
    ? Math.max(signalLength + 120, 220)
    : strategyTypeNorm === 'hideep'
      ? Math.max(signalLength + 110, 220)
      : isMomentumScalpStrategyType(strategyTypeNorm)
        ? Math.max(signalLength + 160, 200)
        : isMrs2StrategyType(strategyTypeNorm)
          ? Math.max(mrs2WarmupBars(extractMrs2Params(mergedStrategy)) + 40, 80)
          : Math.max(signalLength + 30, 120);

  const candles = await loadStrategyCandles(apiKeyName, mergedStrategy, lookback);

  const candleContext = resolveExecutionCandleContext(
    candles,
    mergedStrategy.interval,
    closedBarOnly
  );

  // ── Shared signal cache lookup ──────────────────────────────────────────────
  // During auto-cycle, strategies with identical signal parameters share the same
  // pre-computed signal. This guarantees consistency across all accounts trading
  // the same pair with the same strategy settings in a single cycle.
  let computedSignalResult: ComputedSignal;
  const signalGroupKey = makeSignalGroupKey(apiKeyName, mergedStrategy);
  const signalCache = getCycleSignalCache();
  // MRS2 carries per-strategy-row sticky pending state (mrs2_pending_json) into the signal
  // evaluation itself — sharing a cached result across strategy rows (even with identical
  // params) would silently apply one row's sticky limits to another. Always recompute fresh.
  const isMrs2ForSignal = isMrs2StrategyType(strategyTypeNorm);
  const cachedSignal = isMrs2ForSignal ? undefined : signalCache.get(signalGroupKey);

  if (cachedSignal && cachedSignal.evaluatedBarTimeMs === candleContext.evaluatedBarTimeMs) {
    // Re-use cached signal: same bar, same params → same result guaranteed
    computedSignalResult = {
      signal: cachedSignal.signal,
      currentRatio: cachedSignal.currentRatio,
      donchianHigh: cachedSignal.donchianHigh,
      donchianLow: cachedSignal.donchianLow,
      donchianCenter: cachedSignal.donchianCenter,
      zScore: cachedSignal.zScore,
      fastRsi: cachedSignal.fastRsi,
    };
  } else {
    if (isMomentumScalpStrategyType(strategyTypeNorm)) {
      const msParams = extractMomentumScalpParams(mergedStrategy);
      const idx = candleContext.candlesForSignal.length - 1;
      const posSide = (mergedStrategy.state || 'flat') as 'flat' | 'long' | 'short';
      const ms = computeMomentumScalpSignalAtIndex(
        candleContext.candlesForSignal,
        idx,
        msParams,
        undefined,
        posSide,
      );
      computedSignalResult = {
        signal: ms.signal,
        currentRatio: ms.current,
        donchianHigh: ms.current,
        donchianLow: ms.current,
        donchianCenter: ms.current,
        zScore: ms.adx,
        fastRsi: ms.plusDi,
        oppositeCross: ms.oppositeCross,
      };
    } else if (isMrs2ForSignal) {
      const mrs2Params = extractMrs2Params(mergedStrategy);
      const idx = candleContext.candlesForSignal.length - 1;
      const posSide = (mergedStrategy.state || 'flat') as 'flat' | 'long' | 'short';
      const entryPx = Number(mergedStrategy.entry_ratio);
      // Sticky pending: must survive across execution cycles (hamster replace_open_order=false
      // semantics) — load from mrs2_pending_json and feed back as pendingIn, or every cycle
      // behaves as if the limit was just placed this bar (losing multi-bar resting entirely).
      const pendingIn = parseMrs2PendingLimits(mergedStrategy.mrs2_pending_json);
      const action = evaluateMrs2Bar(
        candleContext.candlesForSignal,
        idx,
        mrs2Params,
        posSide,
        Number.isFinite(entryPx) && entryPx > 0 ? entryPx : null,
        pendingIn,
      );
      computedSignalResult = {
        signal: action.exit ? 'none' : action.signal,
        currentRatio: action.fillPrice || action.current,
        donchianHigh: action.levels?.entryShort ?? action.current,
        donchianLow: action.levels?.entryLong ?? action.current,
        donchianCenter: action.current,
        zScore: null,
        mrs2Exit: action.exit,
        mrs2ExitPrice: action.exitPrice,
        mrs2ExitReason: action.exitReason,
        mrs2FillPrice: action.fillPrice,
        mrs2Pending: action.pending,
      };
      // Persist the updated sticky pending immediately — decoupled from the many
      // downstream updateStrategy() calls (which don't touch this column) so the
      // next cycle always sees the latest resting levels regardless of which
      // branch this cycle's execution takes.
      // Persist sticky pending; preserve resting order IDs when levels are unchanged
      // so a later getOpenOrders failure cannot blind-re-place duplicates.
      const prevPending = parseMrs2PendingWithOrders(mergedStrategy.mrs2_pending_json);
      const nextPending: Mrs2PendingWithOrders | null = action.pending
        ? {
          long: action.pending.long ?? null,
          short: action.pending.short ?? null,
          longOrderId: (
            prevPending
            && action.pending.long != null
            && prevPending.long != null
            && Math.abs(action.pending.long - prevPending.long) / prevPending.long * 100 < 0.05
          ) ? (prevPending.longOrderId ?? null) : null,
          shortOrderId: (
            prevPending
            && action.pending.short != null
            && prevPending.short != null
            && Math.abs(action.pending.short - prevPending.short) / prevPending.short * 100 < 0.05
          ) ? (prevPending.shortOrderId ?? null) : null,
        }
        : null;
      const nextPendingJson = serializeMrs2PendingWithOrders(nextPending);
      if (nextPendingJson !== (mergedStrategy.mrs2_pending_json || '{}')) {
        // If levels cleared, drop any resting exchange orders tied to prior pending.
        if (!action.pending) {
          try {
            await cancelMrs2RestingLimits(
              apiKeyName,
              String(mergedStrategy.base_symbol || ''),
              mergedStrategy.mrs2_pending_json,
            );
          } catch (e) {
            logger.warn(`MRS2 cancel resting on clear: ${(e as Error).message}`);
          }
        }
        await updateStrategy(apiKeyName, strategyId, { mrs2_pending_json: nextPendingJson });
        mergedStrategy.mrs2_pending_json = nextPendingJson;
      }
    } else {
      computedSignalResult = computeSignal(
        mergedStrategy.strategy_type || 'DD_BattleToads',
        candleContext.candlesForSignal,
        signalLength,
        mergedStrategy.detection_source,
        mergedStrategy.zscore_entry,
        mergedStrategy.long_enabled,
        mergedStrategy.short_enabled
      );
    }
    if (!isMrs2ForSignal) {
      signalCache.set(signalGroupKey, { ...computedSignalResult, evaluatedBarTimeMs: candleContext.evaluatedBarTimeMs });
    }
  }

  const { signal, currentRatio, donchianHigh, donchianLow, donchianCenter, zScore, fastRsi } = computedSignalResult;
  const momentumOppositeCross = Boolean(computedSignalResult.oppositeCross);
  // ───────────────────────────────────────────────────────────────────────────

  const isCtFractal = isCtFractalStrategyType(String(mergedStrategy.strategy_type || ''));
  const isMomentumScalp = isMomentumScalpStrategyType(String(mergedStrategy.strategy_type || ''));
  const isMrs2 = isMrs2StrategyType(String(mergedStrategy.strategy_type || ''));
  const isStatArb = mergedStrategy.strategy_type === 'stat_arb_zscore' || isCtFractal;
  const isZzPivot = isZzPivotStrategyType(normalizeZzPivotStrategyType(String(mergedStrategy.strategy_type || '')));
  const zscoreExit = normalizeZscoreExit(mergedStrategy.zscore_exit, DEFAULT_STRATEGY.zscore_exit, mergedStrategy.zscore_entry);
  const zscoreStop = normalizeZscoreStop(mergedStrategy.zscore_stop, DEFAULT_STRATEGY.zscore_stop, mergedStrategy.zscore_entry);

  const takeProfitPercent = Math.max(0, mergedStrategy.take_profit_percent);
  let state: 'flat' | 'long' | 'short' = mergedStrategy.state || 'flat';
  let entryRatio: number | null = mergedStrategy.entry_ratio ?? null;
  type StrategyCloseAction =
    | 'take_profit_long'
    | 'take_profit_short'
    | 'stop_loss_long'
    | 'stop_loss_short'
    | 'mean_revert_exit_long'
    | 'mean_revert_exit_short'
    | 'zscore_stop_long'
    | 'zscore_stop_short'
    | 'macro_shield_exit_long'
    | 'macro_shield_exit_short'
    | 'macro_shield_partial'
    | 'mrs2_ma_exit_long'
    | 'mrs2_ma_exit_short'
    | 'mrs2_sl_long'
    | 'mrs2_sl_short';
  let closedAction: StrategyCloseAction | null = null;
  let closedResult: string | null = null;
  const evaluatedBarTimeMs = candleContext.evaluatedBarTimeMs;
  const evaluatedBarIso = new Date(evaluatedBarTimeMs).toISOString();
  const processedBarCacheKey = closedBarDedupeKey(apiKeyName, strategyId);
  if (dedupeClosedBar) {
    hydrateProcessedClosedBarMemory(
      processedBarCacheKey,
      Number(mergedStrategy.last_processed_bar_ms || 0),
    );
  }

  const returnWithProcessedBar = async <T>(payload: T): Promise<T> => {
    if (!dedupeClosedBar) {
      return payload;
    }
    const persisted = await persistProcessedClosedBar(strategyId, evaluatedBarTimeMs);
    if (!persisted) {
      logger.warn(
        `closed-bar persist failed for strategy ${strategyId} bar ${evaluatedBarIso}; fail-closed (do not remember this bar)`,
      );
      return payload;
    }
    rememberProcessedClosedBar(processedBarCacheKey, evaluatedBarTimeMs);
    return payload;
  };

  const recordRuntimeTradeEvent = async (
    tradeType: 'entry' | 'exit',
    side: 'long' | 'short',
    price: number,
    positionSize = 0,
    sourceOrderId?: string,
    sourceSymbol?: string,
    entryPriceOverride?: number,
    actualFillPrice?: number
  ): Promise<void> => {
    const normalizedPrice = Number.isFinite(price) && price > 0 ? price : currentRatio;
    const normalizedSize = Number.isFinite(positionSize) ? Math.max(0, Number(positionSize)) : 0;
    // For exit, entry_price is the original entry (override) — slippage is meaningless here.
    // For entry, entry_price IS the signal/expected price (the bar close used by the strategy).
    const resolvedEntryPrice = tradeType === 'exit' && Number.isFinite(entryPriceOverride) && (entryPriceOverride as number) > 0
      ? entryPriceOverride as number
      : normalizedPrice;
    // Real fill price from the exchange (ccxt order.average / native avgPrice). Falls back to signal price.
    const resolvedActualPrice = Number.isFinite(actualFillPrice) && (actualFillPrice as number) > 0
      ? actualFillPrice as number
      : normalizedPrice;
    // Slippage% is computed only on entry against the signal/expected price (resolvedEntryPrice == signal price for entry).
    // Sign convention: positive = adverse fill (buy higher / sell lower than signal), negative = price improvement.
    let slippagePercent = 0;
    if (tradeType === 'entry' && Number.isFinite(actualFillPrice) && (actualFillPrice as number) > 0
        && Number.isFinite(normalizedPrice) && normalizedPrice > 0
        && Math.abs(resolvedActualPrice - normalizedPrice) / normalizedPrice < 0.05) {
      const direction = side === 'long' ? 1 : -1;
      slippagePercent = direction * ((resolvedActualPrice - normalizedPrice) / normalizedPrice) * 100;
    }
    if (tradeType === 'exit') {
      logger.info(`[pnl_debug_record] strategy=${strategyId} entryPriceOverride=${entryPriceOverride}, isFinite=${Number.isFinite(entryPriceOverride)}, >0=${(entryPriceOverride as number) > 0}, resolvedEntryPrice=${resolvedEntryPrice}, normalizedPrice=${normalizedPrice}, resolvedActualPrice=${resolvedActualPrice}`);
    }
    try {
      await recordLiveTradeEvent(strategyId, {
        trade_type: tradeType,
        side,
        event_origin: 'strategy_signal',
        entry_time: evaluatedBarTimeMs,
        entry_price: resolvedEntryPrice,
        position_size: normalizedSize,
        actual_price: resolvedActualPrice,
        actual_time: Date.now(),
        actual_fee: 0,
        slippage_percent: slippagePercent,
        source_order_id: sourceOrderId,
        source_symbol: sourceSymbol || mergedStrategy.base_symbol,
      });
    } catch (error) {
      logger.warn(`live_trade_events record failed for strategy ${strategyId}: ${formatActionError(error)}`);
    }
  };

  const synthLegSide = (leg: 'base' | 'quote', signalSide: 'long' | 'short'): 'long' | 'short' => {
    if (isMono || leg === 'base') {
      return signalSide;
    }
    return signalSide === 'long' ? 'short' : 'long';
  };

  const orderFillPrice = (order: unknown): number | undefined => {
    const raw = (order as any)?.average
      ?? (order as any)?.avgPrice
      ?? (order as any)?.avg_price
      ?? (order as any)?.price;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  const recordSynthRuntimeEvents = async (
    tradeType: 'entry' | 'exit',
    signalSide: 'long' | 'short',
    ratioPrice: number,
    baseQty: number,
    quoteQty: number,
    baseOrder?: unknown,
    quoteOrder?: unknown,
    entryRatioOverride?: number,
  ): Promise<void> => {
    const baseOrderId = String((baseOrder as any)?.orderId || (baseOrder as any)?.order_id || '').trim() || undefined;
    const quoteOrderId = String((quoteOrder as any)?.orderId || (quoteOrder as any)?.order_id || '').trim() || undefined;
    await recordRuntimeTradeEvent(
      tradeType,
      synthLegSide('base', signalSide),
      ratioPrice,
      baseQty,
      baseOrderId,
      mergedStrategy.base_symbol,
      entryRatioOverride,
      orderFillPrice(baseOrder),
    );
    if (!isMono && mergedStrategy.quote_symbol && quoteQty > 0) {
      const quoteLegPrice = Number.isFinite(Number(quotePrice)) && Number(quotePrice) > 0
        ? Number(quotePrice)
        : ratioPrice;
      await recordRuntimeTradeEvent(
        tradeType,
        synthLegSide('quote', signalSide),
        quoteLegPrice,
        quoteQty,
        quoteOrderId,
        mergedStrategy.quote_symbol,
        entryRatioOverride,
        orderFillPrice(quoteOrder),
      );
    }
  };

  const persistTpAnchorRatio = async (nextAnchor: number | null): Promise<void> => {
    const currentAnchorRaw = mergedStrategy.tp_anchor_ratio;
    const currentAnchor = Number(currentAnchorRaw);

    if (nextAnchor === null) {
      if (currentAnchorRaw === null || currentAnchorRaw === undefined) {
        return;
      }

      await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        tp_anchor_ratio: null,
      });
      mergedStrategy.tp_anchor_ratio = null;
      return;
    }

    const normalizedAnchor = Number(nextAnchor);
    if (!Number.isFinite(normalizedAnchor) || normalizedAnchor <= 0) {
      return;
    }

    if (Number.isFinite(currentAnchor) && Math.abs(currentAnchor - normalizedAnchor) <= TRAILING_RATIO_EPSILON) {
      return;
    }

    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      tp_anchor_ratio: normalizedAnchor,
    });
    mergedStrategy.tp_anchor_ratio = normalizedAnchor;
  };

  const persistFlatAfterExit = async (
    action: StrategyCloseAction,
    signalSnapshot: StrategySignal,
    exitBaseQty = 0,
    exitQuoteQty = 0,
  ): Promise<void> => {
    partialTpTriggeredByStrategy.delete(strategyId);
    clearMacroShieldPartialState(strategyId);
    const exitEntryRatio = entryRatio;
    await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `${action}@${currentRatio}`,
      last_signal: signalSnapshot,
      last_error: null,
    });

    state = 'flat';
    entryRatio = null;
    mergedStrategy.state = 'flat';
    mergedStrategy.entry_ratio = null;
    mergedStrategy.tp_anchor_ratio = null;

    if (signalSnapshot === 'long' || signalSnapshot === 'short') {
      logger.info(`[pnl_debug] strategy=${strategyId} exit ${signalSnapshot}: exitEntryRatio=${exitEntryRatio}, currentRatio=${currentRatio}, mergedEntryRatio=${mergedStrategy.entry_ratio}, diff=${exitEntryRatio != null ? (currentRatio - exitEntryRatio).toFixed(8) : 'null'}`);
      await recordSynthRuntimeEvents(
        'exit',
        signalSnapshot,
        currentRatio,
        exitBaseQty,
        exitQuoteQty,
        undefined,
        undefined,
        exitEntryRatio ?? undefined,
      );
    }
  };

  /**
   * Atomic close+persist: guarantees persistFlatAfterExit runs even if
   * closeStrategyExposure throws (exchange timeout, network error).
   * The position may already be closed on exchange when the error fires,
   * so we must still record the exit and reset state.
   */
  const closeAndRecordExit = async (
    action: StrategyCloseAction,
    signalSnapshot: StrategySignal
  ): Promise<void> => {
    let exitBaseQty = 0;
    let exitQuoteQty = 0;
    try {
      const positions = await getPositions(apiKeyName);
      const list = Array.isArray(positions) ? positions : [];
      const basePos = list.find((position: any) => (
        normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.base_symbol)
        && Number.parseFloat(String(position?.size || '0')) > 0
      ));
      const quotePos = !isMono
        ? list.find((position: any) => (
          normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.quote_symbol)
          && Number.parseFloat(String(position?.size || '0')) > 0
        ))
        : null;
      exitBaseQty = Math.abs(Number.parseFloat(String(basePos?.size || '0')));
      exitQuoteQty = Math.abs(Number.parseFloat(String(quotePos?.size || '0')));
    } catch (positionError) {
      logger.debug(`Could not read exit position sizes for strategy ${strategyId}: ${formatActionError(positionError)}`);
    }
    // Step 1: close on exchange — if this fails, do NOT touch DB state;
    // the position is still open and next cycle will retry.
    await closeStrategyExposure(apiKeyName, mergedStrategy);
    // Step 2: exchange confirmed close — now persist flat + exit event.
    // If THIS fails, resync will catch the discrepancy on the next cycle
    // (state=long/short in DB but flat on exchange → state_resynced_flat).
    await persistFlatAfterExit(action, signalSnapshot, exitBaseQty, exitQuoteQty);
  };

  const livePositions: any[] = [];
  let positionsFetchReliable = true;
  try {
    const fetched = await getPositions(apiKeyName);
    livePositions.push(...(Array.isArray(fetched) ? fetched : []));
  } catch (positionError) {
    if (isRateLimitError(positionError)) {
      positionsFetchReliable = false;
      logger.warn(
        `Position poll unavailable for strategy ${strategyId} (${apiKeyName}): `
        + `${formatActionError(positionError)} — skipping state resync this cycle`
      );
    } else {
      throw positionError;
    }
  }
  const liveBase = livePositions.find((position: any) => {
    return normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.base_symbol)
      && Number.parseFloat(String(position?.size || '0')) > 0;
  }) || null;
  const liveQuote = !isMono
    ? livePositions.find((position: any) => {
      return normalizeSymbolKey(position?.symbol) === normalizeSymbolKey(mergedStrategy.quote_symbol)
        && Number.parseFloat(String(position?.size || '0')) > 0;
    }) || null
    : null;

  const livePairState = isMono
    ? inferMonoStateFromPosition(liveBase)
    : inferSyntheticStateFromPair(liveBase, liveQuote);

  if (livePairState === 'mixed') {
    // Mixed pair state means only ONE leg is visible on the exchange.
    // When multiple strategies share symbols on the same API key, one leg may belong
    // to a different strategy. Force-closing destroys other strategies' positions and
    // causes an open→mixed→close→open loop that bleeds the account via fees.
    //
    // NEW: if this strategy is flat, the visible leg almost certainly belongs to another
    // strategy — skip entirely. If in-position, use a long grace period (5 min) to
    // avoid race conditions from propagation delay or rate-limit glitches.
    if (state === 'flat') {
      logger.info(
        `Mixed pair state for strategy ${strategyId} (state=flat) — skipping; visible leg likely belongs to another strategy`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — strategy is flat, leg belongs to another strategy',
        action: 'mixed_skip_flat',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const MIXED_GRACE_MS = 90_000; // 90s — OP pair conflict now active, shorter grace sufficient
    const lastUpdatedMs = mergedStrategy.updated_at
      ? new Date(String(mergedStrategy.updated_at).replace(' ', 'T') + 'Z').getTime()
      : 0;
    const msSinceUpdate = Date.now() - lastUpdatedMs;

    if (msSinceUpdate < MIXED_GRACE_MS) {
      logger.warn(
        `Mixed pair state for strategy ${strategyId} (state=${state}, ${Math.round(msSinceUpdate / 1000)}s since update) ` +
        `— skipping close within ${MIXED_GRACE_MS / 1000}s grace period`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — within post-open grace period',
        action: 'mixed_grace_skip',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    if (isPositionAlignmentExcluded) {
      logger.warn(
        `Mixed pair state for strategy ${strategyId} (${apiKeyName}) is excluded from auto-alignment close`
      );
      return returnWithProcessedBar({
        result: 'Mixed pair state skipped — api key excluded from position alignment',
        action: 'mixed_skip_alignment_excluded',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const previousState = state;
    const previousEntryRatio = entryRatio;
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `desync_closed_mixed@${currentRatio}`,
      last_error: null,
    });

    if (previousState === 'long' || previousState === 'short') {
      await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
    }

    logger.warn(`Detected mixed pair state for strategy ${strategyId}; positions were closed (was ${previousState})`);
    return returnWithProcessedBar({
      result: 'Mixed pair positions detected and closed',
      action: 'desync_closed_mixed',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state !== 'flat' && livePairState !== 'flat' && state !== livePairState) {
    if (isPositionAlignmentExcluded) {
      logger.warn(
        `State mismatch for strategy ${strategyId} (${apiKeyName}) is excluded from auto-alignment close`
      );
      return returnWithProcessedBar({
        result: 'Live/strategy mismatch skipped — api key excluded from position alignment',
        action: 'state_mismatch_skip_alignment_excluded',
        strategy: mergedStrategy,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const previousState = state;
    const previousEntryRatio = entryRatio;
    await closeStrategyExposure(apiKeyName, mergedStrategy);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_action: `desync_closed_state_mismatch@${currentRatio}`,
      last_error: null,
    });

    if (previousState === 'long' || previousState === 'short') {
      await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
    }

    logger.warn(`Detected wrong-side live state for strategy ${strategyId}; was ${previousState}, live=${livePairState}; positions were closed`);
    return returnWithProcessedBar({
      result: 'Live pair state mismatched strategy state and was closed',
      action: 'desync_closed_state_mismatch',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === 'flat' && livePairState !== 'flat') {
    // When multiple strategies share symbols on the same API key, visible positions
    // likely belong to other strategies. Do NOT close or adopt them — this strategy
    // should remain flat and wait for its own entry signal.
    logger.info(
      `Strategy ${strategyId} is flat but live pair state is ${livePairState} — ` +
      `skipping; positions likely belong to another strategy on same API key`
    );
    return returnWithProcessedBar({
      result: `Strategy flat, live=${livePairState} — skipped to avoid cross-strategy interference`,
      action: 'flat_skip_shared_positions',
      strategy: mergedStrategy,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (positionsFetchReliable && state !== 'flat' && livePairState === 'flat') {
    // ── Two-stage confirmation guard ──
    // Bug context: a single transient empty getPositions() response (rate-limit
    // glitch, propagation race when a sibling SAAS strategy on the same apiKey
    // just opened/closed) used to immediately write `state_resynced_flat`,
    // destroying open trades and leaving orphan positions on exchange.
    //
    // Defense:
    //   (a) Sibling guard — if any other ACTIVE strategy on the same (apiKey,
    //       base_symbol) is currently in non-flat state, the visible "flat"
    //       may be a stale snapshot taken between sibling open/close calls.
    //       Skip resync entirely; sibling will keep position correct.
    //   (b) Two-cycle confirmation — first detection logs warning + remembers
    //       timestamp; only on a SECOND consecutive flat observation
    //       at least RESYNC_CONFIRM_MS later do we actually resync state.
    let siblingActiveCount = 0;
    try {
      const { db } = await import('../utils/database');
      const sibRow: any = await db.get(
        `SELECT COUNT(*) AS cnt FROM strategies s
         JOIN api_keys ak ON ak.id = s.api_key_id
         WHERE ak.name = ?
           AND s.base_symbol = ?
           AND s.id <> ?
           AND s.is_active = 1
           AND IFNULL(s.is_archived, 0) = 0
           AND s.state IN ('long','short')`,
        [apiKeyName, mergedStrategy.base_symbol, strategyId]
      );
      siblingActiveCount = Number(sibRow?.cnt || 0);
    } catch (sibErr) {
      logger.warn(`Sibling-check query failed for resync guard (strategy ${strategyId}): ${(sibErr as Error)?.message || sibErr}`);
    }

    if (siblingActiveCount > 0) {
      // Sibling holds a position — visible "flat" is almost certainly a
      // pre-aggregation race; skip and clear any pending confirmation.
      resyncPendingFlatByStrategy.delete(strategyId);
      logger.warn(
        `Skipping state_resynced_flat for strategy ${strategyId} (${apiKeyName}/${mergedStrategy.base_symbol}): ` +
        `${siblingActiveCount} sibling(s) still in non-flat state — visible 'flat' may be stale snapshot`
      );
    } else {
      if (isPositionAlignmentExcluded) {
        resyncPendingFlatByStrategy.delete(strategyId);
        logger.warn(
          `Skipping state_resynced_flat for strategy ${strategyId} (${apiKeyName}): api key excluded from position alignment`
        );
      } else {
      const nowMs = Date.now();
      const pending = resyncPendingFlatByStrategy.get(strategyId);
      if (!pending) {
        resyncPendingFlatByStrategy.set(strategyId, { firstDetectedMs: nowMs, lastRatio: currentRatio });
        logger.warn(
          `Resync candidate for strategy ${strategyId} (${apiKeyName}/${mergedStrategy.base_symbol}): ` +
          `state=${state} but exchange flat. Will require ${RESYNC_CONFIRM_MS / 1000}s confirmation before resyncing.`
        );
      } else if (nowMs - pending.firstDetectedMs < RESYNC_CONFIRM_MS) {
        // Still inside the confirmation window — keep waiting.
        logger.warn(
          `Resync still pending for strategy ${strategyId}: ` +
          `${Math.round((nowMs - pending.firstDetectedMs) / 1000)}s of ${RESYNC_CONFIRM_MS / 1000}s`
        );
      } else {
        // Confirmed: TWO consecutive flat detections separated by ≥ RESYNC_CONFIRM_MS, no siblings.
        resyncPendingFlatByStrategy.delete(strategyId);
        const previousState = state;
        const previousEntryRatio = entryRatio;

        await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_action: `state_resynced_flat@${currentRatio}`,
          last_error: null,
        });

        state = 'flat';
        entryRatio = null;
        mergedStrategy.state = 'flat';
        mergedStrategy.entry_ratio = null;
        mergedStrategy.tp_anchor_ratio = null;

        if (previousState === 'long' || previousState === 'short') {
          logger.warn(`State resynced to flat for strategy ${strategyId} (${apiKeyName}): was ${previousState}, entry_ratio=${previousEntryRatio}, current_ratio=${currentRatio} (CONFIRMED after ${RESYNC_CONFIRM_MS / 1000}s)`);
          await recordRuntimeTradeEvent('exit', previousState, currentRatio, 0, undefined, mergedStrategy.base_symbol, previousEntryRatio ?? undefined);
        }
      }
      }
    }
  } else {
    // Any non-flat live observation clears a pending resync.
    if (resyncPendingFlatByStrategy.has(strategyId)) {
      resyncPendingFlatByStrategy.delete(strategyId);
    }
  }

  if (dedupeClosedBar && isClosedBarAlreadyProcessed(processedBarCacheKey, evaluatedBarTimeMs)) {
    return {
      result: `Bar ${evaluatedBarIso} already processed`,
      action: 'bar_already_processed',
      executionSource,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (dedupeClosedBar) {
    const claimed = await persistProcessedClosedBar(strategyId, evaluatedBarTimeMs);
    if (!claimed) {
      logger.warn(
        `closed-bar persist failed for strategy ${strategyId} (${apiKeyName}) bar ${evaluatedBarIso}; skip trade (fail-closed)`,
      );
      return {
        result: `Bar ${evaluatedBarIso} persist failed (fail-closed)`,
        action: 'bar_persist_failed',
        executionSource,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      };
    }
    rememberProcessedClosedBar(processedBarCacheKey, evaluatedBarTimeMs);
  }

  const strategyType = String(mergedStrategy.strategy_type || '');
  if (!closedAction && (state === 'long' || state === 'short')
    && strategyType !== 'dca'
    && strategyType !== 'dca_futures') {
    try {
      if (await isMacroShieldEnabledForApiKey(apiKeyName)) {
        const overlay = await getMacroExitOverlayForApiKey(apiKeyName);
        if (overlay) {
          const macroSignal = await evaluateMacroShieldExit(
            apiKeyName,
            state,
            String(mergedStrategy.base_symbol || ''),
            overlay,
            strategyId,
          );
          if (macroSignal?.action === 'full') {
            const fullAction: StrategyCloseAction = state === 'long'
              ? 'macro_shield_exit_long'
              : 'macro_shield_exit_short';
            await closeAndRecordExit(fullAction, state);
            closedAction = fullAction;
            closedResult = `Macro shield full exit for ${state} ${positionLabel} (${macroSignal.detail})`;
          } else if (macroSignal?.action === 'partial') {
            try {
              for (const sym of getStrategySymbols(mergedStrategy)) {
                await closePositionPercent(apiKeyName, strategyId, sym, macroSignal.closePercent);
              }
              closedAction = 'macro_shield_partial';
              closedResult = `Macro shield partial ${macroSignal.closePercent}% for ${state} ${positionLabel} (${macroSignal.detail})`;
              logger.info(`Macro shield partial ${macroSignal.closePercent}% for strategy ${strategyId}: ${macroSignal.detail}`);
            } catch (partialErr) {
              logger.warn(`Macro shield partial failed for ${strategyId}: ${formatActionError(partialErr)}`);
            }
          }
        }
      }
    } catch (macroErr) {
      logger.warn(`Macro shield check failed for strategy ${strategyId} (${apiKeyName}): ${formatActionError(macroErr)}`);
    }
  }

  if (isStatArb) {
    const hasZScore = Number.isFinite(zScore);

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) <= -zscoreStop) {
      await closeAndRecordExit('zscore_stop_long', 'long');
      closedAction = 'zscore_stop_long';
      closedResult = `Z-score stop hit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) >= zscoreStop) {
      await closeAndRecordExit('zscore_stop_short', 'short');
      closedAction = 'zscore_stop_short';
      closedResult = `Z-score stop hit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'long' && hasZScore && Number(zScore) >= -zscoreExit) {
      await closeAndRecordExit('mean_revert_exit_long', 'long');
      closedAction = 'mean_revert_exit_long';
      closedResult = `Mean-reversion exit for long ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }

    if (!closedAction && state === 'short' && hasZScore && Number(zScore) <= zscoreExit) {
      await closeAndRecordExit('mean_revert_exit_short', 'short');
      closedAction = 'mean_revert_exit_short';
      closedResult = `Mean-reversion exit for short ${positionLabel} (z=${Number(zScore).toFixed(3)})`;
    }
  }

  if (!closedAction && (mergedStrategy.strategy_type === 'hideep' || isCtFractal)) {
    const rsiVal = isCtFractal ? fastRsi : zScore;
    if (Number.isFinite(rsiVal)) {
      if (state === 'long' && Number(rsiVal) > 90) {
        await closeAndRecordExit('mean_revert_exit_long', 'long');
        closedAction = 'mean_revert_exit_long';
        closedResult = `HiDeep RSI exit for long ${positionLabel} (rsi=${Number(rsiVal).toFixed(1)})`;
      } else if (state === 'short' && Number(rsiVal) < 10) {
        await closeAndRecordExit('mean_revert_exit_short', 'short');
        closedAction = 'mean_revert_exit_short';
        closedResult = `HiDeep RSI exit for short ${positionLabel} (rsi=${Number(rsiVal).toFixed(1)})`;
      }
    }
  }

  if (!closedAction && isMomentumScalp && entryRatio && (state === 'long' || state === 'short')) {
    const msParams = extractMomentumScalpParams(mergedStrategy);
    const { tp, sl } = momentumScalpTpSlPrices(state, entryRatio, msParams);
    // Live exits on closed-bar close (currentRatio), not intrabar wick — BT must match.
    if (state === 'long') {
      if (currentRatio <= sl) {
        await closeAndRecordExit('stop_loss_long', 'long');
        closedAction = 'stop_loss_long';
        closedResult = `Momentum scalp SL long ${positionLabel}`;
      } else if (currentRatio >= tp) {
        await closeAndRecordExit('take_profit_long', 'long');
        closedAction = 'take_profit_long';
        closedResult = `Momentum scalp TP long ${positionLabel}`;
      } else if (msParams.exitOnOppositeCross && momentumOppositeCross) {
        await closeAndRecordExit('stop_loss_long', 'long');
        closedAction = 'stop_loss_long';
        closedResult = `Momentum scalp cross-exit long ${positionLabel}`;
      }
    } else if (!closedAction) {
      if (currentRatio >= sl) {
        await closeAndRecordExit('stop_loss_short', 'short');
        closedAction = 'stop_loss_short';
        closedResult = `Momentum scalp SL short ${positionLabel}`;
      } else if (currentRatio <= tp) {
        await closeAndRecordExit('take_profit_short', 'short');
        closedAction = 'take_profit_short';
        closedResult = `Momentum scalp TP short ${positionLabel}`;
      } else if (msParams.exitOnOppositeCross && momentumOppositeCross) {
        await closeAndRecordExit('stop_loss_short', 'short');
        closedAction = 'stop_loss_short';
        closedResult = `Momentum scalp cross-exit short ${positionLabel}`;
      }
    }
  }

  if (!closedAction && isMrs2 && computedSignalResult.mrs2Exit && (state === 'long' || state === 'short')) {
    const raw = String(computedSignalResult.mrs2ExitReason || '');
    const reason: StrategyCloseAction = (
      raw === 'mrs2_sl_long' || raw === 'mrs2_sl_short'
      || raw === 'mrs2_ma_exit_long' || raw === 'mrs2_ma_exit_short'
    ) ? raw as StrategyCloseAction
      : (state === 'long' ? 'mrs2_ma_exit_long' : 'mrs2_ma_exit_short');
    await closeAndRecordExit(reason, state);
    closedAction = reason;
    closedResult = `MRS2 exit ${positionLabel} @ ${Number(computedSignalResult.mrs2ExitPrice || currentRatio).toFixed(6)}`;
  }

  if (!isStatArb && !isMomentumScalp && !isMrs2) {
    const evalBar = candleContext.candlesForSignal[candleContext.candlesForSignal.length - 1];

    if (!closedAction && isZzPivot && state === 'long' && evalBar && evalBar.low <= donchianLow) {
      await closeAndRecordExit('stop_loss_long', 'long');
      closedAction = 'stop_loss_long';
      closedResult = `ZZ SAR long exit at level ${donchianLow.toFixed(6)}`;
    }

    if (!closedAction && isZzPivot && state === 'short' && evalBar && evalBar.high >= donchianHigh) {
      await closeAndRecordExit('stop_loss_short', 'short');
      closedAction = 'stop_loss_short';
      closedResult = `ZZ SAR short exit at level ${donchianHigh.toFixed(6)}`;
    }

    if (!closedAction && state === 'long' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.max(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 - takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio <= trailingStop) {
        await closeAndRecordExit('take_profit_long', 'long');
        closedAction = 'take_profit_long';
        closedResult = `Take-profit hit for long ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP long triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    if (!closedAction && state === 'short' && takeProfitPercent > 0) {
      const anchorFromStorage = Number(mergedStrategy.tp_anchor_ratio);
      let trailingAnchor = Number.isFinite(anchorFromStorage) && anchorFromStorage > 0
        ? anchorFromStorage
        : (entryRatio && entryRatio > 0 ? entryRatio : currentRatio);

      const nextAnchor = Math.min(trailingAnchor, currentRatio);
      if (!Number.isFinite(anchorFromStorage) || Math.abs(nextAnchor - anchorFromStorage) > TRAILING_RATIO_EPSILON) {
        await persistTpAnchorRatio(nextAnchor);
      }

      trailingAnchor = Number.isFinite(Number(mergedStrategy.tp_anchor_ratio))
        ? Number(mergedStrategy.tp_anchor_ratio)
        : nextAnchor;

      const trailingStop = trailingAnchor * (1 + takeProfitPercent / 100);
      if (Number.isFinite(trailingStop) && currentRatio >= trailingStop) {
        await closeAndRecordExit('take_profit_short', 'short');
        closedAction = 'take_profit_short';
        closedResult = `Take-profit hit for short ${positionLabel}`;

        logger.info(`DD_BattleToads trailing TP short triggered for strategy ${strategyId} (${apiKeyName})`);
      }
    }

    // Partial TP (50% close) when partial_tp_pct > 0 and not yet triggered
    const partialTpPct = mergedStrategy.partial_tp_pct ?? 0;
    if (!closedAction && partialTpPct > 0 && !partialTpTriggeredByStrategy.get(strategyId)) {
      const partialPnlPct = state === 'long'
        ? ((currentRatio / (entryRatio ?? currentRatio)) - 1) * 100
        : (((entryRatio ?? currentRatio) / currentRatio) - 1) * 100;
      if (Number.isFinite(partialPnlPct) && partialPnlPct >= partialTpPct) {
        try {
          for (const sym of getStrategySymbols(mergedStrategy)) {
            await closePositionPercent(apiKeyName, strategyId, sym, 50);
          }
          partialTpTriggeredByStrategy.set(strategyId, true);
          if (entryRatio && entryRatio > 0) await persistTpAnchorRatio(entryRatio);
          logger.info(`Partial TP (50%) for strategy ${strategyId}: PnL=${partialPnlPct.toFixed(2)}%`);
        } catch (err) {
          logger.warn(`Partial TP failed for ${strategyId}: ${(err as Error)?.message}`);
        }
      }
    }

    if (!closedAction && !isZzPivot && state === 'long' && entryRatio && currentRatio <= donchianCenter) {
      await closeAndRecordExit('stop_loss_long', 'long');
      closedAction = 'stop_loss_long';
      closedResult = `Stop-loss (center) hit for long ${positionLabel}`;

      logger.info(`DD_BattleToads SL long triggered for strategy ${strategyId} (${apiKeyName})`);
    }

    if (!closedAction && !isZzPivot && state === 'short' && entryRatio && currentRatio >= donchianCenter) {
      await closeAndRecordExit('stop_loss_short', 'short');
      closedAction = 'stop_loss_short';
      closedResult = `Stop-loss (center) hit for short ${positionLabel}`;

      logger.info(`DD_BattleToads SL short triggered for strategy ${strategyId} (${apiKeyName})`);
    }
  }

  if (signal === 'none') {
    const noSignalResult = isMrs2
      ? 'No MRS2 fill (sticky limits may rest)'
      : (isStatArb ? 'No z-score signal' : (isZzPivot ? 'No ZZ pivot signal' : 'No Donchian signal'));
    const noSignalAction = closedAction
      ? `${closedAction}_then_no_signal@${currentRatio}`
      : `no_signal@${currentRatio}`;

    // Mono MRS2: while flat with sticky pending bands, keep resting limit orders on exchange
    // so fills can happen between cycles (hamster post_only path). Synthetic = market only.
    const isMonoMrs2 = isMrs2
      && String(mergedStrategy.market_mode || '').toLowerCase() === 'mono'
      && (state === 'flat' || Boolean(closedAction));
    let mrs2OversizeSkipReason: string | null = null;
    if (isMonoMrs2 && parseMrs2PendingLimits(mergedStrategy.mrs2_pending_json)) {
      const cooldown = isEntryOversizeCoolingDown(apiKeyName, strategyId);
      const cooldownGate = decideEntryOversizeGate({
        coolingDown: cooldown.active,
        cooldownReason: cooldown.reason,
        remainingMs: cooldown.remainingMs,
        oversize: 0,
        maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
      });
      if (cooldownGate.action === 'skip_cooldown') {
        // Quiet skip: no balances / openOrders / place — cool-down already recorded.
        mrs2OversizeSkipReason = cooldownGate.reason;
      } else {
        try {
          const px = await getLatestMarketClose(apiKeyName, mergedStrategy.base_symbol);
          const plan = await buildSingleQtyPlan(
            apiKeyName,
            mergedStrategy.base_symbol,
            px,
            // Use strategy lot% of equity — same sizing path as entries; totalNotional
            // is computed later for entries, so approximate from balances here.
            await (async () => {
              const equity = extractUsdtBalance(await getBalances(apiKeyName));
              const lot = Math.max(0.1, Number(mergedStrategy.lot_long_percent || 6));
              return Math.max(5, equity * (lot / 100));
            })(),
          );
          // Same hard ceiling as market entries: never rest a limit order whose lot is
          // already >1.5x the target (coarse qty step / minOrderQty on the symbol) —
          // cool-down so we do not re-scan / re-place every cycle for permanently-too-small accounts.
          const oversizeGate = decideEntryOversizeGate({
            coolingDown: false,
            oversize: plan.oversize,
            maxOversizeFraction: MAX_ENTRY_OVERSIZE_FRACTION,
          });
          if (oversizeGate.action === 'block_oversize') {
            const blocked = markEntryOversizeBlocked(apiKeyName, strategyId, {
              oversize: plan.oversize,
              targetNotional: plan.targetNotional,
              actualNotional: plan.notional,
              detail: (
                `MRS2 resting skip: min-lot ${(plan.oversize * 100).toFixed(1)}% above target `
                + `(target=${plan.targetNotional.toFixed(2)}, actual=${plan.notional.toFixed(2)})`
              ),
            });
            mrs2OversizeSkipReason = blocked.reason;
            if (shouldLogEntryOversizeBlock(apiKeyName, strategyId)) {
              logger.warn(
                `[position-cap] MRS2 resting-limit sync BLOCKED for strategy ${strategyId} (${apiKeyName}): `
                + `${blocked.reason} — cool-down ${Math.round(ENTRY_OVERSIZE_COOLDOWN_MS / 60_000)}min `
                + `(${ENTRY_OVERSIZE_SKIP_ACTION})`
              );
              try {
                const { db } = await import('../utils/database');
                await db.run(
                  `INSERT INTO strategy_runtime_events
                   (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
                   VALUES (?, ?, ?, 'entry_oversize_blocked', ?, ?, 0, ?)`,
                  [
                    apiKeyName,
                    strategyId,
                    mergedStrategy.name || mergedStrategy.base_symbol,
                    blocked.reason,
                    JSON.stringify({
                      oversizePercent: (plan.oversize * 100).toFixed(2),
                      targetNotional: plan.targetNotional,
                      actualNotional: plan.notional,
                      path: 'mrs2_resting_sync',
                      action: ENTRY_OVERSIZE_SKIP_ACTION,
                    }),
                    Date.now(),
                  ]
                );
              } catch (eventErr) {
                logger.warn(`Failed to record MRS2 entry_oversize_blocked event: ${(eventErr as Error).message}`);
              }
            }
          } else {
            const synced = await syncMrs2RestingEntryLimits({
              apiKeyName,
              symbol: String(mergedStrategy.base_symbol || ''),
              pendingLevels: parseMrs2PendingLimits(mergedStrategy.mrs2_pending_json),
              pendingRaw: mergedStrategy.mrs2_pending_json,
              qty: plan.qty,
            });
            if (synced !== (mergedStrategy.mrs2_pending_json || '{}')) {
              await updateStrategy(apiKeyName, strategyId, { mrs2_pending_json: synced });
              mergedStrategy.mrs2_pending_json = synced;
            }
          }
        } catch (e) {
          logger.warn(`MRS2 resting-limit sync failed for ${strategyId}: ${(e as Error).message}`);
        }
      }
    }

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: 'none',
      last_action: mrs2OversizeSkipReason
        ? `${ENTRY_OVERSIZE_SKIP_ACTION}@${currentRatio}`
        : noSignalAction,
      last_error: mrs2OversizeSkipReason,
    });

    return returnWithProcessedBar({
      result: closedResult || (mrs2OversizeSkipReason
        ? `MRS2 resting skipped: ${mrs2OversizeSkipReason}`
        : noSignalResult),
      action: mrs2OversizeSkipReason
        ? ENTRY_OVERSIZE_SKIP_ACTION
        : (closedAction ? `${closedAction}_no_signal` : 'no_signal'),
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (isZzPivot && state !== 'flat') {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_then_hold_${state}@${currentRatio}`
        : `hold_${state}@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || `ZZ ${state}: waiting SAR exit`,
      action: `hold_${state}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  if (state === signal) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_then_hold_${signal}@${currentRatio}`
        : `hold_${signal}@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: `Signal ${signal} already in position`,
      action: `hold_${signal}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  const closedSameSide = closedAction !== null && (
    (signal === 'long' && closedAction.endsWith('_long')) ||
    (signal === 'short' && closedAction.endsWith('_short'))
  );

  if (closedSameSide) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_signal: signal,
      last_action: `${closedAction}_cooldown_skip@${currentRatio}`,
      last_error: null,
    });

    logger.info(`Cooldown: skipping same-side re-entry ${signal} after ${closedAction} for strategy ${strategyId} (${apiKeyName})`);

    return returnWithProcessedBar({
      result: closedResult || `Position closed; same-direction re-entry skipped (cooldown after ${closedAction})`,
      action: `${closedAction}_cooldown_skip`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  // Backtest parity: after any exit on the evaluated closed bar, defer re-entry to the next bar.
  if (closedAction && state === 'flat' && (signal === 'long' || signal === 'short')) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      tp_anchor_ratio: null,
      last_signal: signal,
      last_action: `${closedAction}_same_bar_no_reentry@${currentRatio}`,
      last_error: null,
    });

    logger.info(
      `Same-bar re-entry blocked for strategy ${strategyId} (${apiKeyName}): `
      + `exit=${closedAction}, deferred signal=${signal}`
    );

    return returnWithProcessedBar({
      result: closedResult || `Exit on current bar; re-entry deferred to next closed bar`,
      action: `${closedAction}_same_bar_no_reentry`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  // CT multi-bar re-entry cooldown (CT_REENTRY_MIN_BARS). Default 0 = disabled beyond same-bar guard.
  // On 4h, 3 bars ≈ 12h; on 1h, 12 bars ≈ 12h. Reduces LINK/HBAR churn without changing TF.
  if (
    isCtFractal
    && state === 'flat'
    && !closedAction
    && (signal === 'long' || signal === 'short')
  ) {
    const minBars = Math.max(0, Math.floor(Number(process.env.CT_REENTRY_MIN_BARS || 0) || 0));
    if (minBars > 0) {
      const lastAction = String(mergedStrategy.last_action || '');
      const exitMarkers = [
        'mean_revert_exit',
        'zscore_stop',
        'take_profit',
        'stop_loss',
        'macro_shield',
        'signal_flip',
        'desync_closed',
      ];
      const looksLikeExit = exitMarkers.some((m) => lastAction.includes(m));
      if (looksLikeExit && mergedStrategy.updated_at) {
        const updatedAtMs = new Date(String(mergedStrategy.updated_at).replace(' ', 'T') + 'Z').getTime();
        const barMs = intervalToMs(mergedStrategy.interval);
        if (Number.isFinite(updatedAtMs) && updatedAtMs > 0 && barMs > 0) {
          const coolUntilMs = updatedAtMs + minBars * barMs;
          if (evaluatedBarTimeMs < coolUntilMs) {
            const updated = await updateStrategy(apiKeyName, strategyId, {
              ...executionBindingPatch,
              state: 'flat',
              entry_ratio: null,
              tp_anchor_ratio: null,
              last_signal: signal,
              last_action: `${lastAction.split('@')[0] || 'exit'}_ct_reentry_cooldown@${currentRatio}`,
              last_error: null,
            });
            logger.info(
              `CT re-entry cooldown: skip ${signal} for strategy ${strategyId} (${apiKeyName}) — `
              + `minBars=${minBars}, until=${new Date(coolUntilMs).toISOString()}`
            );
            return returnWithProcessedBar({
              result: `CT re-entry cooldown (${minBars} bars) after exit`,
              action: 'ct_reentry_cooldown',
              strategy: updated,
              currentRatio,
              donchianHigh,
              donchianLow,
              donchianCenter,
            });
          }
        }
      }
    }
  }

  // ── Cold-start guard: skip entry on first N bars after strategy materialization ──
  // Prevents entering on a stale signal that was already in progress before this
  // account was activated. Wait for a fresh signal generated after materialization.
  // COLD_START_BARS env (default 1): number of closed bars to skip before first entry.
  if (state === 'flat' && !closedAction) {
    const coldStartBars = Math.max(0, Math.floor(Number(process.env.COLD_START_BARS ?? 1) || 1));
    if (coldStartBars > 0 && mergedStrategy.created_at) {
      const createdAtMs = new Date(String(mergedStrategy.created_at).replace(' ', 'T') + 'Z').getTime();
      if (Number.isFinite(createdAtMs) && createdAtMs > 0) {
        const barMs = intervalToMs(mergedStrategy.interval);
        const coldUntilMs = createdAtMs + coldStartBars * barMs;
        if (evaluatedBarTimeMs < coldUntilMs) {
          const remainingMs = coldUntilMs - evaluatedBarTimeMs;
          logger.info(
            `Cold-start: skipping entry signal ${signal} for strategy ${strategyId} (${apiKeyName}) — ` +
            `strategy created ${new Date(createdAtMs).toISOString()}, ` +
            `cold_start_bars=${coldStartBars}, bar_interval=${mergedStrategy.interval}, ` +
            `entry allowed after ${new Date(coldUntilMs).toISOString()} (${Math.ceil(remainingMs / barMs)} bars remaining)`
          );

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: `cold_start_skip@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `Cold-start: entry skipped, waiting for first signal after materialization (${Math.ceil(remainingMs / barMs)} bars remaining)`,
            action: 'cold_start_skip',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }
  }

  // ── Position Limiter (ОП): check if trading system allows more open positions ──
  {
    const { db } = await import('../utils/database');

    // Acquire cross-TS pair lock FIRST (before any OP checks). This serializes
    // ALL strategies on the same (api_key, pair) regardless of which TS they
    // belong to. Without this, two strategies in different TSs of one api_key
    // would race past their per-TS OP checks and end up pyramiding / thrashing
    // the shared exchange position.
    const myPairKey = getStrategyPairKey(mergedStrategy);
    if (myPairKey) {
      releasePairLock = await acquireApiKeyPairEntryLock(apiKeyName, myPairKey);
    }

    // Cross-TS pair conflict check: if ANY active strategy on the same api_key
    // and same pair (in any TS, including this one) is already in long/short,
    // skip entry. This is the primary defense against the multi-TS-per-api-key
    // churn pattern where each strategy in turn nukes the shared position via
    // closeAllForSymbol on its exit.
    if (myPairKey) {
      const apiKeyIdRow: any = await db.get(`SELECT id FROM api_keys WHERE name = ?`, [apiKeyName]);
      const apiKeyId = apiKeyIdRow?.id;
      if (apiKeyId) {
        const crossOpenRows: Array<{ id: number; name: string; base_symbol: string; quote_symbol: string; market_mode: string; state: string }> = await db.all(
          `SELECT s.id, COALESCE(s.name, '') AS name, s.base_symbol, s.quote_symbol, s.market_mode, s.state
           FROM strategies s
           WHERE s.api_key_id = ? AND s.is_active = 1 AND s.state != 'flat' AND s.id != ?`,
          [apiKeyId, strategyId]
        );
        const crossConflicting = crossOpenRows.find((row) => getStrategyPairKey(row as any) === myPairKey);
        if (crossConflicting) {
          logger.info(
            `ОП cross-TS pair lock: strategy ${strategyId} waits for pair ${myPairKey} on api_key=${apiKeyName}; `
            + `held by strategy ${crossConflicting.id} (${crossConflicting.name}, state=${crossConflicting.state})`
          );

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: closedAction
              ? `${closedAction}_op_xpair_lock@${currentRatio}`
              : `op_xpair_lock@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `Cross-TS pair lock active for ${myPairKey} on api_key=${apiKeyName}, entry deferred`,
            action: closedAction ? `${closedAction}_op_xpair_lock` : 'op_xpair_lock',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }

    const systemRow: any = await db.get(
      `SELECT ts.id AS system_id, ts.max_open_positions
       FROM trading_systems ts
       JOIN trading_system_members tsm ON tsm.system_id = ts.id
       WHERE tsm.strategy_id = ? AND tsm.is_enabled = 1
       AND ts.max_open_positions > 0
       LIMIT 1`,
      [strategyId]
    );

    if (systemRow && systemRow.max_open_positions > 0) {
      // Acquire per-system entry lock so OP-count check + placeOrder + state
      // UPDATE for THIS strategy run serially against any other strategy in the
      // same TS. Without this, parallel auto-cycle execution can briefly exceed
      // max_open_positions (overflow guard fixes it next cycle, but we lose
      // capital to fees on the closure).
      releaseSystemLock = await acquireSystemEntryLock(Number(systemRow.system_id));

      const maxOpen = systemRow.max_open_positions;
      // Portfolio books on one API key: exchange OP ceiling = SUM of active TS OPs
      // (not Math.max). Per-book DB gate below still uses this book's maxOpen.
      const portfolioOpRow: any = await db.get(
        `SELECT COALESCE(SUM(ts.max_open_positions), 0) AS portfolio_max_open
         FROM trading_systems ts
         JOIN api_keys ak ON ak.id = ts.api_key_id
         WHERE ak.name = ? AND ts.is_active = 1 AND ts.max_open_positions > 0`,
        [apiKeyName],
      );
      const portfolioMaxOpen = Math.max(
        maxOpen,
        Number(portfolioOpRow?.portfolio_max_open || 0),
      );
      const openCount: any = await db.get(
        `SELECT COUNT(*) AS cnt FROM strategies s
         JOIN trading_system_members tsm ON tsm.strategy_id = s.id
         WHERE tsm.system_id = ? AND tsm.is_enabled = 1
         AND s.is_active = 1 AND s.state != 'flat'
         AND COALESCE(s.strategy_type, '') NOT IN ('dca', 'dca_futures')`,
        [systemRow.system_id]
      );

      const currentOpen = openCount?.cnt || 0;
      let exchangeOpen = 0;
      try {
        const { ensureExchangeClientInitialized: ensureExchange } = await import('./exchange');
        await ensureExchange(apiKeyName);
        const exchangePositions = await getPositions(apiKeyName).catch(() => []);
        exchangeOpen = countExchangeOpenPositions(exchangePositions);
      } catch (exchangeCountErr) {
        logger.warn(`ОП exchange count failed for ${apiKeyName}: ${formatActionError(exchangeCountErr)}`);
      }

      if (exchangeOpen > portfolioMaxOpen) {
        logger.info(
          `ОП exchange limit: ${exchangeOpen}/${portfolioMaxOpen} live positions on ${apiKeyName} `
          + `(book OP=${maxOpen}), skipping entry for strategy ${strategyId} (db=${currentOpen})`,
        );
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_exchange_op_skip@${currentRatio}`
            : `exchange_op_skip@${currentRatio}`,
          last_error: null,
        });
        return returnWithProcessedBar({
          result: `ОП exchange limit reached (${exchangeOpen}/${portfolioMaxOpen}), entry skipped`,
          action: closedAction ? `${closedAction}_exchange_op_skip` : 'exchange_op_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }

      if (currentOpen >= maxOpen) {
        logger.info(`ОП limit: ${currentOpen}/${maxOpen} positions open in system ${systemRow.system_id}, skipping entry for strategy ${strategyId}`);

        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_op_limit_skip@${currentRatio}`
            : `op_limit_skip@${currentRatio}`,
          last_error: null,
        });

        return returnWithProcessedBar({
          result: `ОП limit reached (${currentOpen}/${maxOpen}), entry skipped`,
          action: closedAction ? `${closedAction}_op_limit_skip` : 'op_limit_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }

      // Pair-level lifecycle guard (intra-TS, kept for completeness; cross-TS
      // case is already handled above):
      // strategies with identical pair key take turns (one open position per pair at a time),
      // while different pairs compete only via max_open_positions.
      if (myPairKey && currentOpen > 0) {
        const openRows: Array<{ market_mode: string; base_symbol: string; quote_symbol: string; id: number; name: string }> = await db.all(
          `SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.market_mode
           FROM strategies s
           JOIN trading_system_members tsm ON tsm.strategy_id = s.id
           WHERE tsm.system_id = ? AND tsm.is_enabled = 1
             AND s.is_active = 1 AND s.state != 'flat' AND s.id != ?`,
          [systemRow.system_id, strategyId]
        );

        const conflicting = openRows.find((row) => getStrategyPairKey(row as any) === myPairKey);
        if (conflicting) {
          logger.info(`ОП pair lock: strategy ${strategyId} waits for pair ${myPairKey}; open by strategy ${conflicting.id} (${conflicting.name}) in system ${systemRow.system_id}`);

          const updated = await updateStrategy(apiKeyName, strategyId, {
            ...executionBindingPatch,
            state: 'flat',
            entry_ratio: null,
            tp_anchor_ratio: null,
            last_signal: signal,
            last_action: closedAction
              ? `${closedAction}_op_pair_lock@${currentRatio}`
              : `op_pair_lock@${currentRatio}`,
            last_error: null,
          });

          return returnWithProcessedBar({
            result: `ОП pair lock active for ${myPairKey}, entry deferred`,
            action: closedAction ? `${closedAction}_op_pair_lock` : 'op_pair_lock',
            strategy: updated,
            currentRatio,
            donchianHigh,
            donchianLow,
            donchianCenter,
          });
        }
      }
    }
  }

  // Permanent min-lot / qty-step oversize: skip quietly during cool-down (no balances / place spam).
  {
    const cooldown = isEntryOversizeCoolingDown(apiKeyName, strategyId);
    if (cooldown.active) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        ...(closedAction
          ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
          : {}),
        last_signal: signal,
        last_action: closedAction
          ? `${closedAction}_${ENTRY_OVERSIZE_SKIP_ACTION}@${currentRatio}`
          : `${ENTRY_OVERSIZE_SKIP_ACTION}@${currentRatio}`,
        last_error: cooldown.reason,
      });
      return returnWithProcessedBar({
        result: closedResult || `Entry skipped (min-lot oversize cool-down): ${cooldown.reason}`,
        action: closedAction
          ? `${closedAction}_${ENTRY_OVERSIZE_SKIP_ACTION}`
          : ENTRY_OVERSIZE_SKIP_ACTION,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  }

  const balances = await getBalances(apiKeyName);
  const balanceParts = extractUsdtBalanceParts(balances);
  const availableBalance = balanceParts.freeMargin;
  const walletEquity = balanceParts.walletEquity;

  if (availableBalance <= 0 && walletEquity <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_no_balance@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because balance is unavailable',
        action: `${closedAction}_open_skipped_no_balance`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('No available balance for strategy execution');
  }

  let riskMultiplier = 1.0;
  try {
    const { db } = await import('../utils/database');
    const profile = await db.get(
      `SELECT ap.risk_multiplier FROM algofund_profiles ap
       JOIN api_keys ak ON ak.name = COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name)
       WHERE ak.name = ? LIMIT 1`,
      [apiKeyName]
    );
    if (profile?.risk_multiplier) {
      const val = Number(profile.risk_multiplier);
      if (Number.isFinite(val) && val > 0) riskMultiplier = val;
    }
  } catch { /* non-critical: fallback to 1.0 */ }

  let portfolioCbMult = 1.0;
  try {
    const { resolvePortfolioCircuitBreakerLotMultiplier } = await import('./portfolioCircuitBreakerRuntime');
    portfolioCbMult = await resolvePortfolioCircuitBreakerLotMultiplier(
      apiKeyName,
      Math.max(availableBalance, walletEquity),
      String((mergedStrategy as any)?.strategy_type || strategy?.strategy_type || ''),
    );
  } catch { /* non-critical */ }

  let fearBoostMult = 1.0;
  try {
    const { resolveFearBoostLotMultiplier } = await import('./fearBoostRuntime');
    fearBoostMult = await resolveFearBoostLotMultiplier(
      apiKeyName,
      String((mergedStrategy as any)?.strategy_type || strategy?.strategy_type || ''),
    );
  } catch { /* non-critical */ }

  const channelLotMult = Number((mergedStrategy as any).auto_lot_by_channel_width || 0) === 1
    ? computeChannelWidthLotMultiplier(donchianHigh, donchianLow, donchianCenter, mergedStrategy as any)
    : 1;
  const totalNotional = computeSignalTotalNotional(
    mergedStrategy,
    availableBalance,
    signal,
    riskMultiplier * portfolioCbMult * fearBoostMult,
    { walletEquity },
  ) * channelLotMult;

  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    if (closedAction) {
      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: `${closedAction}_open_skipped_invalid_notional@${currentRatio}`,
        last_error: null,
      });

      return returnWithProcessedBar({
        result: closedResult || 'Position closed; reopen skipped because notional is invalid',
        action: `${closedAction}_open_skipped_invalid_notional`,
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    throw new Error('Calculated trade notional is invalid');
  }

  if (isStatArb && !isCtFractal && (signal === 'long' || signal === 'short')) {
    const entryGate = await getStatArbEntryGateForApiKey(apiKeyName);
    if (entryGate) {
      const gateOk = await passesStatArbEntryGateLive(
        apiKeyName,
        String(mergedStrategy.base_symbol || ''),
        signal,
        entryGate,
      );
      if (!gateOk) {
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          ...(closedAction
            ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
            : {}),
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_stat_arb_entry_gate_skip@${currentRatio}`
            : `stat_arb_entry_gate_skip@${currentRatio}`,
          last_error: null,
        });
        logger.info(
          `Stat-arb entry gate blocked ${signal} for strategy ${strategyId} (${apiKeyName}) `
          + `[${entryGate.label || 'fractal_gate'}]`,
        );
        return returnWithProcessedBar({
          result: closedResult || `Stat-arb entry gate: ${signal} blocked (fractal/RSI confirmation missing)`,
          action: closedAction ? `${closedAction}_stat_arb_entry_gate_skip` : 'stat_arb_entry_gate_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  }

  if (signal === 'long' || signal === 'short') {
    const obGate = await getOrderBlockEntryGateForApiKey(apiKeyName);
    if (obGate) {
      const obOk = await passesOrderBlockEntryGateLive(
        apiKeyName,
        signal,
        String(mergedStrategy.base_symbol || ''),
        obGate,
      );
      if (!obOk) {
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          ...(closedAction
            ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
            : {}),
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_order_block_gate_skip@${currentRatio}`
            : `order_block_gate_skip@${currentRatio}`,
          last_error: null,
        });
        logger.info(
          `Order-block gate blocked ${signal} for strategy ${strategyId} (${apiKeyName}) `
          + `[${obGate.label || 'btc_liq_ob'}]`,
        );
        return returnWithProcessedBar({
          result: closedResult || `Order-block gate: ${signal} blocked at BTC liquidity zone`,
          action: closedAction ? `${closedAction}_order_block_gate_skip` : 'order_block_gate_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  }

  const basePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.base_symbol);
  let quotePrice: number | null = null;
  let qtyPlan: BalancedQtyPlan | null = null;
  let singleQtyPlan: SingleQtyPlan | null = null;
  let baseQty = '';
  let quoteQty: string | null = null;

  if (isMono) {
    singleQtyPlan = await buildSingleQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      basePrice,
      totalNotional
    );
    baseQty = singleQtyPlan.qty;
    const monoRules = await loadQtyRules(apiKeyName, mergedStrategy.base_symbol);
    const cappedMono = clampQtyString(baseQty, monoRules);
    if (cappedMono !== baseQty) {
      logger.warn(
        `[qty-cap] mono ${mergedStrategy.base_symbol} capped ${baseQty} → ${cappedMono} `
        + `(max=${effectiveMaxQty(monoRules)})`
      );
      baseQty = cappedMono;
    }
  } else {
    quotePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.quote_symbol);

    const baseWeight = Math.abs(mergedStrategy.base_coef);
    const quoteWeight = Math.abs(mergedStrategy.quote_coef);

    qtyPlan = await buildBalancedQtyPlan(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
      basePrice,
      quotePrice,
      totalNotional,
      baseWeight,
      quoteWeight
    );

    baseQty = qtyPlan.baseQty;
    quoteQty = qtyPlan.quoteQty;

    const [baseRulesCap, quoteRulesCap] = await Promise.all([
      loadQtyRules(apiKeyName, mergedStrategy.base_symbol),
      loadQtyRules(apiKeyName, mergedStrategy.quote_symbol!),
    ]);
    const cappedPair = capBalancedLegQty(baseQty, quoteQty, baseRulesCap, quoteRulesCap);
    if (cappedPair.scaled || cappedPair.baseQty !== baseQty || cappedPair.quoteQty !== quoteQty) {
      logger.warn(
        `[qty-cap] synth ${mergedStrategy.base_symbol}/${mergedStrategy.quote_symbol} `
        + `base ${baseQty}→${cappedPair.baseQty} quote ${quoteQty}→${cappedPair.quoteQty} `
        + `(scaled=${cappedPair.scaled})`
      );
      baseQty = cappedPair.baseQty;
      quoteQty = cappedPair.quoteQty;
    }
  }

  // ── Hard position-size ceiling (>50% above target = BLOCKED, not just warned) ──
  // buildSingleQtyPlan/buildBalancedQtyPlan pick the closest achievable exchange lot
  // to the target notional, but on symbols with a coarse qty step / large minOrderQty,
  // "closest" can still land far above target. Previously this only emitted a
  // low_lot_warning telemetry event (informational, after the order was already
  // placed) — the trade always went through. This gate refuses the entry outright
  // when the computed lot would exceed MAX_ENTRY_OVERSIZE_FRACTION (1.5x target).
  const entryOversizeFraction = isMono ? (singleQtyPlan?.oversize ?? 0) : (qtyPlan?.oversize ?? 0);
  if (entryOversizeFraction > MAX_ENTRY_OVERSIZE_FRACTION) {
    const oversizeDetail = isMono
      ? `mono target=${singleQtyPlan?.targetNotional.toFixed(2)} actual=${singleQtyPlan?.notional.toFixed(2)}`
      : `synth target=${totalNotional.toFixed(2)} actual=${qtyPlan?.totalNotional.toFixed(2)}`;
    const targetNotionalForCooldown = isMono
      ? Number(singleQtyPlan?.targetNotional || totalNotional)
      : Number(totalNotional);
    const actualNotionalForCooldown = isMono
      ? Number(singleQtyPlan?.notional || 0)
      : Number(qtyPlan?.totalNotional || 0);
    const blocked = markEntryOversizeBlocked(apiKeyName, strategyId, {
      oversize: entryOversizeFraction,
      targetNotional: targetNotionalForCooldown,
      actualNotional: actualNotionalForCooldown,
      detail: (
        `Entry blocked: computed lot ${(entryOversizeFraction * 100).toFixed(1)}% above target `
        + `(cap=${(MAX_ENTRY_OVERSIZE_FRACTION * 100).toFixed(0)}%) — ${oversizeDetail}`
      ),
    });
    if (shouldLogEntryOversizeBlock(apiKeyName, strategyId)) {
      logger.warn(
        `[position-cap] Entry BLOCKED for strategy ${strategyId} (${apiKeyName}): ${blocked.reason} `
        + `— cool-down ${Math.round(ENTRY_OVERSIZE_COOLDOWN_MS / 60_000)}min (${ENTRY_OVERSIZE_SKIP_ACTION})`
      );
      try {
        const { db } = await import('../utils/database');
        await db.run(
          `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
           VALUES (?, ?, ?, 'entry_oversize_blocked', ?, ?, 0, ?)`,
          [
            apiKeyName,
            strategyId,
            mergedStrategy.name || mergedStrategy.base_symbol,
            blocked.reason,
            JSON.stringify({
              oversizePercent: (entryOversizeFraction * 100).toFixed(2),
              totalNotional,
              detail: oversizeDetail,
              path: 'market_entry',
              action: ENTRY_OVERSIZE_SKIP_ACTION,
            }),
            Date.now(),
          ]
        );
      } catch (eventErr) {
        logger.warn(`Failed to record entry_oversize_blocked event: ${(eventErr as Error).message}`);
      }
    }

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? { state: 'flat' as const, entry_ratio: null, tp_anchor_ratio: null }
        : {}),
      last_signal: signal,
      last_action: closedAction
        ? `${closedAction}_${ENTRY_OVERSIZE_SKIP_ACTION}@${currentRatio}`
        : `${ENTRY_OVERSIZE_SKIP_ACTION}@${currentRatio}`,
      last_error: blocked.reason,
    });

    return returnWithProcessedBar({
      result: closedResult || `Entry blocked: computed lot would exceed ${(MAX_ENTRY_OVERSIZE_FRACTION * 100).toFixed(0)}% oversize cap`,
      action: closedAction
        ? `${closedAction}_${ENTRY_OVERSIZE_SKIP_ACTION}`
        : ENTRY_OVERSIZE_SKIP_ACTION,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  const latestBeforeOpen = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  if (!latestBeforeOpen.is_active) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      ...(closedAction
        ? {
            state: 'flat' as const,
            entry_ratio: null,
            tp_anchor_ratio: null,
          }
        : {}),
      last_signal: signal,
      last_action: closedAction
        ? `paused_after_${closedAction}@${currentRatio}`
        : `paused_before_open@${currentRatio}`,
      last_error: null,
    });

    return returnWithProcessedBar({
      result: closedResult || 'Strategy paused before opening a new position',
      action: closedAction ? `paused_after_${closedAction}` : 'paused_before_open',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    });
  }

  try {
    for (const symbol of getStrategySymbols(mergedStrategy)) {
      await applySymbolRiskSettings(apiKeyName, symbol, mergedStrategy.margin_type, mergedStrategy.leverage);
    }
  } catch (error) {
    logger.warn(`Could not apply risk settings for strategy ${strategyId}: ${formatActionError(error)}`);
  }

  // ── Pre-entry exchange idempotency ──────────────────────────────────────
  // When several strategies share an api_key + base_symbol (very common in our
  // SAAS topology with one cloud key serving 11+ trading systems), the exchange
  // position is a SHARED resource. Naively placing a new order here would either
  // pyramid the position (if same side) or flip it (if opposite side, after the
  // legacy closeStrategyExposure call below), thrashing every other strategy
  // that thinks it owns the position. The cross-TS pair lock already prevents
  // concurrent entries; this defensive check handles late-arriving signals and
  // crash-recovery cases where DB state lags behind the exchange.
  const baseSide: 'Buy' | 'Sell' = signal === 'long' ? 'Buy' : 'Sell';
  const quoteSide: 'Buy' | 'Sell' | null = isMono ? null : (signal === 'long' ? 'Sell' : 'Buy');

  try {
    const liveBeforeEntry = await getPositions(apiKeyName, mergedStrategy.base_symbol);
    const livePos = (liveBeforeEntry || []).find((p: any) =>
      String(p?.symbol || '').toUpperCase() === String(mergedStrategy.base_symbol).toUpperCase()
      && Number.parseFloat(String(p?.size || '0')) > 0
    );
    if (livePos) {
      const liveSideRaw = String(livePos?.side || '').toLowerCase();
      const liveSide: 'Buy' | 'Sell' | null = liveSideRaw === 'buy' ? 'Buy' : (liveSideRaw === 'sell' ? 'Sell' : null);
      if (liveSide === baseSide) {
        // Already long/short on the exchange in the desired direction — adopt
        // it as our position without placing a new order.
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: signal,
          entry_ratio: currentRatio,
          tp_anchor_ratio: currentRatio,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_entry_idem_adopt@${currentRatio}`
            : `entry_idem_adopt@${currentRatio}`,
          last_error: null,
        });
        const livePosFillRaw = (livePos as any)?.avgPrice ?? (livePos as any)?.entryPrice ?? (livePos as any)?.openPrice;
        const livePosFill = Number(livePosFillRaw);
        const adoptActualPrice = Number.isFinite(livePosFill) && livePosFill > 0 ? livePosFill : undefined;
        await recordRuntimeTradeEvent('entry', signal, currentRatio, 0, undefined, mergedStrategy.base_symbol, undefined, adoptActualPrice);
        // Trigger DCA-Futures overlay on adopted entry
        if ((signal === 'long' || signal === 'short') && mergedStrategy.base_symbol) {
          try {
            const { triggerDcaFutures } = await import('./dca-futures');
            await triggerDcaFutures(apiKeyName, mergedStrategy.base_symbol, signal as 'long' | 'short');
          } catch (dcaErr) {
            logger.warn(`[dca-futures] trigger failed after adopt-entry for ${apiKeyName} ${mergedStrategy.base_symbol}: ${(dcaErr as Error).message}`);
          }
        }
        logger.info(
          `Pre-entry idempotency: strategy ${strategyId} (${apiKeyName}) adopted existing ${baseSide} `
          + `position on ${mergedStrategy.base_symbol} (size=${livePos.size}); no new order placed`
        );
        return returnWithProcessedBar({
          result: 'Adopted existing exchange position (cohabitation idempotency)',
          action: 'entry_idem_adopt',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      } else if (liveSide && liveSide !== baseSide) {
        // Opposite-side position is on the exchange — most likely owned by a
        // sibling strategy on the same api_key. Do NOT close it (that would
        // nuke the sibling). Skip this entry and wait for the sibling to exit.
        logger.warn(
          `Pre-entry idempotency: strategy ${strategyId} (${apiKeyName}) sees opposite-side `
          + `${liveSide} position on ${mergedStrategy.base_symbol} (size=${livePos.size}); deferring entry`
        );
        const updated = await updateStrategy(apiKeyName, strategyId, {
          ...executionBindingPatch,
          state: 'flat',
          entry_ratio: null,
          tp_anchor_ratio: null,
          last_signal: signal,
          last_action: closedAction
            ? `${closedAction}_entry_idem_opposite_skip@${currentRatio}`
            : `entry_idem_opposite_skip@${currentRatio}`,
          last_error: null,
        });
        return returnWithProcessedBar({
          result: 'Opposite-side live position present; entry deferred to avoid sibling clobber',
          action: 'entry_idem_opposite_skip',
          strategy: updated,
          currentRatio,
          donchianHigh,
          donchianLow,
          donchianCenter,
        });
      }
    }
  } catch (idemErr) {
    logger.warn(`Pre-entry idempotency check failed for strategy ${strategyId}: ${formatActionError(idemErr)} — proceeding with order`);
  }

  // NOTE: legacy closeStrategyExposure() removed from here. With cross-TS pair
  // lock + pre-entry idempotency, calling closeAllForSymbol on a SHARED symbol
  // would nuke positions held by sibling strategies on the same api_key. Any
  // legitimate "must close before reverse-entry" scenario is already handled
  // upstream by closeAndRecordExit (which sets state=flat and triggers cooldown
  // skip on same-side, or proceeds with reverse only after exchange close).

  // MRS2 mono: cancel resting entry limits before market fill (closed-bar touch detected).
  if (
    isMrs2
    && String(mergedStrategy.market_mode || '').toLowerCase() === 'mono'
  ) {
    try {
      await cancelMrs2RestingLimits(
        apiKeyName,
        String(mergedStrategy.base_symbol || ''),
        mergedStrategy.mrs2_pending_json,
      );
    } catch (e) {
      logger.warn(`MRS2 pre-entry cancel resting: ${(e as Error).message}`);
    }
  }

  const baseOrder = await placeOrder(
    apiKeyName,
    mergedStrategy.base_symbol,
    baseSide,
    baseQty,
    undefined,
    mergedStrategy.market_type === 'spot' ? { marketType: 'spot' } : undefined,
  );

  let quoteOrder: unknown = null;
  if (!isMono && quoteSide && quoteQty) {
    try {
      quoteOrder = await placeOrder(
        apiKeyName,
        mergedStrategy.quote_symbol!,
        quoteSide,
        quoteQty,
        undefined,
        mergedStrategy.market_type === 'spot' ? { marketType: 'spot' } : undefined,
      );
    } catch (error) {
      try {
        await closePosition(apiKeyName, mergedStrategy.base_symbol, baseQty, baseSide);
      } catch (rollbackError) {
        logger.error(`Rollback failed for ${mergedStrategy.base_symbol}: ${formatActionError(rollbackError)}`);
      }
      throw error;
    }

    const livePairAfterOpen = await loadPairPositionsForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
      mergedStrategy.quote_symbol,
    );

    if (!livePairAfterOpen.basePosition || !livePairAfterOpen.quotePosition || !qtyPlan) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened pair validation failed: one or both legs are missing after entry',
      });

      logger.warn(
        `Post-open validation failed (missing leg): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}, quote=${mergedStrategy.quote_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with missing leg and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }

    const liveBalanceCheck = validateLiveLegBalance(
      livePairAfterOpen.basePosition,
      livePairAfterOpen.quotePosition,
      Math.abs(mergedStrategy.base_coef),
      Math.abs(mergedStrategy.quote_coef),
      MAX_POST_OPEN_SHARE_ERROR
    );

    if (!liveBalanceCheck.ok) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const liveSnapshot = liveBalanceCheck.snapshot;
      const mismatchReason =
        `Opened pair weight mismatch: base=${liveSnapshot.baseNotional.toFixed(4)} `
        + `quote=${liveSnapshot.quoteNotional.toFixed(4)} `
        + `expectedShare=${(liveSnapshot.expectedBaseShare * 100).toFixed(2)}% `
        + `actualShare=${(liveSnapshot.actualBaseShare * 100).toFixed(2)}% `
        + `shareError=${(liveSnapshot.shareError * 100).toFixed(2)}%`;

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_weight_mismatch',
        last_error: mismatchReason,
      });

      logger.warn(
        `Post-open validation failed (weight mismatch): strategy=${strategyId}, apiKey=${apiKeyName}, ${mismatchReason}`
      );

      return returnWithProcessedBar({
        result: 'Pair opened with weight mismatch and was closed',
        action: 'desync_closed_post_open_weight_mismatch',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  } else {
    const livePositionAfterOpen = await loadSinglePositionForValidation(
      apiKeyName,
      mergedStrategy.base_symbol,
    );

    if (!livePositionAfterOpen) {
      await closeStrategyExposure(apiKeyName, mergedStrategy);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        tp_anchor_ratio: null,
        last_signal: signal,
        last_action: 'desync_closed_post_open_missing_leg',
        last_error: 'Opened mono validation failed: live position is missing after entry',
      });

      logger.warn(
        `Post-open validation failed (mono missing position): strategy=${strategyId}, apiKey=${apiKeyName}, `
        + `base=${mergedStrategy.base_symbol}`
      );

      return returnWithProcessedBar({
        result: 'Position opened but was not confirmed and was closed',
        action: 'desync_closed_post_open_missing_leg',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      });
    }
  }

  const updated = await updateStrategy(apiKeyName, strategyId, {
    ...executionBindingPatch,
    state: signal,
    entry_ratio: currentRatio,
    tp_anchor_ratio: currentRatio,
    last_signal: signal,
    last_action: closedAction
      ? `reopened_${signal}_after_${closedAction}@${currentRatio}`
      : `opened_${signal}@${currentRatio}`,
    last_error: null,
    ...(isMrs2 ? { mrs2_pending_json: '{}' } : {}),
  });
  if (isMrs2) {
    mergedStrategy.mrs2_pending_json = '{}';
  }

  await recordSynthRuntimeEvents(
    'entry',
    signal,
    currentRatio,
    Number(baseQty) || 0,
    Number(quoteQty) || 0,
    baseOrder,
    quoteOrder ?? undefined,
  );

  // Trigger DCA-Futures overlay on same symbol if any idle dca_futures strategy exists
  if ((signal === 'long' || signal === 'short') && mergedStrategy.base_symbol) {
    try {
      const { triggerDcaFutures } = await import('./dca-futures');
      await triggerDcaFutures(apiKeyName, mergedStrategy.base_symbol, signal as 'long' | 'short');
    } catch (dcaErr) {
      logger.warn(`[dca-futures] trigger failed after entry for ${apiKeyName} ${mergedStrategy.base_symbol}: ${(dcaErr as Error).message}`);
    }
  }

  if (singleQtyPlan) {
    logger.info(
      `Strategy ${strategyId} mono sizing: target=${singleQtyPlan.targetNotional.toFixed(2)} USDT, `
      + `actual=${singleQtyPlan.notional.toFixed(2)}, totalDeviation=${(singleQtyPlan.totalDeviation * 100).toFixed(2)}%`
    );

    // Emit low-lot warning event if mono sizing degraded to minQty
    if (singleQtyPlan.hasWarning) {
      const alertMessage = `Low-lot warning (mono): ${singleQtyPlan.warningReason || 'lot below min threshold'}`;
      logger.warn(
        `Strategy ${strategyId} (${apiKeyName}) mono executed with low-lot degradation: ${singleQtyPlan.warningReason}`
      );
      try {
        const { db } = await import('../utils/database');
        const strategyNameStr = mergedStrategy.name || mergedStrategy.base_symbol;
        await db.run(
          `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
           VALUES (?, ?, ?, 'low_lot_warning', ?, ?, 0, ?)`,
          [
            apiKeyName,
            strategyId,
            strategyNameStr,
            alertMessage,
            JSON.stringify({
              totalDeviation: (singleQtyPlan.totalDeviation * 100).toFixed(2),
              oversize: (singleQtyPlan.oversize * 100).toFixed(2),
              targetNotional: singleQtyPlan.targetNotional.toFixed(2),
              actualNotional: singleQtyPlan.notional.toFixed(2),
              timestamp: new Date().toISOString(),
            }),
            Date.now(),
          ]
        );
      } catch (eventErr) {
        logger.warn(`Failed to record mono low-lot warning event: ${(eventErr as Error).message}`);
      }
    }
  }

  if (qtyPlan) {
    logger.info(
      `Strategy ${strategyId} leg balancing: target=${totalNotional.toFixed(2)} USDT, `
      + `base ${qtyPlan.baseTargetNotional.toFixed(2)} -> ${qtyPlan.baseNotional.toFixed(2)}, `
      + `quote ${qtyPlan.quoteTargetNotional.toFixed(2)} -> ${qtyPlan.quoteNotional.toFixed(2)}, `
      + `shareError=${(qtyPlan.shareError * 100).toFixed(2)}%, totalDeviation=${(qtyPlan.totalDeviation * 100).toFixed(2)}%`
    );

    // Emit low-lot warning event if qty plan degraded gracefully
    if (qtyPlan.hasWarning) {
      const alertMessage = `Low-lot warning during execution: ${qtyPlan.warningReason || 'unknown'}.`;
      logger.warn(
        `Strategy ${strategyId} (${apiKeyName}) executed with low-lot degradation: ${qtyPlan.warningReason}`
      );
      try {
        const { db } = await import('../utils/database');
        const strategyNameStr = mergedStrategy.name || `${mergedStrategy.base_symbol}/${mergedStrategy.quote_symbol}`;
        await db.run(
          `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
           VALUES (?, ?, ?, 'low_lot_warning', ?, ?, 0, ?)`,
          [
            apiKeyName,
            strategyId,
            strategyNameStr,
            alertMessage,
            JSON.stringify({
              shareError: (qtyPlan.shareError * 100).toFixed(2),
              baseLegDeviation: qtyPlan.baseLegDeviation ? (qtyPlan.baseLegDeviation * 100).toFixed(2) : null,
              quoteLegDeviation: qtyPlan.quoteLegDeviation ? (qtyPlan.quoteLegDeviation * 100).toFixed(2) : null,
              totalDeviation: (qtyPlan.totalDeviation * 100).toFixed(2),
              oversize: (qtyPlan.oversize * 100).toFixed(2),
              notional: qtyPlan.totalNotional.toFixed(2),
              timestamp: new Date().toISOString(),
            }),
            Date.now(),
          ]
        );
      } catch (eventErr) {
        logger.warn(`Failed to record low-lot warning event: ${(eventErr as Error).message}`);
      }
    }
  }

  if (isMomentumScalp && (signal === 'long' || signal === 'short')) {
    try {
      const { handleMomentumBingxCanaryAfterEntry } = await import('./momentumBingxCanary');
      void handleMomentumBingxCanaryAfterEntry({
        apiKeyName,
        strategyId,
        baseSymbol: mergedStrategy.base_symbol,
        signal,
        currentRatio,
      });
    } catch (canaryErr) {
      logger.warn(`[momentum-canary] post-entry hook failed: ${(canaryErr as Error).message}`);
    }
  }

  logger.info(`Executed ${mergedStrategy.strategy_type} strategy ${strategyId} for ${apiKeyName}: ${signal} (${marketMode})`);
  return returnWithProcessedBar({
    result: 'Strategy executed',
    action: closedAction ? `reopened_${signal}_after_${closedAction}` : `opened_${signal}`,
    signal,
    baseOrder,
    baseQty,
    quoteQty,
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    strategy: updated,
  });
  } finally {
    if (releaseSystemLock) {
      try { releaseSystemLock(); } catch { /* noop */ }
      releaseSystemLock = null;
    }
    if (releasePairLock) {
      try { releasePairLock(); } catch { /* noop */ }
      releasePairLock = null;
    }
  }
};

export const pauseStrategy = async (apiKeyName: string, strategyId: number) => {
  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    last_action: 'paused',
  });
  logger.info(`Paused strategy ${strategyId}`);
  return updated;
};

export const stopStrategy = async (apiKeyName: string, strategyId: number) => {
  const row = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  await closeStrategyExposure(apiKeyName, row);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'stopped',
    last_error: null,
  });

  logger.info(`Stopped strategy ${strategyId}`);
  return updated;
};

export const closePositionPercent = async (
  apiKeyName: string,
  strategyId: number,
  symbol: string,
  percent: number,
  side?: 'Buy' | 'Sell'
) => {
  const positions = await getPositions(apiKeyName, symbol);
  const target = positions.find((position: any) => {
    const sameSymbol = String(position?.symbol || '').toUpperCase() === symbol.toUpperCase();
    const hasSize = Number.parseFloat(String(position?.size || '0')) > 0;
    const sideMatches = side ? String(position?.side || '') === side : true;
    return sameSymbol && hasSize && sideMatches;
  });

  if (!target) {
    throw new Error(`Position not found for ${symbol}`);
  }

  const safePercent = Math.max(0.1, Math.min(100, Number.isFinite(percent) ? percent : 100));
  const qtyToClose = (Number.parseFloat(String(target.size || '0')) * safePercent) / 100;
  const qty = qtyToClose.toFixed(8).replace(/\.?0+$/, '');

  await closePosition(apiKeyName, symbol, qty, target.side as 'Buy' | 'Sell');
  logger.info(`Closed ${safePercent}% of position for ${symbol} (strategy ${strategyId})`);
};

export const placeManualOrder = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price?: string
) => {
  return await placeOrder(apiKeyName, symbol, side, qty, price);
};

export const cancelStrategyOrders = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await cancelStrategyWorkingOrders(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    last_action: 'orders_cancelled',
    last_error: null,
  });

  logger.info(`Cancelled orders for strategy ${strategyId}`);
  return updated;
};

export const closeStrategyPositions = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await closeStrategyExposure(apiKeyName, strategy);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    state: 'flat',
    entry_ratio: null,
    tp_anchor_ratio: null,
    last_action: 'positions_closed',
    last_error: null,
  });

  logger.info(`Closed strategy exposure for strategy ${strategyId}`);
  return updated;
};

export const setAllStrategiesActive = async (apiKeyName: string, isActive: boolean) => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);
  const result: any = await db.run(
    `UPDATE strategies
     SET is_active = ?,
         last_action = ?,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE api_key_id = ?`,
    [isActive ? 1 : 0, isActive ? 'resumed_all' : 'paused_all', apiKeyId]
  );

  const updated = Number(result?.changes || 0);

  return {
    updated,
  };
};
