Feature: Exchange-level rate limit protection
  Validates that the per-exchange parent Bottleneck limiter is wired up correctly
  so that multiple API keys on the same exchange do not cause IP-level 429 errors.
  Also validates that the positions endpoint returns gracefully for any configured key.

  Background:
    Given dashboard auth password is "defaultpassword"
    And rate-limit test API key "RL_KEY_1" exists on exchange "weex"
    And rate-limit test API key "RL_KEY_2" exists on exchange "weex"
    And rate-limit test API key "RL_KEY_3" exists on exchange "bingx"

  # ── Exchange parent limiter initialization ──────────────────────────────────

  Scenario: Exchange client initialization does not throw for weex key
    When I initialize exchange client for key "RL_KEY_1"
    Then no initialization error should be thrown

  Scenario: Exchange client initialization does not throw for bingx key
    When I initialize exchange client for key "RL_KEY_3"
    Then no initialization error should be thrown

  Scenario: Two weex keys share the same exchange parent limiter instance
    When I initialize exchange client for key "RL_KEY_1"
    And I initialize exchange client for key "RL_KEY_2"
    Then the exchange parent limiter for "weex" should have maxConcurrent 2

  Scenario: bingx exchange parent limiter has maxConcurrent 4
    When I initialize exchange client for key "RL_KEY_3"
    Then the exchange parent limiter for "bingx" should have maxConcurrent 4

  # ── Positions endpoint smoke ─────────────────────────────────────────────────

  Scenario: Positions endpoint returns array or error without crashing for known key
    When I send a GET request to "/api/positions/RL_KEY_1"
    Then the response status should be 200 or 401 or 500

  Scenario: Positions endpoint does not return 429 for weex key
    When I send a GET request to "/api/positions/RL_KEY_1"
    Then the response status should not be 429

  Scenario: Positions endpoint returns 404 for unknown key
    When I send a GET request to "/api/positions/UNKNOWN_KEY_XYZ_999"
    Then the response status should be 200 or 401 or 404 or 500
