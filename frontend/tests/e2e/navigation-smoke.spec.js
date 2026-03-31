const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

const NAV_CASES = [
  { path: '/', expected: /Dashboard|Панель|Battletoads/i },
  { path: '/settings', expected: /Settings|Настройки|API Keys|API-ключ/i },
  { path: '/positions', expected: /Positions|Позиции|Open Positions|Active Positions/i },
  { path: '/logs', expected: /Logs|Логи|System Logs|Application Logs/i },
  { path: '/backtest', expected: /Backtest|Бэктест|Historical|Sweep/i },
  { path: '/trading-systems', expected: /Trading Systems|Торговые системы|System/i },
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
    await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
    await expect(page.locator('body')).toContainText(nav.expected, { timeout: 20000 });

    // Keep a lightweight responsiveness probe after each route load.
    const ts = await page.evaluate(() => Date.now());
    expect(Number.isFinite(ts)).toBeTruthy();
  }

  expect(runtimeErrors, `Runtime errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});
