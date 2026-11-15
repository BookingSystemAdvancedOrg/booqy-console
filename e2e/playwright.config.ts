import { defineConfig, devices } from '@playwright/test'
import { env } from './lib/env'

/**
 * Booqy Console end-to-end tests against a live environment (dev by default).
 * Base URL: E2E_CONSOLE_URL. Credentials: env vars or the local file named by
 * E2E_ENV_FILE (see lib/env.ts). Never point this at prod.
 */
const baseURL = env('E2E_CONSOLE_URL', 'https://admin.dev.booqy.se')
if (/\/\/admin\.booqy\.se/.test(baseURL)) throw new Error('Refusing to run against prod')

export default defineConfig({
  testDir: 'specs',
  // *.e2e.ts, not *.spec.ts: the app's vitest would pick those up
  testMatch: /\.e2e\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }], ['html', { open: 'never' }]],
  use: {
    baseURL,
    locale: 'sv-SE',
    timezoneId: 'Europe/Stockholm',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    storageState: '.auth/operator.json',
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { storageState: { cookies: [], origins: [] } } },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
    { name: 'iphone', use: { ...devices['iPhone 15'] }, dependencies: ['setup'], grep: /@mobile/ },
    { name: 'tablet', use: { ...devices['iPad (gen 7)'], browserName: 'chromium' }, dependencies: ['setup'], grep: /@mobile/ },
  ],
})
