import { test, expect, type Page } from '@playwright/test'
import { VIEWPORTS, CROSS_BROWSER, layoutAudit, fullAudit, axeIssues, assertNoIssues, record, setTheme, STABLE_CSS, type Issue } from '../lib/ui-audit'
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
      // The Overview tab has no dialog: the old /Edit|Suspend/ match picked the
      // "Suspend or offboard" tab or the inline Company edit. Locations has one.
      const locations = page.getByRole('button', { name: /^Locations/ }).first()
      if (await locations.count()) { await locations.click(); await page.waitForTimeout(300) }
      const btn = page.getByRole('button', { name: /Add location/i }).first()
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

/** The Booqy dropdown (never the system menu): phone sheet, tablet and desktop popover, both themes, Chromium and WebKit. */
for (const vp of VIEWPORTS.filter((v) => ['390', '820p', '1440'].includes(v.name))) {
  for (const theme of ['light', 'dark'] as const) {
    const phone = vp.kind === 'phone'
    const tag = CROSS_BROWSER.includes(vp.name) ? ' @x' : ''
    test(`dropdown ${vp.name} ${theme}${tag}`, async ({ page }, info) => {
      await open(page, '/finance', vp, theme)
      const issues: Issue[] = []
      const trigger = page.getByRole('combobox', { name: 'Billing period' })
      await trigger.scrollIntoViewIfNeeded()
      await trigger.click()
      const list = page.getByRole('listbox')
      await expect(list).toBeVisible()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      if (await page.locator('select').count()) issues.push({ kind: 'native-select', severity: 'high', message: 'A native <select> is still on the page' })
      const lb = await list.boundingBox(), tb = await trigger.boundingBox()
      if (!lb || lb.x < -1 || lb.y < -1 || lb.x + lb.width > vp.width + 1 || lb.y + lb.height > vp.height + 1)
        issues.push({ kind: 'dropdown-bounds', severity: 'high', message: `List outside the window: ${JSON.stringify(lb)}` })
      const option = page.getByRole('option').first()
      const ob = await option.boundingBox()
      if (phone) {
        if (!(await list.evaluate((el) => el.classList.contains('select-list--sheet')))) issues.push({ kind: 'dropdown-sheet', severity: 'high', message: 'No bottom sheet on a phone' })
        if (lb && Math.abs(lb.y + lb.height - vp.height) > 1) issues.push({ kind: 'dropdown-sheet', severity: 'medium', message: 'The sheet does not sit on the bottom edge' })
        if (!ob || ob.height < 47.5) issues.push({ kind: 'dropdown-rows', severity: 'medium', message: `Phone rows under 48 px: ${ob?.height}` })
      } else if (lb && tb && !(lb.y >= tb.y + tb.height - 1 || lb.y + lb.height <= tb.y + 1)) {
        issues.push({ kind: 'dropdown-anchor', severity: 'high', message: 'The list covers its trigger' })
      }
      const selected = page.locator('[role=option][aria-selected=true]')
      if ((await selected.count()) !== 1 || !(await selected.locator('svg').count())) issues.push({ kind: 'dropdown-check', severity: 'medium', message: 'The chosen option has no check mark' })
      issues.push(...(await axeIssues(page)))
      await page.screenshot({ path: info.outputPath('dropdown-open.png') })
      const before = await trigger.getAttribute('aria-activedescendant')
      await page.keyboard.press('ArrowDown')
      if ((await trigger.getAttribute('aria-activedescendant')) === before) issues.push({ kind: 'dropdown-keys', severity: 'high', message: 'ArrowDown does not move the active option' })
      await page.keyboard.press('Escape')
      await expect(list).toBeHidden()
      await expect(trigger).toBeFocused()
      const was = await trigger.textContent()
      await page.keyboard.press('Enter')
      await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
      await expect(list).toBeHidden()
      if ((await trigger.textContent()) === was) issues.push({ kind: 'dropdown-keys', severity: 'high', message: 'Enter did not pick the next period' })
      record(info, 'console', 'interaction:dropdown', vp.name, theme, issues)
      assertNoIssues(issues)
    })
  }
}

/** Customers at 320: a long status in the pill never crushes the search, and
 *  Refresh (a round icon) sits on the same row as New customer. */
for (const theme of ['light', 'dark'] as const) {
  test(`customers toolbar 320 ${theme}`, async ({ page }, info) => {
    await open(page, '/', VIEWPORTS.find((v) => v.name === '320')!, theme)
    const refresh = page.getByRole('button', { name: 'Refresh' })
    const add = page.getByRole('link', { name: /New customer/ })
    const [r, a] = [await refresh.boundingBox(), await add.boundingBox()]
    expect(r!.width).toBeGreaterThanOrEqual(44)
    expect(r!.height).toBeGreaterThanOrEqual(44)
    expect(Math.abs(r!.y + r!.height / 2 - (a!.y + a!.height / 2))).toBeLessThan(2)
    await page.getByRole('combobox', { name: 'Status filter' }).click()
    await page.getByRole('option', { name: /^Data deleted/ }).click()
    const search = await page.getByLabel('Search customers').boundingBox()
    const pill = await page.getByRole('combobox', { name: 'Status filter' }).boundingBox()
    expect(search!.width).toBeGreaterThanOrEqual(120)
    expect(Math.abs(search!.y - pill!.y)).toBeLessThan(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await page.screenshot({ path: info.outputPath('toolbar-320.png') })
  })
}
