const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

test('settings update controls and dashboard remain responsive', async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Page runtime error: ${String(err && err.message ? err.message : err)}`);
  });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  // Seed admin auth to avoid brittle UI login form selectors.
  await page.evaluate((password) => {
    window.localStorage.setItem('password', password);
  }, ADMIN_PASSWORD);

  await page.goto('/settings', { waitUntil: 'domcontentloaded' });

  const checkUpdatesButton = page.getByRole('button', { name: /Check updates|Проверить обновления/i });
  await expect(checkUpdatesButton).toBeVisible();
  await checkUpdatesButton.click();

  const refreshJobButton = page.getByRole('button', { name: /Refresh job|Обновить статус/i });
  await expect(refreshJobButton).toBeVisible();
  await refreshJobButton.click();

  const installButton = page.getByRole('button', { name: /Install from Git|Установить из Git/i });
  await expect(installButton).toBeVisible();

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText(/Dashboard|Панель|Battletoads/i, { timeout: 20000 });

  const themeSelect = page.locator('.ant-select').first();
  await expect(themeSelect).toBeVisible();
  await themeSelect.click();
  await page.keyboard.press('Escape');

  // Final responsiveness check to catch frozen UI states.
  const ts = await page.evaluate(() => Date.now());
  expect(Number.isFinite(ts)).toBeTruthy();
});
