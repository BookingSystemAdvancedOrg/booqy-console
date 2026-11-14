import { createHmac } from 'node:crypto'

function base32(s: string): Buffer {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += a.indexOf(c).toString(2).padStart(5, '0')
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238 TOTP, 30 s, 6 digits. offset = steps ahead. */
export function totp(secret: string, offset = 0, now = Date.now()): string {
  const counter = Math.floor(now / 30000) + offset
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', base32(secret)).update(buf).digest()
  const o = h[h.length - 1] & 0xf
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]
  return String(n % 1_000_000).padStart(6, '0')
}

/** Wait until a fresh code window, so the code isn't about to expire. */
export async function freshTotp(secret: string): Promise<string> {
  const left = 30000 - (Date.now() % 30000)
  if (left < 5000) await new Promise((r) => setTimeout(r, left + 500))
  return totp(secret)
}
