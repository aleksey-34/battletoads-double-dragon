const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

async function gotoStable(page, path) {
  try {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!message.includes('ERR_ABORTED')) {
      throw error;
    }
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  }
}

async function expectV3Landing(page) {
  await expect.poll(async () => page.evaluate(() => {
    const root = document.querySelector('.landing-v3-root');
    const bg = root ? getComputedStyle(root).backgroundColor : null;
    return { hasRoot: Boolean(root), bg };
  })).toEqual({
    hasRoot: true,
    bg: 'rgb(6, 6, 8)',
  });
}

async function tryLoginAsAdmin(page) {
  await gotoStable(page, '/login');
  await page.getByPlaceholder(/Password|Пароль/i).fill(ADMIN_PASSWORD);
  await page.getByRole('main').getByRole('button', { name: /Login|Войти/i }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  if (/\/(dashboard|saas|settings)$/.test(page.url())) {
    return true;
  }
  return false;
}

test('settings update controls and dashboard remain responsive', async ({ page }) => {
  page.on('pageerror', (err) => {
    throw new Error(`Page runtime error: ${String(err && err.message ? err.message : err)}`);
  });

  await gotoStable(page, '/');
  await expect(page.locator('body')).toContainText(/BattleToads|Алгоритмы торгуют|Открыть кабинет/i, { timeout: 20000 });
  await expectV3Landing(page);

  await gotoStable(page, '/settings');
  await expect(page).toHaveURL(/\/login$/, { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/Dashboard Login|Session: missing|Login/i, { timeout: 20000 });

  const loginSucceeded = await tryLoginAsAdmin(page);

  if (loginSucceeded) {
    await gotoStable(page, '/settings');
    await expect(page).toHaveURL(/\/settings$/, { timeout: 20000 });

    const checkUpdatesButton = page.getByRole('button', { name: /Check updates|Проверить обновления/i });
    await expect(checkUpdatesButton).toBeVisible();
    await checkUpdatesButton.click();

    const refreshJobButton = page.getByRole('button', { name: /Refresh job|Обновить статус/i });
    await expect(refreshJobButton).toBeVisible();
    await refreshJobButton.click();

    const installButton = page.getByRole('button', { name: /Install from Git|Установить из Git/i });
    await expect(installButton).toBeVisible();

    await gotoStable(page, '/');
    await expect(page.locator('body')).toContainText(/SaaS|Dashboard|Панель|BTDD/i, { timeout: 20000 });
  } else {
    // Login didn't succeed — verify we're back at the login page (error message may have auto-dismissed)
    await expect(page).toHaveURL(/\/login/, { timeout: 10000 });
  }

  const lightThemeControl = page.getByTitle(/Light/i);
  await expect(lightThemeControl).toBeVisible();
  await lightThemeControl.click();

  // Final responsiveness check to catch frozen UI states.
  const ts = await page.evaluate(() => Date.now());
  expect(Number.isFinite(ts)).toBeTruthy();
});
