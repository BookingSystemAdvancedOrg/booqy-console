import type { Page, TestInfo } from '@playwright/test'

/**
 * Collects console errors, page errors and failing network calls during a
 * test and attaches them to the report, so a FAIL comes with evidence.
 */
const HARNESS_NOISE = /^Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/

export function watch(page: Page) {
  const consoleErrors: string[] = []
  const failed: string[] = []
  page.on('console', (m) => {
    // Playwright's own trace snapshotter injects a script into every frame; the
    // email previews are sandboxed iframes without allow-scripts (on purpose), so
    // the browser blocks that injected script and logs this. The page itself runs
    // no script there and users never see it, so it is not an app error.
    if (m.type() === 'error' && !HARNESS_NOISE.test(m.text())) consoleErrors.push(m.text().slice(0, 400))
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
