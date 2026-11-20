import { defineConfig } from '@playwright/test';

// Desktop end-to-end tests. Build first (npm run build), then: npx playwright test -c e2e/playwright.config.ts
export default defineConfig({
  testDir: '.',
  testMatch: /electron\.spec\.ts$/,
  timeout: 120_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
