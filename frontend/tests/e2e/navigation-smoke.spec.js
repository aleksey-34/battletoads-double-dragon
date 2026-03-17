const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

const NAV_CASES = [
  { path: '/', expected: /Trading Bot Dashboard/i },
  { path: '/settings', expected: /Git Update \(VPS\)|API Keys List/i },
  { path: '/positions', expected: /Positions|Open Positions|Active Positions/i },
  { path: '/logs', expected: /Logs|System Logs|Application Logs/i },
  { path: '/backtest', expected: /Backtest|Historical|Sweep/i },
  { path: '/trading-systems', expected: /Trading Systems|System/i },
  { path: '/saas', expected: /SaaS|Admin|Алгофонд|Клиент/i },
];

test('all main tabs open without runtime crash', async ({ page }) => {
  const runtimeErrors = [];

  page.on('pageerror', (err) => {
    runtimeErrors.push(String(err && err.message ? err.message : err));
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  await page.evaluate((password) => {
    window.localStorage.setItem('password', password);
  }, ADMIN_PASSWORD);

  for (const nav of NAV_CASES) {
    await page.goto(nav.path, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(nav.expected).first()).toBeVisible({ timeout: 20000 });

    // Keep a lightweight responsiveness probe after each route load.
    const ts = await page.evaluate(() => Date.now());
    expect(Number.isFinite(ts)).toBeTruthy();
  }

  expect(runtimeErrors, `Runtime errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});
