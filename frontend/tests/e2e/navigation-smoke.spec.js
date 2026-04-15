const { test, expect } = require('@playwright/test');

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

async function expectDefaultLightLanding(page) {
  await expect.poll(async () => page.evaluate(() => {
    const root = Array.from(document.querySelectorAll('div')).find((element) => {
      return element instanceof HTMLDivElement && element.style.minHeight === '100vh';
    });
    const lightButton = document.querySelector('button[title="Light"]');
    const rootBackground = root ? getComputedStyle(root).backgroundColor : null;
    const lightButtonBackground = lightButton ? getComputedStyle(lightButton).backgroundColor : null;
    return {
      rootBackground,
      lightButtonBackground,
    };
  })).toEqual({
    rootBackground: 'rgb(255, 255, 255)',
    lightButtonBackground: 'rgba(99, 102, 241, 0.15)',
  });
}
const NAV_CASES = [
  { path: '/', expectedUrl: /\/$/, expected: /BTDD|Start Free|Sign Up|Algorithmic Trading/i },
  { path: '/settings', expectedUrl: /\/login$/, expected: /Dashboard Login|Invalid password|Session: missing/i },
  { path: '/positions', expectedUrl: /\/login$/, expected: /Dashboard Login|Session: missing/i },
  { path: '/logs', expectedUrl: /\/login$/, expected: /Dashboard Login|Session: missing/i },
  { path: '/backtest', expectedUrl: /\/login$/, expected: /Dashboard Login|Session: missing|Login/i },
  { path: '/trading-systems', expectedUrl: /\/login$/, expected: /Dashboard Login|Session: missing|Login/i },
  { path: '/saas', expectedUrl: /\/login$/, expected: /Dashboard Login|Session: missing/i },
];

test('all main tabs open without runtime crash', async ({ page }) => {
  const runtimeErrors = [];

  page.on('pageerror', (err) => {
    runtimeErrors.push(String(err && err.message ? err.message : err));
  });

  await gotoStable(page, '/');
  await expect(page.locator('body')).toContainText(/BTDD|Battletoads|BattleToads/i, { timeout: 20000 });
  await expect(page.locator('body')).toContainText(/Start Free|Sign Up|Algorithmic Trading/i, { timeout: 20000 });
  await expectDefaultLightLanding(page);
  await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });

  for (const nav of NAV_CASES) {
    await gotoStable(page, nav.path);
    if (nav.expectedUrl) {
      await expect(page).toHaveURL(nav.expectedUrl, { timeout: 20000 });
    }
    await expect(page.locator('body')).not.toContainText(/Cannot GET|404|Application error|Runtime error|Unhandled/i, { timeout: 20000 });
    await expect(page.locator('body')).toContainText(nav.expected, { timeout: 20000 });

    // Keep a lightweight responsiveness probe after each route load.
    const ts = await page.evaluate(() => Date.now());
    expect(Number.isFinite(ts)).toBeTruthy();
  }

  expect(runtimeErrors, `Runtime errors:\n${runtimeErrors.join('\n')}`).toEqual([]);
});
