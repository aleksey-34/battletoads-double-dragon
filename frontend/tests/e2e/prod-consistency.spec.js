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

async function loginAsAdmin(page) {
  await gotoStable(page, '/login');
  const passwordInput = page.getByPlaceholder(/Password|Пароль/i);
  await passwordInput.fill(ADMIN_PASSWORD);
  await page.getByRole('main').getByRole('button', { name: /Login|Войти/i }).click();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
}

test('prod SaaS surfaces stay globally consistent', async ({ page }) => {
  test.setTimeout(120_000);
  const runtimeErrors = [];
  page.on('pageerror', (err) => {
    runtimeErrors.push(String(err && err.message ? err.message : err));
  });

  await loginAsAdmin(page);
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 20000 });

  await gotoStable(page, '/saas/admin?adminTab=offer-ts');
  await page.waitForTimeout(1800);
  await page.locator('.ant-spin-spinning').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

  await expect(page.locator('body')).toContainText(/Витрина ТС Алгофонда|Витрина Алгофонд|Витринные TS/i, { timeout: 20000 });
  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
  await expect(page.locator('body')).not.toContainText(/legacy snapshot/i, { timeout: 5000 });

  const storefrontTsSection = page.locator('.ant-card').filter({
    has: page.getByText(/Витрина ТС Алгофонда/i).first(),
  }).first();
  const tsButtons = storefrontTsSection.getByRole('button', { name: /Бэктест ТС/i });
  const tsButtonCount = await tsButtons.count();
  if (tsButtonCount === 0) {
    await expect(storefrontTsSection).toContainText(/Пока нет опубликованной ТС Алгофонда на витрине|Витрина Алгофонда сейчас пуста/i, { timeout: 10000 });
  }

  const visibleTsTitles = await storefrontTsSection.locator('button:has-text("Бэктест ТС")').evaluateAll((buttons) => buttons.map((button) => {
    const card = button.closest('.ant-card');
    const text = card ? card.textContent || '' : '';
    return text.split('Бэктест ТС')[0].trim().slice(0, 240);
  })).then((items) => items.filter((title) => !/Оферы и ТС на витринах/i.test(title)));
  console.log('VISIBLE_TS_TITLES', JSON.stringify(visibleTsTitles.slice(0, 5)));

  const checks = Math.min(visibleTsTitles.length, 3);
  for (let index = 0; index < checks; index += 1) {
    console.log('OPEN_TS_INDEX', index, visibleTsTitles[index] || 'unknown');
    await tsButtons.nth(index).click();
    const drawer = page.locator('.ant-drawer').last();
    await expect(drawer).toBeVisible({ timeout: 15000 });
    await expect(drawer).toContainText(/Бэктест ТС:/i, { timeout: 15000 });
    await expect(drawer).not.toContainText(/•\s*(5m|15m|1h|4h)\b/i, { timeout: 3000 });

    const closeButton = drawer.getByRole('button', { name: /Close|Закрыть/i }).first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await drawer.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  }

  await gotoStable(page, '/saas/algofund');
  await page.waitForTimeout(1200);
  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/Алгофонд|Algofund|Витрина/i, { timeout: 20000 });

  await gotoStable(page, '/saas/strategy-client');
  await page.waitForTimeout(1200);
  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/Стратег|Strategy|Клиент/i, { timeout: 20000 });

  await gotoStable(page, '/trading-systems');
  await page.waitForTimeout(1200);
  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });

  expect(runtimeErrors, `Runtime errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});