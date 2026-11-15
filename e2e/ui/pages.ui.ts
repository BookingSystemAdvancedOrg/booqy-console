import { test, expect } from '@playwright/test'
import { VIEWPORTS, CROSS_BROWSER, VISUAL, fullAudit, axeIssues, focusIssues, assertNoIssues, record, setTheme, STABLE_CSS, type Issue } from '../lib/ui-audit'
import { fakeSession, stubApi } from '../lib/ui-fixtures'

/** Every console route x every screen size x light/dark. */
export const PAGES = [
  { name: 'login', path: '/', signedIn: false },
  { name: 'kunder', path: '/' },
  { name: 'ny-kund', path: '/tenants/new' },
  { name: 'kund', path: '/tenants/t1' },
  { name: 'kund-avstangd', path: '/tenants/t3' },
  { name: 'operatorer', path: '/operators' },
  { name: 'mail', path: '/mail' },
  { name: 'outbox', path: '/outbox' },
  { name: 'finance', path: '/finance' },
  { name: 'website', path: '/website' },
  { name: 'settings', path: '/settings' },
] as { name: string; path: string; signedIn?: boolean }[]

for (const pg of PAGES) {
  test.describe(pg.name, () => {
    for (const vp of VIEWPORTS) {
      for (const theme of ['light', 'dark'] as const) {
        const tag = CROSS_BROWSER.includes(vp.name) ? ' @x' : ''
        test(`${pg.name} ${vp.name} ${theme}${tag}`, async ({ page }, info) => {
          await page.setViewportSize({ width: vp.width, height: vp.height })
          await setTheme(page, theme)
          await page.clock.setFixedTime(new Date('2026-11-14T10:00:00+01:00'))
          if (pg.signedIn !== false) await fakeSession(page)
          await stubApi(page)
          await page.goto(pg.path)
          await page.waitForSelector(pg.signedIn === false ? '.auth' : 'h1', { timeout: 20000 })
          await page.waitForLoadState('networkidle').catch(() => {})
          await page.waitForTimeout(500)
          await page.addStyleTag({ content: STABLE_CSS })
          const issues: Issue[] = []
          const dataTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
          if (dataTheme && dataTheme !== theme) issues.push({ kind: 'theme', severity: 'high', message: `data-theme is ${dataTheme}, expected ${theme}` })
          issues.push(...(await fullAudit(page, { phone: vp.kind === 'phone', helpSelector: '.help-launcher' })))
          issues.push(...(await axeIssues(page)))
          if (info.project.name === 'chromium') issues.push(...(await focusIssues(page)))
          let shot: string | undefined
          if (info.project.name === 'chromium' && VISUAL.includes(vp.name)) {
            try {
              await expect(page).toHaveScreenshot(`${pg.name}-${vp.name}-${theme}.png`, { mask: [page.locator('time, [data-dynamic], .num')] })
            } catch (e) {
              issues.push({ kind: 'visual', severity: 'medium', message: 'Differs from baseline: ' + String((e as Error).message).split('\n')[0] })
            }
            shot = 'visual'
          }
          record(info, 'console', pg.name, vp.name, theme, issues, { shot })
          assertNoIssues(issues.filter((i) => i.kind !== 'visual'))
          expect.soft(issues.filter((i) => i.kind === 'visual'), 'visual baseline').toEqual([])
        })
      }
    }
  })
}
