/* Booqys service worker (src/pwa.ts registrerar den, aldrig i skrivbordsappen).
 *
 * Gör tre saker och inget mer:
 *  - Sidnavigering: nätet först, så en deploy syns direkt; utan nät det senast
 *    sparade skalet (index.html).
 *  - /assets/*: filnamnen har hash och ändras aldrig, så de sparas och läses lokalt.
 *  - Allt annat (API, inloggning, andra domäner, HEAD-anrop som "Ny version
 *    finns" gör mot index.html) går orört till nätet. API-svar sparas aldrig.
 *
 * Filen har fast namn och hålls stabil: deployen invaliderar CloudFront och
 * webbläsaren hämtar sw.js förbi sin cache (updateViaCache 'none').
 * Ändras den: höj SHELL nedan så att gamla cacher rensas.
 */
const SHELL = 'booqy-shell-v1'
const ASSETS = 'booqy-assets-v1'
const MAX_ASSETS = 300

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add(new Request('/index.html', { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith('booqy-') && key !== SHELL && key !== ASSETS) await caches.delete(key)
      }
      await self.clients.claim()
    })(),
  )
})

async function trim(cache) {
  const keys = await cache.keys()
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(k)
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req)
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
            const copy = res.clone()
            event.waitUntil(caches.open(SHELL).then((c) => c.put('/index.html', copy)))
          }
          return res
        } catch {
          return (await caches.match('/index.html')) || Response.error()
        }
      })(),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        const res = await fetch(req)
        if (res.ok && res.status === 200) {
          const copy = res.clone()
          event.waitUntil(caches.open(ASSETS).then(async (c) => { await c.put(req, copy); await trim(c) }))
        }
        return res
      })(),
    )
  }
})
