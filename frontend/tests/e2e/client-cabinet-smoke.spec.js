const { test, expect } = require('@playwright/test');

const CLIENT_MAGIC_LINK = process.env.E2E_CLIENT_MAGIC_LINK || '';

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

test('client magic link opens cabinet flow without runtime crash', async ({ page }) => {
  test.skip(!CLIENT_MAGIC_LINK, 'E2E_CLIENT_MAGIC_LINK is required');

  const runtimeErrors = [];
  page.on('pageerror', (err) => {
    runtimeErrors.push(String(err && err.message ? err.message : err));
  });

  await page.goto(CLIENT_MAGIC_LINK, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/Client Access|Password|cabinet|workspace|password set|set password|клиент|кабинет/i, { timeout: 20000 });

  const cabinetUrlReached = /\/cabinet$/.test(page.url());
  const passwordSetupVisible = await page.locator('body').textContent().then((text) => /set password|new password|парол/i.test(String(text || ''))).catch(() => false);
  expect(cabinetUrlReached || passwordSetupVisible).toBeTruthy();

  if (cabinetUrlReached) {
    await gotoStable(page, '/cabinet');
    await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
  }

  expect(runtimeErrors, `Runtime errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});