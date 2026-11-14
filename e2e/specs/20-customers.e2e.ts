import { test, expect } from '@playwright/test'
import { watch } from '../lib/watch'
import { env, optEnv, saveEnv } from '../lib/env'
import { TENANT_NAME, mail } from '../lib/data'

test.describe('Console: customers', () => {
  test('list loads, search by name, slug, owner email @mobile', async ({ page }, info) => {
    const w = watch(page)
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible()
    const search = page.getByPlaceholder(/Search name, slug/)
    for (const q of ['E2E Testkrogen', 'e2e-testkrogen', 'e2e-owner', 'åäö']) {
      await search.fill(q)
      await expect(page.getByRole('link', { name: TENANT_NAME }), `search "${q}"`).toBeVisible()
    }
    await search.fill('zzzz-no-such-restaurant')
    await expect(page.getByRole('link', { name: TENANT_NAME })).toHaveCount(0)
    await expect(page.getByText(/No (customers|restaurants|match)/i).first()).toBeVisible()
    await w.attach(info)
  })

  test('status filters', async ({ page }) => {
    await page.goto('/')
    for (const f of ['Active', 'Suspended', 'Data deleted', 'All']) {
      await page.getByRole('button', { name: new RegExp(`^${f}`) }).click()
      await expect(page.locator('main')).toBeVisible()
    }
  })

  test('open customer, every tab renders without error @mobile', async ({ page }, info) => {
    const w = watch(page)
    await page.goto(`/tenants/${env('E2E_TENANT_ID')}`)
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(TENANT_NAME) })).toBeVisible()
    for (const tab of ['Locations', 'Users', 'Plan', 'Billing', 'Payments', 'Domains', 'Website', 'Integrations', 'Activity', 'Suspend or offboard', 'Overview']) {
      await page.locator('main nav').getByRole('button', { name: new RegExp(`^${tab}`) }).click()
      await page.waitForTimeout(800)
      await expect.soft(page.locator('.notice--error'), `tab ${tab} shows an error`).toHaveCount(0)
    }
    await w.attach(info)
    expect.soft(w.failed, w.failed.join('\n')).toEqual([])
  })

  test('edit company details with åäö and save', async ({ page }) => {
    await page.goto(`/tenants/${env('E2E_TENANT_ID')}`)
    await page.getByRole('button', { name: 'Edit' }).first().click()
    const legal = page.getByLabel('Legal name')
    const name = (await legal.inputValue()) === 'E2E Testkrogen Ölstugan AB' ? 'E2E Testkrogen Åkerö AB' : 'E2E Testkrogen Ölstugan AB'
    await legal.fill(name)
    await page.getByRole('button', { name: /^Save/ }).first().click()
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20000 })
  })

  test('invite an extra E2E owner on the Stripe-ready "Test Pizza" (for order tests)', async ({ page }, info) => {
    test.skip(Boolean(optEnv('E2E_PIZZA_OWNER_EMAIL')), 'already invited')
    await page.goto('/')
    await page.getByPlaceholder(/Search name, slug/).fill('test-pizza')
    await page.getByRole('link', { name: 'Test Pizza' }).click()
    await page.locator('main nav').getByRole('button', { name: /^Users/ }).click()
    await page.getByLabel('Name').fill('E2E Pizza Ägare')
    await page.getByLabel('Business email').fill(mail('pizza-owner'))
    await page.getByRole('button', { name: 'Send invite' }).click()
    await expect(page.getByText(mail('pizza-owner'))).toBeVisible({ timeout: 20000 })
    saveEnv('E2E_PIZZA_OWNER_EMAIL', mail('pizza-owner'))
    saveEnv('E2E_PIZZA_TENANT_ID', page.url().match(/tenants\/([0-9a-z]+)/)![1])
    await page.screenshot({ path: info.outputPath('invited.png') })
  })

  test('unknown customer id shows a not-found message, not a crash', async ({ page }) => {
    await page.goto('/tenants/does-not-exist-123')
    await expect(page.getByText(/not found|doesn't exist|No such/i).first()).toBeVisible()
  })
})
