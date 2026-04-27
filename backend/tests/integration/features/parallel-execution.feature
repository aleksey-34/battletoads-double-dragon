Feature: Parallel execution — all strategies execute in a single cycle simultaneously
  The auto-cycle must dispatch all active strategies via Promise.allSettled,
  not sequentially, so that every strategy receives the same market signal
  at approximately the same wall-clock time.

  Background:
    Given the parallel execution test database is initialized

  # ── Completeness: all strategies are attempted ─────────────────────────────

  Scenario: Auto-cycle returns total count matching active strategies in DB
    Given 3 active auto-update strategies exist under key "PARALLEL_TEST_KEY"
    When I run the auto-strategies cycle
    Then the cycle result total should be 3

  Scenario: Cycle processes all strategies even when exchange is unavailable
    Given 3 active auto-update strategies exist under key "PARALLEL_TEST_KEY"
    When I run the auto-strategies cycle
    Then processed plus failed plus skippedOffline should equal 3

  Scenario: One failing strategy does not abort others
    Given 3 active auto-update strategies exist under key "PARALLEL_TEST_KEY"
    When I run the auto-strategies cycle
    Then all 3 strategies should have their last_action updated in DB

  # ── Isolation: failed strategies update DB state independently ─────────────

  Scenario: Cycle persists last_action for each failed strategy
    Given 3 active auto-update strategies exist under key "PARALLEL_TEST_KEY"
    When I run the auto-strategies cycle
    Then each strategy last_action in DB should not be NULL
