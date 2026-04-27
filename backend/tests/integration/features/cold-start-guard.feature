Feature: Cold-start guard — skip first bar after strategy materialization
  When a strategy is newly materialized (created_at = now) the engine must
  NOT enter a position on the first N bars. This avoids picking up a stale
  signal that has been running for many bars with a poor R/R at entry.

  Background:
    Given the cold-start guard test database is initialized

  # ── intervalToMs math ──────────────────────────────────────────────────────

  Scenario Outline: intervalToMs converts interval string to milliseconds
    When I compute intervalToMs for "<interval>"
    Then the result should be <expectedMs> milliseconds

    Examples:
      | interval | expectedMs |
      | 1m       | 60000      |
      | 5m       | 300000     |
      | 15m      | 900000     |
      | 1h       | 3600000    |
      | 4h       | 14400000   |
      | 1d       | 86400000   |
      | 1w       | 604800000  |

  # ── Cold-start condition guard logic ───────────────────────────────────────

  Scenario: Guard fires when bar time is inside cold-start window
    Given COLD_START_BARS env is "1"
    And a strategy with interval "4h" was created 1 hours ago
    When I check cold-start guard for that strategy at current bar
    Then the guard should fire with action "cold_start_skip"

  Scenario: Guard passes after cold-start window has elapsed
    Given COLD_START_BARS env is "1"
    And a strategy with interval "4h" was created 5 hours ago
    When I check cold-start guard for that strategy at current bar
    Then the guard should NOT fire

  Scenario: Guard is disabled when COLD_START_BARS is zero
    Given COLD_START_BARS env is "0"
    And a strategy with interval "4h" was created 1 hours ago
    When I check cold-start guard for that strategy at current bar
    Then the guard should NOT fire

  Scenario: Guard respects multi-bar cold-start window
    Given COLD_START_BARS env is "3"
    And a strategy with interval "1h" was created 2 hours ago
    When I check cold-start guard for that strategy at current bar
    Then the guard should fire with action "cold_start_skip"

  Scenario: Guard passes after multi-bar window elapses
    Given COLD_START_BARS env is "3"
    And a strategy with interval "1h" was created 4 hours ago
    When I check cold-start guard for that strategy at current bar
    Then the guard should NOT fire

  # ── Persistence: last_action written to DB ──────────────────────────────────

  Scenario: Cold-start skip persists last_action in DB
    Given COLD_START_BARS env is "1"
    And a persisted strategy "CS_SKIP_TEST" with interval "4h" created 1 hours ago exists in DB
    When the cold-start guard evaluates strategy "CS_SKIP_TEST"
    Then strategy "CS_SKIP_TEST" last_action should start with "cold_start_skip@"
