import { chromium } from '@playwright/test';

const url = process.env.E2E_BASE_URL || 'http://176.57.184.98/saas';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const pageErrors = [];
const logs = [];

page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

let status = null;
try {
  const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  status = response ? response.status() : null;
} catch (error) {
  console.log('GOTO_ERROR=' + String(error && error.message ? error.message : error));
}

await page.waitForTimeout(2500);

const title = await page.title();
const bodyText = await page.locator('body').innerText().catch(() => '');

console.log('URL=' + page.url());
console.log('STATUS=' + String(status));
console.log('TITLE=' + title);
console.log('BODY_LEN=' + String((bodyText || '').length));
if (pageErrors.length > 0) {
  console.log('PAGE_ERRORS_START');
  for (const line of pageErrors) console.log(line);
  console.log('PAGE_ERRORS_END');
}
if (logs.length > 0) {
  console.log('CONSOLE_START');
  for (const line of logs.slice(-80)) console.log(line);
  console.log('CONSOLE_END');
}

await page.screenshot({ path: 'test-results/runtime-probe.png', fullPage: true });
await browser.close();
