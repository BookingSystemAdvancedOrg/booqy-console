import { afterEach, describe, expect, it } from 'vitest'
import { rememberDesktopHint, shouldShowDesktopHint } from './desktopHint'

const setUa = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })

afterEach(() => {
  localStorage.clear()
})

describe('desktop app hint', () => {
  it('never shows inside the desktop app, also without glass', () => {
    setUa('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 BooqyDesktop/1.3.0 BooqyGlass/none')
    expect(shouldShowDesktopHint()).toBe(false)
  })

  it('shows once in a desktop browser', () => {
    setUa('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15')
    expect(shouldShowDesktopHint()).toBe(true)
    rememberDesktopHint()
    expect(shouldShowDesktopHint()).toBe(false)
  })
})
