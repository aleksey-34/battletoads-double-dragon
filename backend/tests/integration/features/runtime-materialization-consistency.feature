Feature: Runtime engine materialization and math consistency
  Validates that runtime strategy state/signal materializes consistently in API,
  update operations are atomic, and key math normalizations are preserved.

  Background:
    Given dashboard auth password is "defaultpassword"
    And runtime test API key "RUNTIME_CUCUMBER" exists

  Scenario: Runtime state materializes consistently between summary and detail
    Given runtime fixture "RUN_STATE_SHORT" exists for "RUNTIME_CUCUMBER" with body:
      """
      {
        "name": "RUN_STATE_SHORT",
        "strategy_type": "DD_BattleToads",
        "market_mode": "mono",
        "base_symbol": "AUCTIONUSDT",
        "quote_symbol": "",
        "interval": "4h",
        "state": "short",
        "last_signal": "short",
        "last_action": "hold_short@test",
        "is_runtime": 1,
        "is_archived": 0
      }
      """
    When I GET runtime summary for "RUNTIME_CUCUMBER" with runtimeOnly "1"
    Then runtime summary should include fixture "RUN_STATE_SHORT" with state "short"
    When I GET runtime detail for fixture "RUN_STATE_SHORT" on "RUNTIME_CUCUMBER"
    Then runtime detail for fixture "RUN_STATE_SHORT" should have state "short" and signal "short"

  Scenario: Binding update stays atomic for neighbor strategies
    Given runtime fixture "ATOMIC_PRIMARY" exists for "RUNTIME_CUCUMBER" with body:
      """
      {
        "name": "ATOMIC_PRIMARY",
        "strategy_type": "DD_BattleToads",
        "market_mode": "mono",
        "base_symbol": "IPUSDT",
        "quote_symbol": "",
        "interval": "4h",
        "state": "flat",
        "is_runtime": 1,
        "is_archived": 0
      }
      """
    And runtime fixture "ATOMIC_NEIGHBOR" exists for "RUNTIME_CUCUMBER" with body:
      """
      {
        "name": "ATOMIC_NEIGHBOR",
        "strategy_type": "zz_breakout",
        "market_mode": "synthetic",
        "base_symbol": "BERAUSDT",
        "quote_symbol": "ZECUSDT",
        "interval": "4h",
        "state": "flat",
        "is_runtime": 1,
        "is_archived": 0
      }
      """
    When I PUT runtime fixture "ATOMIC_PRIMARY" on "RUNTIME_CUCUMBER" with body:
      """
      {
        "base_symbol": "WIFUSDT",
        "quote_symbol": "",
        "market_mode": "mono",
        "interval": "1h",
        "base_coef": 1,
        "quote_coef": 0
      }
      """
    Then the response status should be 200
    When I GET runtime detail for fixture "ATOMIC_NEIGHBOR" on "RUNTIME_CUCUMBER"
    Then runtime detail for fixture "ATOMIC_NEIGHBOR" should keep base "BERAUSDT" quote "ZECUSDT" interval "4h"

  Scenario: Strategy id mismatch is rejected by API
    Given runtime fixture "MISMATCH_FIXTURE" exists for "RUNTIME_CUCUMBER" with body:
      """
      {
        "name": "MISMATCH_FIXTURE",
        "strategy_type": "DD_BattleToads",
        "market_mode": "mono",
        "base_symbol": "SUIUSDT",
        "quote_symbol": "",
        "interval": "4h",
        "state": "flat",
        "is_runtime": 1,
        "is_archived": 0
      }
      """
    When I PUT runtime fixture "MISMATCH_FIXTURE" on "RUNTIME_CUCUMBER" with mismatched body id by 999
    Then the response status should be 400
    And the response error should contain "mismatch"

  Scenario: Mono mode normalizes quote coefficient to zero
    When I POST runtime strategy to "RUNTIME_CUCUMBER" with body:
      """
      {
        "name": "MATH_MONO_NORMALIZE",
        "strategy_type": "DD_BattleToads",
        "market_mode": "mono",
        "base_symbol": "XRPUSDT",
        "quote_symbol": "",
        "interval": "1h",
        "base_coef": 1.0,
        "quote_coef": 3.7,
        "state": "flat",
        "is_runtime": 1,
        "is_archived": 0
      }
      """
    Then the response status should be 200
    Then runtime created strategy should have quote_coef equal to 0
