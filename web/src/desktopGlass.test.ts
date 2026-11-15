import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopGlassMode, installDesktopGlass } from './desktopGlass'

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'

describe('desktopGlassMode', () => {
  it('reads the mode the desktop shell puts in the user agent', () => {
    expect(desktopGlassMode(`${CHROME} BooqyDesktop/1.1.0 BooqyGlass/vibrancy`)).toBe('vibrancy')
    expect(desktopGlassMode(`${CHROME} BooqyDesktop/1.1.0 BooqyGlass/acrylic`)).toBe('acrylic')
    expect(desktopGlassMode(`${CHROME} BooqyDesktop/1.1.0 BooqyGlass/tint`)).toBe('tint')
  })

  it('stays solid in a browser, in an old shell and when the shell turned glass off', () => {
    expect(desktopGlassMode(CHROME)).toBeNull()
    expect(desktopGlassMode(`${CHROME} BooqyDesktop/1.0.0`)).toBeNull()
    expect(desktopGlassMode(`${CHROME} BooqyDesktop/1.1.0 BooqyGlass/none`)).toBeNull()
  })
})

describe('installDesktopGlass', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.documentElement.classList.remove('is-desktop-glass')
    delete document.documentElement.dataset.desktopGlass
  })

  it('marks <html> inside the desktop shell', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${CHROME} BooqyDesktop/1.1.0 BooqyGlass/vibrancy`)
    expect(installDesktopGlass()).toBe('vibrancy')
    expect(document.documentElement.classList.contains('is-desktop-glass')).toBe(true)
    expect(document.documentElement.dataset.desktopGlass).toBe('vibrancy')
  })

  it('leaves <html> alone in a browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(CHROME)
    expect(installDesktopGlass()).toBeNull()
    expect(document.documentElement.classList.contains('is-desktop-glass')).toBe(false)
  })
})
