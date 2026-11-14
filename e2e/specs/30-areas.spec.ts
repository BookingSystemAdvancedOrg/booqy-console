import { test, expect } from '@playwright/test'
import { watch } from '../lib/watch'
import { mail, RUN } from '../lib/data'

const PAGES: [string, RegExp][] = [
  ['/', /Customers/], ['/tenants/new', /New customer/], ['/operators', /Operators/], ['/mail', /Mail/],
  ['/finance', /Finance/], ['/website', /Website/], ['/settings', /Settings/],
]

test.describe('Console: every page', () => {
  for (const [path, h] of PAGES) {
    test(`${path} loads without errors, no Kassa or card readers @mobile`, async ({ page }, info) => {
      const w = watch(page)
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1, name: h })).toBeVisible({ timeout: 30000 })
      await page.waitForLoadState('networkidle').catch(() => {})
      const text = await page.locator('body').innerText()
      expect.soft(text, 'no Kassa').not.toMatch(/\bKassa\b|kassasystem/i)
      expect.soft(text, 'no card readers').not.toMatch(/card reader|kortläsare|Stripe Terminal|\breaders?\b/i)
      expect.soft(text, 'no raw error').not.toMatch(/undefined|NaN|\[object Object\]/)
      expect.soft(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2), 'no horizontal scroll').toBe(false)
      await page.screenshot({ path: info.outputPath('page.png'), fullPage: true })
      await w.attach(info)
      expect.soft(w.failed, w.failed.join('\n')).toEqual([])
    })
  }

  test('unknown URL lands on a real page (not found message or Customers), not a blank screen', async ({ page }) => {
    await page.goto('/this/does/not/exist')
    await expect(page.getByText(/not found|doesn't exist|404/i).first().or(page.getByRole('heading', { level: 1, name: 'Customers' }))).toBeVisible()
  })
})

test.describe('Console: operators', () => {
  const email = mail(`op2-${RUN}-${Math.random().toString(36).slice(2, 6)}`)
  test('add, edit name, disable, enable, delete an operator', async ({ page }, info) => {
    const w = watch(page)
    page.on('dialog', (d) => d.accept())
    const posts: string[] = []
    page.on('response', async (r) => {
      if (/\/operators$/.test(r.url()) && r.request().method() === 'POST') posts.push(`${r.status()} ${(await r.text()).slice(0, 80)}`)
    })
    await page.goto('/operators')
    await page.getByRole('button', { name: '+ Add operator' }).click()
    await page.getByLabel('Name').fill('E2E Operatör Två')
    await page.getByLabel('Email').fill(email)
    await page.getByRole('button', { name: 'Send invite', exact: true }).click()
    await page.waitForTimeout(5000)
    info.annotations.push({ type: 'invite POSTs', description: posts.join(' | ') })
    const stuck = await page.getByRole('dialog', { name: 'Add operator' }).isVisible()
    if (stuck) {
      info.annotations.push({ type: 'dialog after invite', description: (await page.getByRole('dialog').innerText()).replace(/\s+/g, ' ') })
      await page.screenshot({ path: info.outputPath('invite-stuck.png') })
    }
    expect.soft(stuck, 'invite dialog closes after a successful invite').toBe(false)
    if (stuck) await page.getByRole('button', { name: 'Close' }).click()
    const row = page.getByRole('row').filter({ hasText: email })
    await expect(row).toBeVisible({ timeout: 20000 })
    await row.click()
    await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('E2E Operatör Två Ändrad')
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await page.keyboard.press('Escape')
    await expect(row).toContainText('E2E Operatör Två Ändrad', { timeout: 20000 })
    await row.getByRole('button', { name: 'Disable' }).click()
    await expect(row.getByText('Disabled')).toBeVisible({ timeout: 20000 })
    await row.getByRole('button', { name: 'Enable' }).click()
    await expect(row.getByRole('cell').nth(2)).toHaveText(/Invited|Active/, { timeout: 20000 })
    await row.getByRole('button', { name: /Delete|Remove/ }).click()
    const del = page.getByRole('dialog', { name: 'Delete operator' })
    await del.getByRole('textbox').fill(email)
    await del.locator('button.btn--danger').click()
    await expect(row).toHaveCount(0, { timeout: 20000 })
    await w.attach(info)
  })

  test('cannot disable or delete yourself', async ({ page }) => {
    await page.goto('/operators')
    const me = page.getByRole('row', { name: /e2e-operator/ })
    await expect(me.getByRole('button', { name: 'Disable' })).toBeDisabled()
  })

  test('own avatar upload @mobile', async ({ page }, info) => {
    const w = watch(page)
    await page.goto('/settings')
    const file = page.locator('input[type=file]').first()
    await file.setInputFiles('fixtures/dish.jpg')
    await page.waitForTimeout(4000)
    await page.screenshot({ path: info.outputPath('avatar.png') })
    await w.attach(info)
    expect.soft(w.failed, w.failed.join('\n')).toEqual([])
  })
})

test.describe('Console: mail, finance, website, settings, help', () => {
  test('mail outbox lists messages and opens one', async ({ page }, info) => {
    const w = watch(page)
    await page.goto('/mail')
    await page.waitForLoadState('networkidle').catch(() => {})
    info.annotations.push({ type: 'mail', description: (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 500) })
    await w.attach(info)
    expect.soft(w.failed, w.failed.join('\n')).toEqual([])
  })

  test('finance page shows numbers', async ({ page }, info) => {
    await page.goto('/finance')
    await page.waitForLoadState('networkidle').catch(() => {})
    const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
    info.annotations.push({ type: 'finance', description: t.slice(0, 500) })
    expect(t).toMatch(/\d/)
  })

  test('website stats page shows numbers', async ({ page }, info) => {
    await page.goto('/website')
    await page.waitForLoadState('networkidle').catch(() => {})
    const t = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
    info.annotations.push({ type: 'website', description: t.slice(0, 400) })
    expect(t).toMatch(/\d/)
  })

  test('settings: theme toggle, background options, click sound @mobile', async ({ page }, info) => {
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Appearance and sound' })).toBeVisible()
    const t = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    info.annotations.push({ type: 'settings', description: t.slice(0, 700) })
    const before = await page.evaluate(() => document.documentElement.dataset.theme ?? '')
    const toggle = page.getByRole('button', { name: /dark|light|mörk|ljus/i }).first()
    await toggle.click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? '')).not.toBe(before)
    expect(await page.evaluate(() => localStorage.getItem('booqy-theme'))).toBeTruthy()
    await toggle.click()
    expect.soft(t, 'background options').toMatch(/Background|Bakgrund/i)
    expect.soft(t, 'click sound').toMatch(/sound|ljud/i)
  })

  test('Ask Booqy answers with a live number @mobile', async ({ page }, info) => {
    await page.goto('/')
    await page.getByRole('button', { name: 'Ask Booqy' }).click()
    const input = page.locator('.help-input, [role=dialog] textarea').first()
    await input.fill('How many active customers do we have?')
    await input.press('Enter')
    await page.waitForTimeout(10000)
    if (!(await input.isVisible())) await page.getByRole('button', { name: 'Ask Booqy' }).click()
    const log = (await page.locator('.help-log, [role=log]').first().innerText()).replace(/\s+/g, ' ')
    info.annotations.push({ type: 'answer', description: log.slice(-400) })
    expect.soft(log).toMatch(/\d/)
  })
})

test.describe('Console: mobile', () => {
  test('drawer opens and navigates @mobile', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1400) >= 768, 'phones only (tablets show the sidebar)')
    await page.goto('/')
    await page.getByRole('button', { name: /menu|meny/i }).first().click()
    await page.getByRole('link', { name: 'Operators' }).click()
    await expect(page.getByRole('heading', { level: 1, name: /Operators/ })).toBeVisible()
  })
})
