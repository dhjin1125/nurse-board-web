import { defineConfig } from '@playwright/test';

const baseURL = process.env.NURSE_BOARD_E2E_BASE_URL || 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.pw.mjs',
  fullyParallel: true,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-1440', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    {
      name: 'mobile-safari',
      testMatch: '**/mobile-responsive.pw.mjs',
      use: { browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'npm start',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
