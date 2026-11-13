import { describe, expect, it } from 'vitest'
import { desktopAppVersion, desktopFiles, detectDesktopOs, downloadsBase } from './desktopDownloads'

const nav = (userAgent: string, platform: string, maxTouchPoints = 0) =>
  ({ userAgent, platform, maxTouchPoints }) as unknown as Navigator

describe('desktopDownloads', () => {
  it('picks the downloads site for the environment', () => {
    expect(downloadsBase('restaurang.dev.booqy.se')).toBe('https://dev.booqy.se/downloads')
    expect(downloadsBase('admin.dev.booqy.se')).toBe('https://dev.booqy.se/downloads')
    expect(downloadsBase('restaurang.booqy.se')).toBe('https://booqy.se/downloads')
    expect(downloadsBase('admin.booqy.se')).toBe('https://booqy.se/downloads')
    expect(downloadsBase('localhost')).toBe('https://dev.booqy.se/downloads')
  })

  it('builds the stable latest links', () => {
    const files = desktopFiles('admin', 'Booqy-Admin', 'https://booqy.se/downloads')
    expect(files.find((f) => f.os === 'win')?.url).toBe('https://booqy.se/downloads/admin/latest/Booqy-Admin-Setup.exe')
    expect(files.find((f) => f.os === 'mac-arm64')?.url).toBe('https://booqy.se/downloads/admin/latest/Booqy-Admin-mac-arm64.dmg')
  })

  it('detects the computer, and nothing on phones', async () => {
    expect(await detectDesktopOs(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32'))).toBe('win')
    expect(await detectDesktopOs(nav('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64'))).toBe('linux')
    expect(await detectDesktopOs(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'iPhone', 5))).toBeNull()
    expect(await detectDesktopOs(nav('Mozilla/5.0 (Macintosh)', 'MacIntel', 5))).toBeNull() // iPad
    expect(await detectDesktopOs(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel'))).toMatch(/^mac-/)
  })

  it('reads the desktop app version from the user agent', () => {
    expect(desktopAppVersion('Mozilla/5.0 Chrome/140 BooqyDesktop/1.2.0 BooqyGlass/vibrancy')).toBe('1.2.0')
    expect(desktopAppVersion('Mozilla/5.0 Chrome/140')).toBeNull()
  })
})
