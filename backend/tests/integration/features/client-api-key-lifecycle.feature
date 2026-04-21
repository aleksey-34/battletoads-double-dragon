Feature: Client API key lifecycle
  Scenario: Additional client API keys stay visible and conflicts return 409
    Given an authenticated dual-mode client workspace
    When the client creates API key "alpha"
    And the client creates API key "beta"
    And the client lists API keys
    Then the API key list should contain 2 keys
    And API key "alpha" should not be assigned to any client flow
    And API key "beta" should not be assigned to any client flow
    When the client saves strategy profile with API key "alpha" and requestedEnabled "false"
    Then the response status should be 200
    When the client saves algofund profile with API key "alpha"
    Then the response status should be 409
    And the response error should contain "Нельзя использовать один ключ"
    When the client saves algofund profile with API key "beta"
    Then the response status should be 200
    When the client lists API keys
    Then API key "alpha" should be marked for strategy usage
    And API key "beta" should be marked for algofund usage

  Scenario: Deleting an active strategy API key is blocked
    Given an authenticated dual-mode client workspace
    When the client creates API key "live"
    And the client saves strategy profile with API key "live" and requestedEnabled "true"
    Then the response status should be 200
    When the client deletes API key "live"
    Then the response status should be 409
    And the response error should contain "активным потоком Стратегий"

  Scenario: Deleting the last dormant API key auto-detaches it
    Given an authenticated dual-mode client workspace
    When the client creates API key "solo"
    And the client saves strategy profile with API key "solo" and requestedEnabled "false"
    Then the response status should be 200
    When the client deletes API key "solo"
    Then the response status should be 200
    When the client lists API keys
    Then the API key list should contain 0 keys
    And the strategy API assignment should be empty