import { readFileSync, existsSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Test credentials come from env vars, or from a local file outside git
 * (E2E_ENV_FILE, default ../../.e2e-credentials.env = the booqy folder).
 * Never commit credentials.
 */
export const ENV_FILE = process.env.E2E_ENV_FILE ?? resolve(import.meta.dirname, '../../../.e2e-credentials.env')

function load(): Record<string, string> {
  const out: Record<string, string> = {}
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2]
    }
  }
  return out
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? load()[name] ?? fallback
  if (v === undefined) throw new Error(`Missing ${name} (set it or add it to ${ENV_FILE})`)
  return v
}

export function optEnv(name: string): string | undefined {
  return process.env[name] ?? load()[name]
}

/** Remember a generated value (TOTP secret, tenant id) for later runs. */
export function saveEnv(name: string, value: string) {
  if (load()[name] === value) return
  appendFileSync(ENV_FILE, `${name}=${value}\n`, { mode: 0o600 })
}
