Feature: API smoke after dashboard git update
  The backend must keep core endpoints responsive after an update.

  Scenario: Public recovery status endpoint is reachable
    When I send a "GET" request to "/api/auth/recovery/status" without auth
    Then the response status should be 200
    And the response JSON should include key "enabled"

  Scenario: Protected endpoint rejects unauthenticated access
    When I send a "GET" request to "/api/system/update/status" without auth
    Then the response status should be 401

  Scenario: Protected update status responds for admin auth
    Given dashboard auth password is "defaultpassword"
    When I send a "GET" request to "/api/system/update/status" with auth
    Then the response status should be 200
    And the response JSON should include key "configured"
    And the response JSON should include key "updateEnabled"

  Scenario: Update run endpoint fails gracefully when disabled
    Given git update feature is disabled
    And dashboard auth password is "defaultpassword"
    When I send a "POST" request to "/api/system/update/run" with auth
    Then the response status should be 500
    And the response error should contain "disabled"
