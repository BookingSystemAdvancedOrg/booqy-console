import { test, expect, type Page } from '@playwright/test'
import { env } from '../lib/env'

/**
 * Invoice credit (Billing tab) on the live dev in Stripe TEST mode, on the E2E
 * customer: starts an agreement paid by invoice (e-mailed to the SES simulator,
 * reaches nobody) when there is no invoice yet, then credits an OPEN invoice in
 * parts: amount above the rest refused, a double click credits once, the
 * confirm dialog, "back" shown on the row. A refund back to a card needs a paid
 * invoice and cannot be made without typing a card number, so it is not here.
 */
test.describe.configure({ mode: 'serial' })

async function openBilling(page: Page) {
  await page.goto(`/tenants/${env('E2E_TENANT_ID')}?tab=billing`)
  await expect(page.getByRole('heading', { level: 2, name: 'Agreement' }).or(page.getByText('Agreement').first())).toBeVisible()
  await page.waitForTimeout(800)
}

const pickBoxes = (page: Page) => page.locator('.invoice-table td.cell-pick input[type=checkbox]')

test('there is an open invoice to credit (start the agreement and invoice if needed)', async ({ page }) => {
  await openBilling(page)
  if ((await pickBoxes(page).count()) > 0) return
  if (await page.getByRole('button', { name: /^Start (a new )?agreement/ }).count()) {
    await page.getByRole('button', { name: /^Start (a new )?agreement/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Start the agreement' })
    await dlg.getByText('Invoice (pay within 30 days)').click()
    await dlg.getByRole('button', { name: 'Start agreement' }).click()
    await expect(dlg).toBeHidden({ timeout: 40000 })
  }
  await openBilling(page)
  const invoiceNow = page.getByRole('button', { name: 'Invoice now' })
  if (await invoiceNow.count()) {
    await invoiceNow.click()
    await expect(page.getByText(/invoice(s)? created|Nothing to invoice/)).toBeVisible({ timeout: 60000 })
  }
  await openBilling(page)
  await expect(pickBoxes(page).first(), 'an invoice that can be credited').toBeVisible({ timeout: 30000 })
})

test('credit in parts: too much is refused, a double click credits once, back is shown', async ({ page }, info) => {
  await openBilling(page)
  const row = page.locator('.invoice-table tbody tr').filter({ has: page.locator('td.cell-pick input') }).first()
  const box = row.locator('td.cell-pick input')
  await box.check()
  await page.getByRole('button', { name: /^Refund or credit \(1\)/ }).click()
  const dlg = page.getByRole('dialog', { name: /^(Credit|Refund) invoice / })
  await expect(dlg).toBeVisible()
  await dlg.screenshot({ path: info.outputPath('credit-dialog.png') })
  // an open invoice cannot go back to a card: credit is the only choice
  await expect(dlg.getByRole('radio', { name: 'Back to the card' })).toBeDisabled()
  const amount = dlg.getByLabel(/^Amount for /)
  const max = Number(((await dlg.locator('.field__hint', { hasText: /^Max / }).first().innerText()).match(/([\d\s]+(?:,\d+)?)/)?.[1] ?? '0').replace(/\s/g, '').replace(',', '.'))
  expect(max).toBeGreaterThan(2)
  await amount.fill(String(max + 1))
  await expect(dlg.getByText(/At most/)).toBeVisible()
  await expect(dlg.getByRole('button', { name: /^Credit / })).toBeDisabled()
  await amount.fill('abc')
  await expect(dlg.getByText('Enter an amount')).toBeVisible()
  await amount.fill('1,00')
  const confirm = dlg.getByRole('button', { name: 'Credit 1,00 kr' })
  await expect(confirm).toBeEnabled()
  await confirm.dblclick() // double click: one credit note
  await expect(dlg).toBeHidden({ timeout: 40000 })
  await expect(page.getByText('Credited').first()).toBeVisible({ timeout: 20000 })
  await expect(row.getByText(/^1,00 kr back|1 kr back/)).toBeVisible({ timeout: 20000 })
})

test('the rest can be credited, then nothing is left to pick', async ({ page }) => {
  await openBilling(page)
  const row = page.locator('.invoice-table tbody tr').filter({ has: page.locator('td.cell-pick input') }).first()
  await row.locator('td.cell-pick input').check()
  await page.getByRole('button', { name: /^Refund or credit \(1\)/ }).click()
  const dlg = page.getByRole('dialog', { name: /^(Credit|Refund) invoice / })
  const confirm = dlg.getByRole('button', { name: /^Credit / })
  await confirm.click()
  await expect(dlg).toBeHidden({ timeout: 40000 })
  await page.reload()
  await page.waitForTimeout(1500)
  await expect(pickBoxes(page), 'a fully credited invoice cannot be picked again').toHaveCount(0)
})
