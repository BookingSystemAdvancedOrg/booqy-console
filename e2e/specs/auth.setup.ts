import { test as setup, expect } from '@playwright/test'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { operatorLogin } from '../lib/login'

const file = '.auth/operator.json'

setup('operator signs in (TOTP) and saves the session', async ({ page }) => {
  // Reuse a session younger than 12 hours: TOTP codes are single use.
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 12 * 3600_000) return
  mkdirSync('.auth', { recursive: true })
  await operatorLogin(page)
  await expect(page.locator('nav, .sidebar, header').first()).toBeVisible()
  await page.context().storageState({ path: file })
})
