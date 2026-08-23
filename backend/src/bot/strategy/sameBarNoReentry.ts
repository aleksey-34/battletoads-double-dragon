export type SameBarNoReentryInput = {
  state: string;
  signal: string;
  closedAction: string | null;
  lastAction: string | null;
  updatedAtMs: number | null;
  evaluatedBarTimeMs: number;
};

export type SameBarNoReentryDecision =
  | { block: false }
  | { block: true; action: string; lastActionSuffix: string };

const EXIT_MARKERS = [
  'desync_closed',
  'state_resynced',
  'take_profit_',
  'stop_loss_',
  'mean_revert_exit',
  'macro_shield_exit',
  'same_bar_no_reentry',
] as const;

const isEntrySignal = (signal: string): signal is 'long' | 'short' =>
  signal === 'long' || signal === 'short';

/** Pure guard for in-cycle and cross-cycle same-bar re-entry (unit-tested). */
export const evaluateSameBarNoReentry = (input: SameBarNoReentryInput): SameBarNoReentryDecision => {
  const state = String(input.state || 'flat').toLowerCase();
  const signal = String(input.signal || '').toLowerCase();
  const closedAction = input.closedAction ? String(input.closedAction) : null;

  if (closedAction && state === 'flat' && isEntrySignal(signal)) {
    return {
      block: true,
      action: `${closedAction}_same_bar_no_reentry`,
      lastActionSuffix: `${closedAction}_same_bar_no_reentry@`,
    };
  }

  if (state === 'flat' && !closedAction && isEntrySignal(signal)) {
    const lastAction = String(input.lastAction || '');
    const recentExit = EXIT_MARKERS.some((marker) => lastAction.includes(marker));
    const updatedAtMs = input.updatedAtMs;
    if (
      recentExit
      && updatedAtMs != null
      && Number.isFinite(updatedAtMs)
      && updatedAtMs >= input.evaluatedBarTimeMs
    ) {
      return {
        block: true,
        action: 'post_exit_same_bar_no_reentry',
        lastActionSuffix: 'post_exit_same_bar_no_reentry@',
      };
    }
  }

  return { block: false };
};
