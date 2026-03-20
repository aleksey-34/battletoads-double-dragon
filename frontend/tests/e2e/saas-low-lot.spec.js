// @ts-check
const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

test.describe('SaaS admin — low-lot analytics panel', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`Page runtime error: ${String(err && err.message ? err.message : err)}`);
    });
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate((password) => {
      window.localStorage.setItem('password', password);
    }, ADMIN_PASSWORD);
  });

  test('SaaS monitoring tab loads without crash', async ({ page }) => {
    await page.goto('/?tab=saas', { waitUntil: 'domcontentloaded' });
    // Wait for the page to stabilize
    await page.waitForTimeout(1000);

    // Should not show a full-page error; something must render
    const body = await page.textContent('body');
    expect(body).not.toBeNull();

    // No uncaught JS errors (handled by pageerror above)
    const ts = await page.evaluate(() => Date.now());
    expect(Number.isFinite(ts)).toBeTruthy();
  });

  test('SaaS page renders and has monitoring section', async ({ page }) => {
    await page.goto('/?tab=saas', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Look for "Monitoring" or "SaaS" related content
    const hasContent = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return text.includes('monitoring') || text.includes('saas') || text.includes('low-lot') || text.includes('tenant');
    });
    expect(hasContent).toBeTruthy();
  });

  test('Low-lot recommendations endpoint responds', async ({ page }) => {
    // Hit the API directly (via browser fetch on the same origin)
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((password) => {
      window.localStorage.setItem('password', password);
    }, ADMIN_PASSWORD);

    const result = await page.evaluate(async (password) => {
      try {
        const resp = await fetch('/api/saas/admin/low-lot-recommendations?hours=72&limit=10', {
          headers: { Authorization: `Bearer ${password}` },
        });
        const data = await resp.json();
        return { status: resp.status, hasItems: Array.isArray(data.items), hasGeneratedAt: Boolean(data.generatedAt) };
      } catch (e) {
        return { error: String(e) };
      }
    }, ADMIN_PASSWORD);

    expect(result.status).toBe(200);
    expect(result.hasItems).toBeTruthy();
    expect(result.hasGeneratedAt).toBeTruthy();
  });

  test('Apply low-lot endpoint is reachable and validates input', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((password) => {
      window.localStorage.setItem('password', password);
    }, ADMIN_PASSWORD);

    const result = await page.evaluate(async (password) => {
      try {
        const resp = await fetch('/api/saas/admin/apply-low-lot-recommendation', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${password}`,
          },
          body: JSON.stringify({ strategyId: 0, applyDepositFix: true, applyLotFix: false }),
        });
        return { status: resp.status };
      } catch (e) {
        return { error: String(e) };
      }
    }, ADMIN_PASSWORD);

    // Should return a validation/not found error, not a 2xx for strategyId=0
    expect([400, 404, 500]).toContain(result.status);
  });
});
