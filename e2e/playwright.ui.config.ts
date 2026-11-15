import { defineConfig, devices } from '@playwright/test'

/**
 * Console UI suite: layout, accessibility, visual regression at every common
 * size, on the local dev server with a stubbed Cognito session and a stubbed
 * API (lib/ui-fixtures.ts). Nothing touches dev or prod. `npm run test:ui`.
 */
const PORT = Number(process.env.UI_PORT ?? 7175)

export default defineConfig({
  testDir: 'ui',
  testMatch: /\.ui\.ts$/,
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, threshold: 0.2, animations: 'disabled', caret: 'hide' } },
  fullyParallel: true,
  workers: Number(process.env.UI_WORKERS ?? 4),
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'test-results/ui-results.json' }]],
  outputDir: 'test-results/ui',
  snapshotPathTemplate: 'ui-baselines/{arg}{ext}',
  use: { baseURL: `http://localhost:${PORT}`, locale: 'en-GB', timezoneId: 'Europe/Stockholm', reducedMotion: 'reduce', screenshot: 'only-on-failure', actionTimeout: 10_000, navigationTimeout: 30_000 },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: '../web',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      VITE_API_URL: 'https://api.e2e.test',
      VITE_COGNITO_AUTHORITY: 'https://cognito-idp.eu-north-1.amazonaws.com/eu-north-1_E2EPOOL',
      VITE_COGNITO_CLIENT_ID: 'e2eclient',
      VITE_COGNITO_DOMAIN: 'https://e2e.auth.eu-north-1.amazoncognito.com',
      VITE_ENVIRONMENT: 'dev',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@x/ },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@x/ },
  ],
})
