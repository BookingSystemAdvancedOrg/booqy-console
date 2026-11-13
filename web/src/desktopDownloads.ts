/**
 * Skrivbordsappens nedladdningar (desktop/ i det här repot, publiceras av
 * .github/workflows/desktop-installers.yml till https://<domän>/downloads/).
 * Länkarna är stabila (latest/), så sidan behöver inte hämta något: bara
 * vanliga länkar, som CSP:n (connect-src 'self') inte påverkar.
 *
 * Rekommendationen ("Rekommenderas för din dator") kommer från recommend(),
 * en ren funktion över signalerna som readSignals() samlar in. Är något
 * blockerat, maskerat eller motsägelsefullt blir svaret null: då visas bara
 * hela listan. Vi gissar aldrig.
 *
 * Samma fil i admin-front-end/src/shared; booqy.se har samma regler i
 * site/assets/download.js. Ändra alla tillsammans.
 */

export type DesktopOs = 'mac-arm64' | 'mac-x64' | 'win' | 'linux' | 'linux-appimage'

export type DesktopFile = { os: DesktopOs; url: string }

/** dev.booqy.se för restaurang.dev.booqy.se, booqy.se för restaurang.booqy.se. */
export function downloadsBase(hostname: string = location.hostname): string {
  const prod =
    hostname === 'booqy.se' ||
    (hostname.endsWith('.booqy.se') && !hostname.endsWith('.dev.booqy.se') && hostname !== 'dev.booqy.se')
  return `https://${prod ? 'booqy.se' : 'dev.booqy.se'}/downloads`
}

/** Filerna för en app, t.ex. ('admin', 'Booqy-Admin'), i listans ordning. */
export function desktopFiles(slug: string, stable: string, base = downloadsBase()): DesktopFile[] {
  const u = (f: string) => `${base}/${slug}/latest/${f}`
  return [
    { os: 'mac-arm64', url: u(`${stable}-mac-arm64.dmg`) },
    { os: 'mac-x64', url: u(`${stable}-mac-x64.dmg`) },
    { os: 'win', url: u(`${stable}-Setup.exe`) },
    { os: 'linux-appimage', url: u(`${stable}.AppImage`) },
    { os: 'linux', url: u(`${stable}.deb`) },
  ]
}

/** Det vi vet om datorn. Saknade värden är null (blockerat eller okänt). */
export type Signals = {
  ua: string
  /** userAgentData.platform eller navigator.platform */
  platform: string
  maxTouchPoints: number
  /** userAgentData: "arm" eller "x86" */
  architecture: string | null
  /** userAgentData: "15.0.0" (Windows 11 är 13 och uppåt) */
  platformVersion: string | null
  /** WebGL UNMASKED_RENDERER_WEBGL, t.ex. "Apple M2" eller "Intel(R) Iris(TM)" */
  webglRenderer: string | null
}

export type Recommendation = { os: DesktopOs; windows?: 10 | 11 }

/** Telefon eller surfplatta (iPadOS säger "Macintosh" men har pekskärm). */
export function isPhoneOrTablet(s: Pick<Signals, 'ua' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(s.ua)) return true
  return /Mac/i.test(s.platform) && s.maxTouchPoints > 1
}

/** Firefox resist-fingerprinting och liknande visar "Mozilla" i stället för grafikkortet. */
function rendererMasked(r: string | null): boolean {
  return r !== null && /^(mozilla|webkit webgl|generic renderer|)$/i.test(r.trim())
}

/** Ren funktion: rätt fil för datorn, eller null när vi inte vet säkert. */
export function recommend(s: Signals): Recommendation | null {
  if (isPhoneOrTablet(s)) return null
  if (rendererMasked(s.webglRenderer)) return null

  const ua = s.ua
  const isCrOs = /CrOS/.test(ua)
  const win = /Win/i.test(s.platform) || /Windows NT/.test(ua)
  const mac = /Mac/i.test(s.platform) || /Macintosh/.test(ua)
  const linux = !isCrOs && (/Linux/i.test(s.platform) || /X11|Linux/.test(ua))
  // Exakt ett system, annars motsäger signalerna varandra.
  if (isCrOs || Number(win) + Number(mac) + Number(linux) !== 1) return null

  if (win) {
    const major = s.platformVersion ? Number.parseInt(s.platformVersion, 10) : Number.NaN
    if (Number.isNaN(major)) return { os: 'win' }
    return { os: 'win', windows: major >= 13 ? 11 : 10 }
  }

  if (mac) {
    if (s.architecture === 'arm') return { os: 'mac-arm64' }
    if (s.architecture === 'x86') return { os: 'mac-x64' }
    const r = s.webglRenderer ?? ''
    if (/Apple (M\d|GPU)/i.test(r)) return { os: 'mac-arm64' }
    if (/Intel|AMD|Radeon/i.test(r)) return { os: 'mac-x64' }
    return null
  }

  return /Ubuntu|Debian/i.test(ua) ? { os: 'linux' } : { os: 'linux-appimage' }
}

type UaData = {
  platform?: string
  getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string; platformVersion?: string }>
}

function readWebglRenderer(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    if (!gl) return null
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null
  } catch {
    return null
  }
}

/** Samlar signalerna i webbläsaren (asynkront: userAgentData-hintar). */
export async function readSignals(nav: Navigator = navigator): Promise<Signals> {
  const data = (nav as Navigator & { userAgentData?: UaData }).userAgentData
  let architecture: string | null = null
  let platformVersion: string | null = null
  if (data?.getHighEntropyValues) {
    try {
      const v = await data.getHighEntropyValues(['architecture', 'platformVersion'])
      architecture = v.architecture || null
      platformVersion = v.platformVersion || null
    } catch {
      /* blockerat: lämnas null */
    }
  }
  return {
    ua: nav.userAgent || '',
    platform: data?.platform || nav.platform || '',
    maxTouchPoints: nav.maxTouchPoints || 0,
    architecture,
    platformVersion,
    webglRenderer: readWebglRenderer(),
  }
}

/** "1.2.0" när sidan visas i skrivbordsappen (skalet lägger BooqyDesktop/<v> i user agent). */
export function desktopAppVersion(ua: string = navigator.userAgent): string | null {
  return ua.match(/BooqyDesktop\/([\d.]+)/)?.[1] ?? null
}

/** Menyvalet "Ladda ner appen": bara i en webbläsare på en dator. */
export function showDownloadNav(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean {
  if (desktopAppVersion(nav.userAgent)) return false
  return !isPhoneOrTablet({ ua: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints })
}
