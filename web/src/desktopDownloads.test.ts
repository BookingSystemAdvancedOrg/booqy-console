import { describe, expect, it } from 'vitest'
import {
  desktopAppVersion,
  desktopFiles,
  downloadsBase,
  recommend,
  showDownloadNav,
  type Signals,
} from './desktopDownloads'

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
const MAC_CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
const MAC_SAFARI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15'
const MAC_FIREFOX_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:145.0) Gecko/20100101 Firefox/145.0'
const WIN_FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0'
const UBUNTU_FIREFOX_UA = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0'
const LINUX_CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36'
const CROS_UA = 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'

const s = (over: Partial<Signals>): Signals => ({
  ua: '',
  platform: '',
  maxTouchPoints: 0,
  architecture: null,
  platformVersion: null,
  webglRenderer: null,
  ...over,
})

describe('recommend', () => {
  it('Windows 11 from platformVersion 13 and up', () => {
    expect(recommend(s({ ua: WIN_UA, platform: 'Windows', platformVersion: '15.0.0' }))).toEqual({ os: 'win', windows: 11 })
    expect(recommend(s({ ua: WIN_UA, platform: 'Windows', platformVersion: '13.0.0' }))).toEqual({ os: 'win', windows: 11 })
  })

  it('Windows 10 below 13', () => {
    expect(recommend(s({ ua: WIN_UA, platform: 'Windows', platformVersion: '10.0.0' }))).toEqual({ os: 'win', windows: 10 })
  })

  it('Windows without hints: the exe, no version named', () => {
    expect(recommend(s({ ua: WIN_FIREFOX_UA, platform: 'Win32', webglRenderer: 'ANGLE (NVIDIA GeForce)' }))).toEqual({ os: 'win' })
  })

  it('Mac in Chromium: architecture hint', () => {
    expect(recommend(s({ ua: MAC_CHROME_UA, platform: 'macOS', architecture: 'arm' }))).toEqual({ os: 'mac-arm64' })
    expect(recommend(s({ ua: MAC_CHROME_UA, platform: 'macOS', architecture: 'x86' }))).toEqual({ os: 'mac-x64' })
  })

  it('Mac in Safari and Firefox: WebGL renderer', () => {
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel', webglRenderer: 'Apple GPU' }))).toEqual({ os: 'mac-arm64' })
    expect(recommend(s({ ua: MAC_FIREFOX_UA, platform: 'MacIntel', webglRenderer: 'Apple M2, or similar' }))).toEqual({ os: 'mac-arm64' })
    expect(recommend(s({ ua: MAC_FIREFOX_UA, platform: 'MacIntel', webglRenderer: 'Intel(R) Iris(TM) Plus Graphics' }))).toEqual({ os: 'mac-x64' })
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel', webglRenderer: 'AMD Radeon Pro 5500M' }))).toEqual({ os: 'mac-x64' })
  })

  it('Mac with no hints and no renderer: no guess', () => {
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel' }))).toBeNull()
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel', webglRenderer: 'Some Unknown GPU' }))).toBeNull()
  })

  it('Linux: .deb on Ubuntu or Debian, AppImage otherwise', () => {
    expect(recommend(s({ ua: UBUNTU_FIREFOX_UA, platform: 'Linux x86_64' }))).toEqual({ os: 'linux' })
    expect(recommend(s({ ua: LINUX_CHROME_UA, platform: 'Linux' }))).toEqual({ os: 'linux-appimage' })
  })

  it('blocked: resist-fingerprinting masks the renderer, so nothing is recommended', () => {
    // Firefox RFP on a Mac pretends to be Windows and says "Mozilla" for the GPU.
    expect(recommend(s({ ua: WIN_FIREFOX_UA, platform: 'Win32', webglRenderer: 'Mozilla' }))).toBeNull()
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel', webglRenderer: 'WebKit WebGL' }))).toBeNull()
  })

  it('blocked: no user agent and no platform', () => {
    expect(recommend(s({}))).toBeNull()
  })

  it('contradicting signals: no guess', () => {
    expect(recommend(s({ ua: MAC_CHROME_UA, platform: 'Win32' }))).toBeNull()
  })

  it('phones, tablets and Chromebooks: nothing to install', () => {
    expect(recommend(s({ ua: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 }))).toBeNull()
    expect(recommend(s({ ua: ANDROID_UA, platform: 'Linux armv8l', maxTouchPoints: 5 }))).toBeNull()
    expect(recommend(s({ ua: MAC_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 5, webglRenderer: 'Apple GPU' }))).toBeNull()
    expect(recommend(s({ ua: CROS_UA, platform: 'Linux x86_64' }))).toBeNull()
  })
})

describe('downloads and nav', () => {
  it('picks the downloads site for the environment', () => {
    expect(downloadsBase('restaurang.dev.booqy.se')).toBe('https://dev.booqy.se/downloads')
    expect(downloadsBase('admin.dev.booqy.se')).toBe('https://dev.booqy.se/downloads')
    expect(downloadsBase('restaurang.booqy.se')).toBe('https://booqy.se/downloads')
    expect(downloadsBase('admin.booqy.se')).toBe('https://booqy.se/downloads')
    expect(downloadsBase('localhost')).toBe('https://dev.booqy.se/downloads')
  })

  it('builds the stable latest links for all five files', () => {
    const files = desktopFiles('admin', 'Booqy-Admin', 'https://booqy.se/downloads')
    expect(files.map((f) => f.os)).toEqual(['mac-arm64', 'mac-x64', 'win', 'linux-appimage', 'linux'])
    expect(files.find((f) => f.os === 'win')?.url).toBe('https://booqy.se/downloads/admin/latest/Booqy-Admin-Setup.exe')
  })

  it('reads the desktop app version from the user agent', () => {
    expect(desktopAppVersion('Mozilla/5.0 Chrome/140 BooqyDesktop/1.2.0 BooqyGlass/vibrancy')).toBe('1.2.0')
    expect(desktopAppVersion(MAC_CHROME_UA)).toBeNull()
  })

  it('shows the menu item only in a desktop browser', () => {
    expect(showDownloadNav({ userAgent: MAC_CHROME_UA, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(true)
    expect(showDownloadNav({ userAgent: `${MAC_CHROME_UA} BooqyDesktop/1.2.0`, platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false)
    expect(showDownloadNav({ userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5 })).toBe(false)
    expect(showDownloadNav({ userAgent: MAC_SAFARI_UA, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(false)
  })
})
