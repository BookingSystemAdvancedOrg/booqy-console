import { expect, type Page } from '@playwright/test'
import { env, optEnv, saveEnv } from './env'
import { freshTotp, totp } from './totp'

let lastCode = ''
/** Cognito refuses a TOTP code used twice, so wait for the next window if needed. */
async function nextCode(secret: string): Promise<string> {
  let code = await freshTotp(secret)
  while (code === lastCode) {
    await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 500))
    code = totp(secret)
  }
  lastCode = code
  return code
}

/** Operator sign-in with email, password and authenticator code. Sets up TOTP on first run. */
export async function operatorLogin(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(env('E2E_OPERATOR_EMAIL'))
  await page.getByLabel('Password', { exact: true }).fill(env('E2E_OPERATOR_PASSWORD'))
  await page.locator('.auth__submit').click()
  const setup = page.getByRole('heading', { name: 'Set up two-step sign-in' })
  const code = page.getByLabel('6-digit code')
  await expect(code.or(page.locator('.notice--error'))).toBeVisible({ timeout: 20000 })
  if (await setup.isVisible()) {
    const secret = (await page.locator('.auth code.mono').textContent())!.trim()
    saveEnv('E2E_OPERATOR_TOTP_SECRET', secret)
    await code.fill(await nextCode(secret))
  } else {
    await code.fill(await nextCode(env('E2E_OPERATOR_TOTP_SECRET')))
  }
  await page.locator('.auth__submit').click()
  await expect(page.locator('.auth')).toHaveCount(0, { timeout: 20000 })
}

export const hasTotp = () => Boolean(optEnv('E2E_OPERATOR_TOTP_SECRET'))
