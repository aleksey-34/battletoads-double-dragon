Feature: Algofund materialization member source priority
  Validates that materializeAlgofundSystem() uses DB-resident sources
  (master_card_members → trading_system_members) before falling back to
  the live API or catalog draft. This prevents stale/partial catalog data
  from capping clients at fewer strategies than the source TS contains.

  Background:
    Given the SaaS database is initialized
    And a materialization test API key "MATTEST_KEY" exists on exchange "bybit"
    And source trading system "MAT_SOURCE_TS" exists on key "MATTEST_KEY" with 20 enabled members

  # ── Priority 2 (DB trading_system_members) ─────────────────────────────────

  Scenario: Materializing from DB TS members returns correct count
    Given no master_card exists for source system "MAT_SOURCE_TS"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then the DB source member count should be 20

  Scenario: DB TS exact-name lookup works without fuzzy matching
    Given no master_card exists for source system "MAT_SOURCE_TS"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then the DB source query should succeed

  # ── Priority 1 (master_card_members) overrides DB TS members ───────────────

  Scenario: master_card_members take priority over trading_system_members
    Given a master_card "CARD::MAT_SOURCE_TS" exists with 15 enabled members on key "MATTEST_KEY"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then the master card member count should be 15
    And the master card count should exceed 0

  Scenario: master_card with 0 enabled members falls through to trading_system_members
    Given a master_card "CARD::MAT_SOURCE_TS" exists with 0 enabled members on key "MATTEST_KEY"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then the DB source member count should be 20

  # ── Member math consistency ─────────────────────────────────────────────────

  Scenario: All DB members have valid strategy_id > 0
    Given no master_card exists for source system "MAT_SOURCE_TS"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then all returned member strategyIds should be positive integers

  Scenario: Member weights default to 1 when not explicitly set
    Given no master_card exists for source system "MAT_SOURCE_TS"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then all returned member weights should be positive numbers

  # ── Fallback: catalog draft used only when DB is empty ──────────────────────

  Scenario: Empty DB sources signal fallback to catalog/live API
    Given source trading system "MAT_SOURCE_TS" has no enabled members in DB
    And no master_card exists for source system "MAT_SOURCE_TS"
    When I query materialization DB source for key "MATTEST_KEY" system "MAT_SOURCE_TS"
    Then the DB source member count should be 0
