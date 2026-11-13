/**
 * Skrivbordsappens nedladdningar (desktop/ i det här repot, publiceras av
 * .github/workflows/desktop-installers.yml till https://<domän>/downloads/).
 * Länkarna är stabila (latest/), så sidan behöver inte hämta något: bara
 * vanliga länkar, som CSP:n (connect-src 'self') inte påverkar.
 * Same file in admin-front-end/src/shared; booqy.se has site/assets/download.js.
 */

export type DesktopOs = 'mac-arm64' | 'mac-x64' | 'win' | 'linux' | 'linux-appimage'

export type DesktopFile = { os: DesktopOs; title: string; detail: string; url: string; button: string }

/** dev.booqy.se för restaurang.dev.booqy.se, booqy.se för restaurang.booqy.se. */
export function downloadsBase(hostname: string = location.hostname): string {
  const prod = hostname === 'booqy.se' || (hostname.endsWith('.booqy.se') && !hostname.endsWith('.dev.booqy.se') && hostname !== 'dev.booqy.se')
  return `https://${prod ? 'booqy.se' : 'dev.booqy.se'}/downloads`
}

/** Filerna för en app, t.ex. ('admin', 'Booqy-Admin'). */
export function desktopFiles(slug: string, stable: string, base = downloadsBase()): DesktopFile[] {
  const u = (f: string) => `${base}/${slug}/latest/${f}`
  return [
    { os: 'mac-arm64', title: 'Mac med Apple-chip', detail: 'M1 eller senare, .dmg', url: u(`${stable}-mac-arm64.dmg`), button: 'Ladda ner för Mac (Apple-chip)' },
    { os: 'mac-x64', title: 'Mac med Intel-processor', detail: '.dmg', url: u(`${stable}-mac-x64.dmg`), button: 'Ladda ner för Mac (Intel)' },
    { os: 'win', title: 'Windows 10 och 11', detail: '.exe', url: u(`${stable}-Setup.exe`), button: 'Ladda ner för Windows' },
    { os: 'linux', title: 'Linux (Ubuntu, Debian)', detail: '.deb', url: u(`${stable}.deb`), button: 'Ladda ner för Linux (.deb)' },
    { os: 'linux-appimage', title: 'Linux, övriga', detail: 'AppImage', url: u(`${stable}.AppImage`), button: 'Ladda ner AppImage' },
  ]
}

type UaData = { platform?: string; getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string }> }

/** Vilken dator? null på mobil och surfplatta (där räcker webbläsaren). */
export async function detectDesktopOs(nav: Navigator = navigator): Promise<DesktopOs | null> {
  const ua = nav.userAgent || ''
  const data = (nav as Navigator & { userAgentData?: UaData }).userAgentData
  const platform = data?.platform || nav.platform || ''
  if (/iPhone|iPad|Android/i.test(ua) || (/Mac/i.test(platform) && nav.maxTouchPoints > 1)) return null
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) {
    if (data?.getHighEntropyValues) {
      try {
        const v = await data.getHighEntropyValues(['architecture'])
        return v.architecture === 'x86' ? 'mac-x64' : 'mac-arm64'
      } catch {
        return 'mac-arm64'
      }
    }
    // Safari och Firefox: grafikkortets namn avslöjar oftast Intel.
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const ext = gl?.getExtension('WEBGL_debug_renderer_info')
      const gpu = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
      return /intel|amd|radeon/i.test(gpu) ? 'mac-x64' : 'mac-arm64'
    } catch {
      return 'mac-arm64'
    }
  }
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'win'
  if (/Linux/i.test(platform) || /Linux/i.test(ua)) return 'linux'
  return null
}

/** "1.2.0" när sidan visas i skrivbordsappen (skalet lägger BooqyDesktop/<v> i user agent). */
export function desktopAppVersion(ua: string = navigator.userAgent): string | null {
  return ua.match(/BooqyDesktop\/([\d.]+)/)?.[1] ?? null
}
