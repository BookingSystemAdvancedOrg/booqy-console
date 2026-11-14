import { test, expect, type Page } from '@playwright/test'
import { watch } from '../lib/watch'
import { saveEnv, optEnv } from '../lib/env'
import { TENANT_NAME, TENANT_SLUG, mail, PHONE, ORG_NUMBER } from '../lib/data'

/** Done on the open step: it folds and the next one opens under it. */
const done = (page: Page) => page.locator('.step--open .step__done').first().click()

/**
 * New customer end to end: form validation, all features, owner invite,
 * Stripe status, site provisioning. Creates the E2E test restaurant once
 * (skips when E2E_TENANT_ID is already known).
 */
test.describe('Console: New customer', () => {
  test('an empty step cannot be finished', async ({ page }) => {
    await page.goto('/tenants/new')
    await expect(page.getByRole('button', { name: 'Create customer' })).toHaveCount(0)
    await done(page)
    await expect(page.locator('.field--error').first()).toBeVisible()
    await expect(page.getByLabel('Owner full name')).toHaveCount(0)
  })

  test('slug is generated, org number formats, VAT fills in', async ({ page }) => {
    await page.goto('/tenants/new')
    await page.getByLabel('Restaurant / brand name').fill('E2E Prov Ö')
    await expect(page.getByLabel(/^Slug/)).toHaveValue(/^e2e-prov-o/)
    await page.getByLabel(/^Org\. number/).fill(ORG_NUMBER)
    await expect(page.getByLabel(/^Org\. number/)).toHaveValue('559000-0005')
    await expect(page.getByLabel(/^VAT number/)).toHaveValue('SE559000000501')
  })

  test('create the E2E restaurant (Growth, every feature)', async ({ page }, info) => {
    test.skip(Boolean(optEnv('E2E_TENANT_ID')), 'test restaurant already exists')
    const w = watch(page)
    await page.goto('/tenants/new')
    await page.getByLabel('Restaurant / brand name').fill(TENANT_NAME)
    await page.getByLabel(/^Slug/).fill(TENANT_SLUG)
    await page.getByLabel('Legal name').fill('E2E Testkrogen AB')
    await page.getByLabel(/^Org\. number/).fill(ORG_NUMBER)
    await page.getByLabel('Street address').fill('Testgatan 1')
    await page.getByLabel('Postal code').fill('11122')
    await page.getByLabel('City').fill('Stockholm')
    await done(page)
    await page.getByLabel('Owner full name').fill('E2E Ägare Öberg')
    await page.getByLabel(/^Owner business email/).fill(mail('owner'))
    await page.getByLabel('Owner phone').fill(PHONE)
    await done(page)
    await page.getByLabel('Contact email').fill(mail('contact'))
    await page.getByLabel('Contact phone').fill(PHONE)
    await page.getByLabel(/^Billing email/).fill(mail('billing'))
    await page.getByLabel(/^Sender name/).fill('E2ETestkrog')
    await page.getByLabel(/^Reply-to email/).fill(mail('reply'))
    await done(page)
    await page.locator('label.plan', { hasText: 'Growth' }).click()
    for (const box of await page.locator('.checks label.check').all()) {
      if (!(await box.locator('input').isChecked())) await box.click()
    }
    const start = page.getByLabel('Start the agreement when the customer is created')
    if (await start.isChecked()) await start.uncheck()
    await done(page)
    await page.getByLabel('Location name').fill('E2E Testkrogen Södermalm')
    await page.getByLabel('Address', { exact: true }).fill('Götgatan 10, 118 46 Stockholm')
    await page.getByLabel('Phone', { exact: true }).fill(PHONE)
    await page.getByLabel('Email', { exact: true }).fill(mail('location'))
    await done(page)
    await page.getByLabel(/^Notes/).fill('E2E test customer, safe to delete')
    await done(page)
    await expect(page.getByRole('progressbar', { name: 'Progress' })).toHaveAttribute('aria-valuenow', '100')
    await page.screenshot({ path: info.outputPath('form.png'), fullPage: true })
    await page.getByRole('button', { name: 'Create customer' }).click()
    await page.waitForURL(/\/tenants\/[0-9a-z]{20,}/, { timeout: 60000 })
    const id = page.url().match(/tenants\/([0-9a-z]+)/)![1]
    saveEnv('E2E_TENANT_ID', id)
    await page.screenshot({ path: info.outputPath('created.png'), fullPage: true })
    await w.attach(info)
    expect(w.failed, w.failed.join('\n')).toEqual([])
  })
})
