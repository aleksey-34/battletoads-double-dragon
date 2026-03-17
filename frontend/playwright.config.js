// Minimal smoke config for production-like checks.
const { defineConfig } = require('@playwright/test');

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const browserChannel = process.env.E2E_BROWSER_CHANNEL || 'msedge';

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  retries: 0,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL,
    channel: browserChannel,
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  },
});
