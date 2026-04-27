Feature: Extended analytics — bt_rt_daily_snapshots has execution quality columns
  The daily snapshot table must include avg_slippage_pct, avg_execution_delay_ms,
  margin_load_rt_pct, realized_pnl_usd, and trade_hour_distribution columns so
  the research scheduler can record execution quality alongside backtest comparison.

  Background:
    Given the extended analytics test database is initialized

  # ── Schema: new columns exist after ensureBtRtTable ───────────────────────

  Scenario: ensureBtRtTable creates avg_slippage_pct column
    When I call ensureBtRtTable
    Then bt_rt_daily_snapshots table should have column "avg_slippage_pct"

  Scenario: ensureBtRtTable creates avg_execution_delay_ms column
    When I call ensureBtRtTable
    Then bt_rt_daily_snapshots table should have column "avg_execution_delay_ms"

  Scenario: ensureBtRtTable creates margin_load_rt_pct column
    When I call ensureBtRtTable
    Then bt_rt_daily_snapshots table should have column "margin_load_rt_pct"

  Scenario: ensureBtRtTable creates realized_pnl_usd column
    When I call ensureBtRtTable
    Then bt_rt_daily_snapshots table should have column "realized_pnl_usd"

  Scenario: ensureBtRtTable creates trade_hour_distribution column
    When I call ensureBtRtTable
    Then bt_rt_daily_snapshots table should have column "trade_hour_distribution"

  # ── Idempotency: calling ensureBtRtTable twice is safe ─────────────────────

  Scenario: ensureBtRtTable is idempotent (calling twice does not throw)
    When I call ensureBtRtTable
    And I call ensureBtRtTable again
    Then no error should have occurred

  # ── Data: new columns accept and return values ───────────────────────────--

  Scenario: Snapshot insert stores and retrieves avg_slippage_pct value
    When I call ensureBtRtTable
    And I insert a test snapshot with avg_slippage_pct 0.05 and avg_execution_delay_ms 350
    Then the retrieved snapshot avg_slippage_pct should be 0.05
    And the retrieved snapshot avg_execution_delay_ms should be 350

  Scenario: Snapshot insert stores and retrieves realized_pnl_usd value
    When I call ensureBtRtTable
    And I insert a test snapshot with realized_pnl_usd 123.45
    Then the retrieved snapshot realized_pnl_usd should be 123.45

  Scenario: Snapshot insert stores trade_hour_distribution as JSON string
    When I call ensureBtRtTable
    And I insert a test snapshot with trade_hour_distribution '{"0":3,"14":7}'
    Then the retrieved snapshot trade_hour_distribution should be '{"0":3,"14":7}'
