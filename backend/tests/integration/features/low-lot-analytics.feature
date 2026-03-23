Feature: Low-lot and liquidity analytics
  Admin endpoint must surface low-lot errors and liquidity triggers from
  both strategies.last_error and the new strategy_runtime_events table.

  Background:
    Given dashboard auth password is "defaultpassword"

  # ── Admin endpoint auth ────────────────────────────────────────────────────

  Scenario: Low-lot recommendations endpoint requires auth
    When I send a "GET" request to "/api/saas/admin/low-lot-recommendations" without auth
    Then the response status should be 401

  # ── Empty state ────────────────────────────────────────────────────────────

  Scenario: Returns empty list when no low-lot errors exist
    When I send a "GET" request to "/api/saas/admin/low-lot-recommendations" with auth
    Then the response status should be 200
    And the response JSON should include key "items"
    And the response JSON should include key "generatedAt"
    And the response JSON should include key "periodHours"
    And the items list should be empty

  # ── Apply recommendation endpoint ─────────────────────────────────────────

  Scenario: Apply endpoint requires auth
    When I POST to "/api/saas/admin/apply-low-lot-recommendation" without auth with body {"strategyId":1}
    Then the response status should be 401

  Scenario: Apply recommendation returns error for nonexistent strategy
    When I POST to "/api/saas/admin/apply-low-lot-recommendation" with auth with body {"strategyId":999999,"applyDepositFix":true,"applyLotFix":false}
    Then the response status should be 500
    And the response error should contain "999999"

  # ── Runtime events surface in recommendations ──────────────────────────────

  Scenario: Low-lot error event appears in recommendations immediately
    Given an API key "test_key_ll" exists in the database
    And a strategy "LowLot Strategy" exists for "test_key_ll" with deposit 500 and lot 10
    And a low-lot runtime event exists for "test_key_ll" and the strategy
    When I send a "GET" request to "/api/saas/admin/low-lot-recommendations" with auth
    Then the response status should be 200
    And the items list should contain a recommendation for strategy "LowLot Strategy"

  Scenario: Applying recommendation resolves the runtime event
    Given an API key "test_key_apply" exists in the database
    And a strategy "Apply Strategy" exists for "test_key_apply" with deposit 400 and lot 10
    And a low-lot runtime event exists for "test_key_apply" and the strategy
    When I apply the recommendation for the strategy with deposit fix
    Then the response status should be 200
    And the response JSON should include key "success"
    And the response JSON should include key "changeSummary"
    And the runtime event for the strategy should be resolved

  # ── Liquidity triggers ─────────────────────────────────────────────────────

  Scenario: Liquidity trigger event appears in recommendations
    Given an API key "test_key_liq" exists in the database
    And a liquidity trigger event exists for "test_key_liq" with symbol "NEWUSDT"
    When I send a "GET" request to "/api/saas/admin/low-lot-recommendations" with auth
    Then the response status should be 200
    And the items list should contain a recommendation with pair "NEWUSDT"
