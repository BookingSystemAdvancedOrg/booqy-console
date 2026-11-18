import { test, expect, type Page } from '@playwright/test'
import { watch } from '../lib/watch'
import { env } from '../lib/env'

/**
 * Features added 2026-11-16/17: the stacked Features list with the "About"
 * popover, Settings as a tree, no Site builder, the DEV badge on the icons.
 * Read-only: nothing here saves.
 */

const WIDTHS = [375, 768, 1024, 1280, 1920]

async function noSideScroll(page: Page, where: string) {
  const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(o, `${where}: sideways scroll`).toBeLessThanOrEqual(1)
}

test.describe('Console: Plan features list', () => {
  for (const width of WIDTHS) {
    test(`one-line descriptions, About popover never ticks the box, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 800 ? 812 : 900 })
      await page.goto(`/tenants/${env('E2E_TENANT_ID')}`)
      await page.locator('main nav').getByRole('button', { name: /^Plan/ }).click()
      const rows = page.locator('.feats .feat')
      await expect(rows.first()).toBeVisible()
      expect(await rows.count()).toBeGreaterThan(8)
      // stacked: one column, every row with a description line
      const lines = await rows.locator('.feat__line').count()
      expect(lines, 'a description under every feature').toBe(await rows.count())
      const box = page.locator('.feats .feat').first()
      const cb = box.locator('input[type=checkbox]')
      const before = await cb.isChecked()
      await box.getByRole('button', { name: /^About / }).click()
      const pop = page.getByRole('dialog').filter({ has: page.locator('text=/./') }).last()
      await expect(pop).toBeVisible()
      expect(await cb.isChecked(), 'opening About must not change the checkbox').toBe(before)
      const r = await pop.boundingBox()
      expect(r!.x, 'popover inside the screen (left)').toBeGreaterThanOrEqual(-1)
      expect(r!.x + r!.width, 'popover inside the screen (right)').toBeLessThanOrEqual(width + 1)
      if (width <= 640) {
        const vh = page.viewportSize()!.height
        expect(r!.y + r!.height, 'phone: bottom sheet reaches the bottom').toBeGreaterThan(vh - 40)
      }
      await noSideScroll(page, `Plan ${width}`)
      await page.keyboard.press('Escape')
      await expect(pop).toBeHidden()
      expect(await cb.isChecked(), 'closing About must not change the checkbox').toBe(before)
    })
  }
})

test.describe('Console: Settings tree', () => {
  test('field shows the trees, a branch opens by link, old links lead on', async ({ page }) => {
    const w = watch(page)
    await page.goto('/settings')
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible()
    for (const t of ['You', 'Platform']) await expect(page.getByText(t, { exact: true }).filter({ visible: true }).first()).toBeVisible()
    await page.goto('/settings#appearance')
    await expect(page.getByText(/Light or dark|Click sound/i).first()).toBeVisible()
    await page.goto('/settings#phone-agent')
    await expect(page.getByText(/Max minutes|kill switch/i).first()).toBeVisible()
    await page.goto('/settings#profile')
    await expect(page).toHaveURL(/\/profile/)
    await page.goto('/settings#mail-brand')
    await expect(page).toHaveURL(/\/mail\?tab=brand-template/)
    await w.attach(test.info())
  })

  test('search finds a setting and lights it up', async ({ page }) => {
    await page.goto('/settings')
    await page.getByPlaceholder(/Search settings/i).fill('kill switch')
    const hit = page.getByRole('option').or(page.getByRole('button', { name: /kill switch/i })).first()
    await expect(hit).toBeVisible()
    await hit.click()
    await expect(page.getByText(/kill switch/i).first()).toBeVisible()
  })

  for (const width of [375, 1280]) {
    test(`no sideways scroll, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 })
      for (const h of ['', '#appearance', '#meta-ads']) {
        await page.goto('/settings' + h)
        await page.waitForTimeout(800)
        await noSideScroll(page, `settings${h} ${width}`)
      }
    })
  }
})

test.describe('Console: no Site builder, DEV badge', () => {
  test('Site builder is not offered anywhere in the console', async ({ page }) => {
    for (const path of ['/', `/tenants/${env('E2E_TENANT_ID')}`, '/settings', '/website']) {
      await page.goto(path)
      await page.waitForTimeout(1200)
      const text = await page.locator('body').innerText()
      expect(text, `${path} mentions Site builder`).not.toMatch(/site builder|webbplatsbyggare|bordsbest|QR (code )?at the table/i)
    }
    await page.goto(`/tenants/${env('E2E_TENANT_ID')}`)
    await page.locator('main nav').getByRole('button', { name: /^Plan/ }).click()
    await expect(page.locator('.feats')).not.toContainText(/site builder/i)
  })

  test('dev build carries the DEV badge, favicon and installable icons', async ({ page, request }) => {
    await page.goto('/')
    await expect(page.locator('.env')).toHaveText(/dev/i)
    const icons = await page.locator('link[rel=icon], link[rel=apple-touch-icon], link[rel=manifest]').evaluateAll(
      (els) => els.map((e) => (e as HTMLLinkElement).href))
    expect(icons.join(' ')).toMatch(/favicon-dev/)
    expect(icons.join(' ')).toMatch(/dev/)
    const manifestUrl = icons.find((h) => /webmanifest/.test(h))!
    const manifest = await (await request.get(manifestUrl)).json()
    expect(manifest.name).toMatch(/dev/i)
    for (const ic of manifest.icons) {
      const res = await request.get(new URL(ic.src, manifestUrl).toString())
      expect(res.status(), ic.src).toBe(200)
      expect(ic.src, 'installed icon is the DEV one').toMatch(/dev/)
    }
  })
})
