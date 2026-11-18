import { test, expect } from '@playwright/test'

// Scratch spec (not committed): the setup finished notice for the E2E restaurant, exactly once.
test('Notifications lists Setup finished for the E2E restaurant once; Customers says Finished', async ({ page }, info) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: /^Notifications, \d+ new$/ }).first()).toBeVisible({ timeout: 30000 })
  await page.screenshot({ path: info.outputPath('badge.png') })
  await page.goto('/notifications')
  const rows = page.getByRole('link', { name: /^Setup finished: E2E Testkrogen/ })
  await expect(rows).toHaveCount(1)
  await page.screenshot({ path: info.outputPath('notifications.png'), fullPage: true })
  await rows.click()
  await expect(page.getByRole('heading', { name: 'Setup' })).toBeVisible()
  await page.screenshot({ path: info.outputPath('customer.png'), fullPage: true })
  await page.goto('/')
  await expect(page.getByRole('row', { name: /E2E Testkrogen/ }).getByText('Finished')).toBeVisible()
})
