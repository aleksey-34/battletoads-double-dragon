Feature: PnL tracking — monitoring_snapshots has deposit_base_usd and pnl_net_usd columns
  The monitoring snapshot table must store the initial deposit baseline and
  the net cumulative realized PnL for each account so the equity chart can
  be replaced with a proper PnL chart.

  Background:
    Given the PnL tracking test database is initialized

  # ── Schema: migration adds columns idempotently ───────────────────────────

  Scenario: monitoring_snapshots table has deposit_base_usd column after migration
    When I run the PnL migration for monitoring_snapshots
    Then monitoring_snapshots table should have column "deposit_base_usd"

  Scenario: monitoring_snapshots table has pnl_net_usd column after migration
    When I run the PnL migration for monitoring_snapshots
    Then monitoring_snapshots table should have column "pnl_net_usd"

  Scenario: PnL migration is idempotent (running twice does not throw)
    When I run the PnL migration for monitoring_snapshots
    And I run the PnL migration for monitoring_snapshots again
    Then no PnL migration error should have occurred

  # ── Math: pnl_net = equity - unrealized - deposit_base ───────────────────

  Scenario: pnl_net_usd equals equity minus unrealized minus deposit_base
    Given equity_usd is 1200, unrealized_pnl is 50, deposit_base_usd is 1000
    When I compute pnl_net_usd
    Then pnl_net_usd should be 150

  Scenario: pnl_net_usd is negative when equity fell below deposit
    Given equity_usd is 900, unrealized_pnl is 0, deposit_base_usd is 1000
    When I compute pnl_net_usd
    Then pnl_net_usd should be -100

  Scenario: pnl_net_usd is zero on first snapshot (deposit equals equity, no unrealized)
    Given equity_usd is 1000, unrealized_pnl is 0, deposit_base_usd is 1000
    When I compute pnl_net_usd
    Then pnl_net_usd should be 0

  # ── Persistence: first snapshot sets deposit_base ──────────────────────────

  Scenario: First snapshot for a new key sets deposit_base_usd to equity
    When I run the PnL migration for monitoring_snapshots
    And I insert first monitoring snapshot for "PNL_TRACK_KEY" with equity 1500.0
    Then the stored deposit_base_usd should equal equity 1500.0

  Scenario: Second snapshot for same key keeps original deposit_base_usd
    When I run the PnL migration for monitoring_snapshots
    And I insert first monitoring snapshot for "PNL_TRACK_KEY2" with equity 1000.0
    And I insert second monitoring snapshot for "PNL_TRACK_KEY2" with equity 1100.0
    Then the second snapshot deposit_base_usd should still be 1000.0

  Scenario: Second snapshot pnl_net_usd reflects growth
    When I run the PnL migration for monitoring_snapshots
    And I insert first monitoring snapshot for "PNL_TRACK_KEY3" with equity 1000.0
    And I insert second monitoring snapshot for "PNL_TRACK_KEY3" with equity 1200.0
    Then the second snapshot pnl_net_usd should be 200.0
