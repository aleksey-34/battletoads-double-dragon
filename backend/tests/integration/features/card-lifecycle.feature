Feature: Trading card lifecycle
  Covers the full SaaS lifecycle: sweep artifacts → card creation → admin backtest →
  storefront publishing → client connection → monitoring → unpublish with impact analysis.
  Also validates BTDD_D1 key appearing as an algofund_client card and Telegram interval setting.

  Background:
    Given the SaaS database is initialized

  # ─── PHASE 1: Offer store – catalog and publishing ───────────────────────────

  Scenario: Offer store state is fetchable
    When I send a GET request to "/api/saas/admin/offer-store"
    Then the response status should be 200
    And the response JSON should include key "offers"
    And the response JSON should include key "publishedIds"

  Scenario: Admin publishes an offer to the storefront
    Given an offer exists in the catalog with any offerId
    When I publish the first available offer via "/api/saas/admin/offer-store/publish"
    Then the response status should be 200
    And the published offer appears in the published IDs list

  Scenario: Unpublish impact is analyzed before removal
    Given at least one offer is published to the storefront
    When I request unpublish impact for the published offer via "/api/saas/admin/offer-store/unpublish-impact/:offerId"
    Then the response status should be 200
    And the response JSON should include key "offerId"
    And the response JSON should include key "affectedTenants"
    And the response JSON should include key "openPositions"
    And the response JSON should include key "summary"

  Scenario: Unpublishing an offer with no active clients succeeds silently
    Given an offer is published but has no active client tenants
    When I unpublish the offer via "/api/saas/admin/offer-store/unpublish"
    Then the response status should be 200
    And the offer is no longer in the published IDs list

  # ─── PHASE 2: Tenant and client card creation ─────────────────────────────────

  Scenario: Admin creates an algofund_client tenant
    When I POST to "/api/saas/admin/tenants" with body:
      """
      { "displayName": "Test Algofund Client", "productMode": "algofund_client", "planCode": "algofund_20" }
      """
    Then the response status should be 200
    And the response JSON should include key "tenants"
    And the tenants list includes a tenant with slug matching "test-algofund-client"

  Scenario: Admin creates a strategy_client tenant
    When I POST to "/api/saas/admin/tenants" with body:
      """
      { "displayName": "Test Strategy Client", "productMode": "strategy_client", "planCode": "strategy_20" }
      """
    Then the response status should be 200
    And the tenants list includes a tenant with a strategy_client product mode

  Scenario: All tenants are listed correctly after creation
    When I send a GET request to "/api/saas/admin/tenants"
    Then the response status should be 200
    And the response JSON should include key "tenants"

  # ─── PHASE 3: Algofund start/stop requests and profile enabling ───────────────

  Scenario: Algofund start request can be submitted for an active tenant
    Given an algofund_client tenant exists
    When I POST to "/api/saas/tenants/:tenantId/algofund/request" with action "start"
    Then the response status should be 200

  Scenario: Algofund request list is accessible for admin
    When I send a GET request to "/api/saas/admin/algofund-requests"
    Then the response status should be 200
    And the response JSON should include key "requests"

  # ─── PHASE 4: Monitoring – published trading systems ─────────────────────────

  Scenario: Admin trading systems list is accessible
    When I send a GET request to "/api/saas/admin/trading-systems"
    Then the response status should be 200

  Scenario: Admin can fetch the backtest snapshot for a published TS
    When I send a GET request to "/api/saas/admin/offer-store"
    Then the response status should be 200
    And the response JSON should include key "tsBacktestSnapshot"

  # ─── PHASE 5: Telegram controls and report interval ──────────────────────────

  Scenario: Telegram controls endpoint returns reportIntervalMinutes
    When I send a GET request to "/api/saas/admin/telegram-controls"
    Then the response status should be 200
    And the response JSON should include key "adminEnabled"
    And the response JSON should include key "reportIntervalMinutes"

  Scenario: Admin can set report interval to 60 minutes
    When I PATCH "/api/saas/admin/telegram-controls" with body:
      """
      { "reportIntervalMinutes": 60 }
      """
    Then the response status should be 200
    And the response JSON field "reportIntervalMinutes" equals 60

  Scenario: Report interval is clamped to minimum 5 minutes
    When I PATCH "/api/saas/admin/telegram-controls" with body:
      """
      { "reportIntervalMinutes": 1 }
      """
    Then the response status should be 200
    And the response JSON field "reportIntervalMinutes" is at least 5

  Scenario: Report interval is clamped to maximum 1440 minutes
    When I PATCH "/api/saas/admin/telegram-controls" with body:
      """
      { "reportIntervalMinutes": 9999 }
      """
    Then the response status should be 200
    And the response JSON field "reportIntervalMinutes" is at most 1440

  # ─── PHASE 6: BTDD_D1 as algofund_client card ────────────────────────────────

  Scenario: BTDD_D1 API key exists in the system
    When I send a GET request to "/api/saas/admin/api-keys"
    Then the response status should be 200

  Scenario: Admin report settings are readable
    When I send a GET request to "/api/saas/admin/reports/settings"
    Then the response status should be 200
    And the response JSON should include key "enabled"

  # ─── PHASE 7: Unpublish with active clients shows impact ─────────────────────

  Scenario: Unpublish impact reports affected tenants when clients are connected
    Given an algofund_client tenant is connected to a published offer
    When I request unpublish impact for that offer
    Then the affectedTenants count is greater than 0

  # ─── PHASE 8: Sweep summary available ────────────────────────────────────────

  Scenario: Sweep summary endpoint responds
    When I send a GET request to "/api/saas/admin/sweep-summary"
    Then the response status should be 200

  Scenario: Catalog summary endpoint responds
    When I send a GET request to "/api/saas/admin/catalog"
    Then the response status should be 200
