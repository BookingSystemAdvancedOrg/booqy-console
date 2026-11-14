import { test, expect } from '@playwright/test'
import { env, optEnv } from '../lib/env'

/** Pause (suspend) the E2E customer, check the guest API hides it, then resume. */
test('suspend and resume the E2E customer', async ({ page, request }, info) => {
  const id = env('E2E_TENANT_ID')
  const api = optEnv('E2E_API_URL') ?? 'https://dh2m5ildm7.execute-api.eu-north-1.amazonaws.com'
  page.on('dialog', (d) => d.accept())
  await page.goto(`/tenants/${id}`)
  await page.locator('main nav').getByRole('button', { name: /^Suspend or offboard/ }).click()
  const reason = page.getByLabel(/Reason/i).first()
  if (await reason.isVisible().catch(() => false)) await reason.fill('E2E test: pause and resume')
  await page.getByRole('button', { name: 'Suspend customer' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Suspended/i, { timeout: 30000 })
  const hidden = await request.get(`${api}/site-config?slug=e2e-testkrogen`)
  info.annotations.push({ type: 'site-config while suspended', description: String(hidden.status()) })
  expect.soft(hidden.status(), 'a suspended restaurant is hidden from guests').toBeGreaterThanOrEqual(400)
  await page.getByRole('button', { name: 'Resume customer' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Active/i, { timeout: 30000 })
  const back = await request.get(`${api}/site-config?slug=e2e-testkrogen`)
  expect(back.status()).toBe(200)
})
