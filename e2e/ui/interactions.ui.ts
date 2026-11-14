import { test, expect, type Page } from '@playwright/test'
import { VIEWPORTS, layoutAudit, fullAudit, axeIssues, assertNoIssues, record, setTheme, STABLE_CSS, type Issue } from '../lib/ui-audit'
import { fakeSession, stubApi } from '../lib/ui-fixtures'

/** Key console interactions at phone (390) and desktop (1440), light and dark. */
const SIZES = VIEWPORTS.filter((v) => ['390', '1440'].includes(v.name))

async function open(page: Page, path: string, vp: (typeof SIZES)[number], theme: 'light' | 'dark') {
  await page.setViewportSize({ width: vp.width, height: vp.height })
  await setTheme(page, theme)
  await page.clock.setFixedTime(new Date('2026-11-14T10:00:00+01:00'))
  await fakeSession(page)
  await stubApi(page)
  await page.goto(path)
  await page.waitForSelector('h1', { timeout: 20000 })
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.addStyleTag({ content: STABLE_CSS })
  await page.waitForTimeout(400)
}
const opts = (phone: boolean) => ({ phone, helpSelector: '.help-launcher' })

for (const vp of SIZES) {
  for (const theme of ['light', 'dark'] as const) {
    const phone = vp.kind === 'phone'

    if (phone) {
      test(`menu drawer ${vp.name} ${theme}`, async ({ page }, info) => {
        await open(page, '/', vp, theme)
        const issues: Issue[] = []
        const burger = page.locator('button[aria-expanded]').first()
        await burger.click()
        await page.waitForTimeout(400)
        const nav = page.locator('nav').filter({ visible: true }).first()
        const b = await nav.boundingBox()
        if (!b || b.x < -1 || b.x + b.width > vp.width + 1) issues.push({ kind: 'drawer-bounds', severity: 'high', message: `Menu outside the window: ${JSON.stringify(b)}` })
        issues.push(...(await layoutAudit(page, { ...opts(true), atBottom: false })).filter((i) => i.kind !== 'tap-target'))
        await page.screenshot({ path: info.outputPath('drawer-open.png') })
        await page.keyboard.press('Escape')
        if ((await burger.getAttribute('aria-expanded')) === 'true') await burger.click()
        await expect(burger).toHaveAttribute('aria-expanded', 'false')
        record(info, 'console', 'interaction:drawer', vp.name, theme, issues)
        assertNoIssues(issues)
      })
    }

    test(`new customer form ${vp.name} ${theme}`, async ({ page }, info) => {
      await open(page, '/tenants/new', vp, theme)
      const issues: Issue[] = [...(await fullAudit(page, opts(phone))).filter((i) => i.kind !== 'tap-target')]
      await page.screenshot({ path: info.outputPath('form.png'), fullPage: true })
      record(info, 'console', 'interaction:new-customer', vp.name, theme, issues)
      assertNoIssues(issues)
    })

    test(`dialog on customer page ${vp.name} ${theme}`, async ({ page }, info) => {
      await open(page, '/tenants/t1', vp, theme)
      const issues: Issue[] = []
      const btn = page.getByRole('button', { name: /Add location|Edit|Change plan|Suspend|Offboard|Delete/i }).first()
      if (await btn.count()) {
        await btn.click()
        await page.waitForTimeout(400)
        const dlg = page.getByRole('dialog').first()
        if (await dlg.count()) {
          const b = await dlg.boundingBox()
          if (b && b.width < vp.width - 4 && Math.abs(b.x + b.width / 2 - vp.width / 2) > 6) issues.push({ kind: 'modal-centre', severity: 'medium', message: 'Dialog is not horizontally centred' })
          issues.push(...(await layoutAudit(page, { ...opts(phone), atBottom: false })).filter((i) => i.kind !== 'tap-target'))
          issues.push(...(await axeIssues(page)))
          await page.screenshot({ path: info.outputPath('dialog.png') })
        } else issues.push({ kind: 'no-dialog', severity: 'low', message: 'Clicked a button, no dialog opened' })
      }
      record(info, 'console', 'interaction:dialog', vp.name, theme, issues)
      assertNoIssues(issues)
    })

    test(`theme toggle ${vp.name} ${theme}`, async ({ page }, info) => {
      await open(page, '/settings', vp, theme)
      const issues: Issue[] = []
      const toggle = page.locator('button.theme-toggle[data-mode]').filter({ visible: true }).first()
      if (!(await toggle.count())) issues.push({ kind: 'theme-toggle', severity: 'high', message: 'No visible theme toggle' })
      else {
        await toggle.click()
        await page.waitForTimeout(800)
        const want = theme === 'light' ? 'dark' : 'light'
        const got = await page.evaluate(() => ({ attr: document.documentElement.getAttribute('data-theme'), ls: localStorage.getItem('booqy-theme') }))
        if (got.attr !== want) issues.push({ kind: 'theme-toggle', severity: 'high', message: `data-theme is ${got.attr} after toggle, expected ${want}` })
        if (got.ls !== want) issues.push({ kind: 'theme-toggle', severity: 'medium', message: `booqy-theme is ${got.ls}, expected ${want}` })
      }
      record(info, 'console', 'interaction:theme-toggle', vp.name, theme, issues)
      assertNoIssues(issues)
    })

    test(`help assistant ${vp.name} ${theme}`, async ({ page }, info) => {
      await open(page, '/', vp, theme)
      const issues: Issue[] = []
      await page.locator('.help-launcher').click()
      const panel = page.locator('.help-panel')
      await expect(panel).toBeVisible()
      await page.waitForTimeout(400)
      const b = await panel.boundingBox()
      if (!b || b.x < -1 || b.x + b.width > vp.width + 1 || b.y < -1 || b.y + b.height > vp.height + 1) issues.push({ kind: 'help-panel-bounds', severity: 'high', message: `Help panel outside the window: ${JSON.stringify(b)}` })
      issues.push(...(await axeIssues(page)))
      await page.screenshot({ path: info.outputPath('help.png') })
      record(info, 'console', 'interaction:help-panel', vp.name, theme, issues)
      assertNoIssues(issues)
    })
  }
}
