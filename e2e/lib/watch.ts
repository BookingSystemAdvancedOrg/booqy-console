import type { Page, TestInfo } from '@playwright/test'

/**
 * Collects console errors, page errors and failing network calls during a
 * test and attaches them to the report, so a FAIL comes with evidence.
 */
export function watch(page: Page) {
  const consoleErrors: string[] = []
  const failed: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400))
  })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 400)}`))
  page.on('response', (r) => {
    const u = r.url()
    if (r.status() >= 400 && !/google|stripe\.com\/b|sentry|favicon/.test(u)) {
      failed.push(`${r.status()} ${r.request().method()} ${u.replace(/\?.*$/, '')}`)
    }
  })
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? ''
    if (!/ERR_ABORTED|cancelled|NS_BINDING_ABORTED/i.test(f)) failed.push(`FAILED ${r.method()} ${r.url().replace(/\?.*$/, '')} ${f}`)
  })
  return {
    consoleErrors,
    failed,
    async attach(info: TestInfo) {
      if (consoleErrors.length) await info.attach('console-errors', { body: consoleErrors.join('\n'), contentType: 'text/plain' })
      if (failed.length) await info.attach('failed-requests', { body: failed.join('\n'), contentType: 'text/plain' })
    },
  }
}
