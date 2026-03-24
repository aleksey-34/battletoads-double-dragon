const { test, expect } = require('@playwright/test');

const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || 'defaultpassword';

test.describe('SaaS admin flow', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', (err) => {
      throw new Error(`Page runtime error: ${String(err && err.message ? err.message : err)}`);
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.evaluate((password) => {
      window.localStorage.setItem('password', password);
    }, ADMIN_PASSWORD);
  });

  test('admin tabs render and do not redirect to standalone backtest', async ({ page }) => {
    await page.goto('/saas', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('.ant-spin-spinning').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    await expect(page.getByText(/SaaS|Админ|Алгофонд|Клиенты/i).first()).toBeVisible({ timeout: 20000 });

    const strayBacktestLinks = await page.locator('a[href="/backtest"]').count();
    expect(strayBacktestLinks).toBe(0);

    const adminTab = page.getByText(/^Admin$|^Админ$/i).first();
    if (await adminTab.isVisible().catch(() => false)) {
      await adminTab.click();
      await page.waitForTimeout(500);
    }

    await page.getByText(/Оферы и ТС/i).first().click();
    await expect(page.getByText(/approved|витрина|review/i).first()).toBeVisible({ timeout: 20000 });

    await page.getByText(/Анализ ресерча/i).first().click();
    await expect(page.getByText(/research|sweep|candidate|кандидат/i).first()).toBeVisible({ timeout: 20000 });

    await page.getByText(/Клиенты/i).first().click();
    await expect(page.getByText(/Подключенные клиенты|clients|tenant/i).first()).toBeVisible({ timeout: 20000 });

    await page.getByText(/Мониторинг/i).first().click();
    await expect(page.locator('body')).toContainText(/Performance|Low-lot|monitoring|Отч[её]ты и аналитика/i, { timeout: 20000 });
  });

  test('offer-ts actions stay inside SaaS flow', async ({ page }) => {
    await page.goto('/saas', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.locator('.ant-spin-spinning').first().waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});

    const adminTab = page.getByText(/^Admin$|^Админ$/i).first();
    if (await adminTab.isVisible().catch(() => false)) {
      await adminTab.click();
      await page.waitForTimeout(500);
    }

    await page.getByText(/Оферы и ТС/i).first().click();
    await page.waitForTimeout(800);

    const reviewButton = page.getByRole('button', { name: /Открыть review ТС/i }).first();
    if (await reviewButton.isVisible().catch(() => false)) {
      await reviewButton.click();
      await page.waitForTimeout(800);
      await expect(page).toHaveURL(/\/saas$/);
    }

    const sweepButton = page.getByRole('button', { name: /Открыть sweep\/backtest/i }).first();
    if (await sweepButton.isVisible().catch(() => false)) {
      await sweepButton.click();
      await page.waitForTimeout(800);
      await expect(page).toHaveURL(/\/saas$/);
    }

    const editorBacktestButton = page.getByRole('button', { name: /Backtest ТС \(в окне\)/i }).first();
    if (await editorBacktestButton.isVisible().catch(() => false)) {
      await editorBacktestButton.click();
      await page.waitForTimeout(1000);
      await expect(page).toHaveURL(/\/saas$/);
      await expect(page.locator('iframe[title="Trading Systems Backtest"]')).toBeVisible({ timeout: 15000 });
    }
  });
});