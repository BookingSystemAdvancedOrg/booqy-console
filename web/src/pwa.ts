import { useEffect, useState } from 'react'
import { isDesktopShell, isPhoneOrTablet } from './desktopDownloads'

/**
 * Appen på telefonen: Booqy installeras som webbapp (PWA) via "Lägg till på
 * hemskärmen" (iPhone, iPad) eller Chromes installationsknapp (Android).
 * public/app.v1.webmanifest beskriver appen, public/sw.js ger ett skal som
 * startar utan nät. Inget av det här körs i skrivbordsappen.
 *
 * Samma fil i admin-front-end/src/shared. Ändra båda tillsammans.
 */

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

let deferred: InstallPrompt | null = null
let installedNow = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())

/** Körs i den installerade appen (fristående fönster, inte i webbläsaren)? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return iosStandalone || !!window.matchMedia?.('(display-mode: standalone)').matches
}

/** iPhone eller iPad (iPadOS säger "Macintosh" men har pekskärm). */
export function isIos(ua: string, platform: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && maxTouchPoints > 1)
}

export type PhoneKind = 'ios' | 'android' | 'other'

export function phoneKind(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): PhoneKind {
  if (isIos(nav.userAgent, nav.platform, nav.maxTouchPoints)) return 'ios'
  if (/Android/i.test(nav.userAgent)) return 'android'
  return 'other'
}

/** Menyvalet "Installera appen": telefon eller surfplatta, i webbläsaren, inte redan installerad. */
export function showPhoneInstallNav(nav: Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'> = navigator): boolean {
  if (isDesktopShell(nav.userAgent) || isStandalone()) return false
  return isPhoneOrTablet({ ua: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints })
}

/**
 * Registrerar service workern och fångar Chromes installationsfråga. Anropas
 * en gång i main.tsx, bara i bygget och aldrig i skrivbordsappen.
 */
export function installPwa(): void {
  if (typeof window === 'undefined' || isDesktopShell()) return
  window.addEventListener('beforeinstallprompt', (e) => {
    // Chromes egen ruta väntar; vi visar knappen i kortet i stället.
    e.preventDefault()
    deferred = e as InstallPrompt
    notify()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    installedNow = true
    notify()
  })
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // updateViaCache 'none': sw.js hämtas alltid förbi webbläsarens cache.
      void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => undefined)
    })
  }
}

/** Kortets läge: kan vi visa Chromes installationsknapp, och är appen redan installerad? */
export function usePwaInstall(): { canPrompt: boolean; installed: boolean; prompt: () => Promise<boolean> } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = () => force((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return {
    canPrompt: deferred !== null,
    installed: installedNow || isStandalone(),
    prompt: async () => {
      const e = deferred
      if (!e) return false
      deferred = null
      await e.prompt()
      const { outcome } = await e.userChoice
      if (outcome === 'accepted') installedNow = true
      notify()
      return outcome === 'accepted'
    },
  }
}
