import { firefox } from '@playwright/test';
import fs from 'node:fs/promises';

const url = process.env.E2E_BASE_URL || 'http://176.57.184.98/';
const outDir = 'C:/Users/Aleksei/battletoads-double-dragon-github/logs/diag';

const run = async (name, launcher) => {
  const errors = [];
  const logs = [];
  const browser = await launcher.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on('pageerror', (err) => errors.push(String(err?.message || err)));
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);

  const title = await page.title();
  const html = await page.content();
  const screenshotPath = `${outDir}/white_${name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await browser.close();

  await fs.writeFile(`${outDir}/white_${name}.json`, JSON.stringify({
    browser: name,
    url,
    status: response?.status() || null,
    title,
    errors,
    logs: logs.slice(0, 80),
    htmlSnippet: html.slice(0, 3000),
  }, null, 2), 'utf8');
};

await run('firefox', firefox);
console.log('done');
