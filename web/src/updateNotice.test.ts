import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FAILSAFE_MS,
  FETCH_TIMEOUT_MS,
  SLOW_RELOAD_MS,
  VERSION_TIMEOUT_MS,
  page,
  reloadProgress,
  showUpdatedIfFlagged,
  startUpdateNotice,
} from './updateNotice'

function headWith(etags: string[]) {
  let i = 0
  return vi.fn(async () => {
    const etag = etags[Math.min(i++, etags.length - 1)]
    return new Response(null, { status: 200, headers: { etag } })
  })
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('updateNotice', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    document.body.innerHTML = ''
    document.head.querySelectorAll('script,link').forEach((n) => n.remove())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('stays quiet while the version is unchanged', async () => {
    vi.stubGlobal('fetch', headWith(['"a"', '"a"']))
    stop = startUpdateNotice({ intervalMs: 10 })
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(document.querySelector('.booqy-update')).toBeNull()
  })

  it('shows Ladda om when index.html changes, and never reloads by itself', async () => {
    const fetchMock = headWith(['"a"', '"b"'])
    vi.stubGlobal('fetch', fetchMock)
    stop = startUpdateNotice({ intervalMs: 60_000 })
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()
    const box = document.querySelector('.booqy-update')
    expect(box?.textContent).toContain('Ny version finns')
    expect(box?.querySelector('button')?.textContent).toBe('Ladda om')
    expect(fetchMock).toHaveBeenCalledWith('/index.html', expect.objectContaining({ method: 'HEAD', cache: 'no-store' }))
  })

  it('"Inte nu" hides it until the next new version', async () => {
    vi.stubGlobal('fetch', headWith(['"a"', '"b"', '"b"', '"c"']))
    stop = startUpdateNotice({ intervalMs: 60_000 })
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()
    document.querySelector<HTMLButtonElement>('.booqy-update__close')!.click()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(document.querySelector('.booqy-update')).toBeNull()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(document.querySelector('.booqy-update')).not.toBeNull()
  })

  it('combines several files, so a css-only deploy also counts', async () => {
    let round = 0
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      const etag = u.endsWith('.css') && round > 0 ? '"css2"' : `"${u}"`
      return new Response(null, { status: 200, headers: { etag } })
    }))
    stop = startUpdateNotice({ url: ['/', '/assets/booqy.css'], intervalMs: 60_000 })
    await flush()
    round = 1
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(document.querySelector('.booqy-update')).not.toBeNull()
  })

  it('gives up on a hanging version check, so the next check still runs', async () => {
    vi.useFakeTimers()
    let call = 0
    vi.stubGlobal('fetch', vi.fn(() => {
      call++
      if (call === 1) return Promise.resolve(new Response(null, { headers: { etag: '"a"' } }))
      if (call === 2) return new Promise<Response>(() => {})
      return Promise.resolve(new Response(null, { headers: { etag: '"b"' } }))
    }))
    stop = startUpdateNotice({ intervalMs: 600_000 })
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(VERSION_TIMEOUT_MS - 100)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toBe(2)
    await vi.advanceTimersByTimeAsync(200)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(call).toBe(3)
    expect(document.querySelector('.booqy-update')).not.toBeNull()
  })
})

describe('reloadProgress', () => {
  it('reaches 80 % within the rush and never 100 % while waiting', () => {
    expect(reloadProgress(0)).toBe(0)
    expect(reloadProgress(300)).toBeGreaterThan(0.6)
    expect(reloadProgress(600)).toBeCloseTo(0.8, 5)
    expect(reloadProgress(3_000)).toBeGreaterThan(0.85)
    expect(reloadProgress(600_000)).toBeLessThanOrEqual(0.95)
    for (let ms = 0; ms < 20_000; ms += 50) expect(reloadProgress(ms + 50)).toBeGreaterThanOrEqual(reloadProgress(ms))
  })
})

describe('reloading', () => {
  let stop: (() => void) | undefined
  let reload: ReturnType<typeof vi.fn<() => void>>
  let fileFetch: (u: string, init?: RequestInit) => Promise<Response>

  /** Shows the notice with a new version and returns its box. */
  async function noticeShown(opts: Parameters<typeof startUpdateNotice>[0] = {}) {
    const s = document.createElement('script')
    s.src = `${location.origin}/assets/app.js`
    document.head.appendChild(s)
    let round = 0
    vi.stubGlobal('fetch', vi.fn((u: string, init?: RequestInit) =>
      init?.method === 'HEAD' ? Promise.resolve(new Response(null, { headers: { etag: round++ ? '"b"' : '"a"' } })) : fileFetch(u, init)))
    stop = startUpdateNotice({ intervalMs: 600_000, ...opts })
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    const box = document.querySelector<HTMLElement>('.booqy-update')
    expect(box).not.toBeNull()
    return box!
  }

  const click = (sel: string) => document.querySelector<HTMLButtonElement>(sel)!.click()

  beforeEach(() => {
    vi.useFakeTimers()
    reload = vi.fn<() => void>()
    vi.spyOn(page, 'reload').mockImplementation(reload)
    fileFetch = async () => new Response('ok')
    // Reduced motion: the states are instant, so the steps are easy to read.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
  })
  afterEach(() => {
    stop?.()
    document.body.innerHTML = ''
    document.head.querySelectorAll('script').forEach((n) => n.remove())
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('asks first when there are unsaved changes; Avbryt keeps the notice', async () => {
    const discard = vi.fn()
    const box = await noticeShown({ hasUnsaved: () => true, discardUnsaved: discard })
    click('.booqy-update__reload')
    expect(box.textContent).toContain('Du har osparade ändringar')
    click('.booqy-update__cancel')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(reload).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    const again = document.querySelector<HTMLButtonElement>('.booqy-update__reload')
    expect(again?.textContent).toBe('Ladda om')
    expect(again?.disabled).toBe(false)
  })

  it('"Ladda om ändå" drops the guard just before the reload', async () => {
    const order: string[] = []
    const discard = vi.fn(() => order.push('discard'))
    reload.mockImplementation(() => order.push('reload'))
    await noticeShown({ hasUnsaved: () => true, discardUnsaved: discard })
    click('.booqy-update__reload')
    click('.booqy-update__anyway')
    expect(discard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(order).toEqual(['discard', 'reload'])
    expect(sessionStorage.getItem('booqy-updated')).toBe('1')
  })

  it('never drops the guard without the question', async () => {
    const discard = vi.fn()
    await noticeShown({ hasUnsaved: () => false, discardUnsaved: discard })
    click('.booqy-update__reload')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(reload).toHaveBeenCalledOnce()
    expect(discard).not.toHaveBeenCalled()
  })

  it('puts the guard back when the confirmed reload did not happen', async () => {
    const restore = vi.fn()
    const box = await noticeShown({ hasUnsaved: () => true, discardUnsaved: vi.fn(), restoreUnsaved: restore })
    click('.booqy-update__reload')
    click('.booqy-update__anyway')
    await vi.advanceTimersByTimeAsync(10)
    expect(reload).toHaveBeenCalledOnce()
    expect(restore).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(FAILSAFE_MS)
    expect(restore).toHaveBeenCalledOnce()
    expect(box.querySelector('.booqy-update__reload')).not.toBeNull()
  })

  it('waits longer when the reload has started but is slow', async () => {
    reload.mockImplementation(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
    const box = await noticeShown()
    click('.booqy-update__reload')
    await vi.advanceTimersByTimeAsync(FAILSAFE_MS + 500)
    expect(box.querySelector('.booqy-update__reload')).toBeNull()
    expect(sessionStorage.getItem('booqy-updated')).toBe('1')
    expect(document.querySelector('.booqy-curtain')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(SLOW_RELOAD_MS - FAILSAFE_MS)
    expect(box.querySelector('.booqy-update__reload')).not.toBeNull()
    expect(sessionStorage.getItem('booqy-updated')).toBeNull()
  })

  it('restores after 8 s when a leave guard stopped the reload', async () => {
    const guard = (e: Event) => e.preventDefault()
    window.addEventListener('beforeunload', guard)
    reload.mockImplementation(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))
    const box = await noticeShown()
    click('.booqy-update__reload')
    await vi.advanceTimersByTimeAsync(FAILSAFE_MS + 500)
    window.removeEventListener('beforeunload', guard)
    expect(box.textContent).toContain('Kunde inte ladda om. Försök igen.')
    expect(box.querySelector('.booqy-update__reload')).not.toBeNull()
  })

  it('reloads after 3 s even if the fresh files hang', async () => {
    const signals: AbortSignal[] = []
    fileFetch = (_u, init) => {
      signals.push(init!.signal!)
      return new Promise<Response>(() => {})
    }
    const box = await noticeShown()
    click('.booqy-update__reload')
    expect(box.dataset.progress).toBe('80')
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 100)
    expect(reload).not.toHaveBeenCalled()
    expect(box.dataset.progress).not.toBe('100')
    await vi.advanceTimersByTimeAsync(200)
    expect(signals[0].aborted).toBe(true)
    expect(box.dataset.progress).toBe('100')
    expect(reload).toHaveBeenCalledOnce()
  })

  it('brings the button back if the page is still alive 8 s after reload()', async () => {
    const box = await noticeShown()
    click('.booqy-update__reload')
    await vi.advanceTimersByTimeAsync(10)
    expect(reload).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(FAILSAFE_MS - 100)
    expect(box.querySelector('.booqy-update__reload')).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    const btn = box.querySelector<HTMLButtonElement>('.booqy-update__reload')
    expect(btn?.textContent).toBe('Ladda om')
    expect(btn?.disabled).toBe(false)
    expect(box.textContent).toContain('Kunde inte ladda om. Försök igen.')
    expect(sessionStorage.getItem('booqy-updated')).toBeNull()
    expect(document.querySelector('.booqy-curtain')).toBeNull()
  })

  it('races to 80 % in the rush and shows 100 % only once the files are in', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
    let release: () => void = () => {}
    fileFetch = () => new Promise<Response>((r) => { release = () => r(new Response('ok')) })
    const box = await noticeShown()
    click('.booqy-update__reload')
    await vi.advanceTimersByTimeAsync(700)
    expect(Number(box.dataset.progress)).toBeGreaterThanOrEqual(80)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(Number(box.dataset.progress)).toBeLessThan(96)
    expect(box.dataset.phase).toBe('crawl')
    release()
    await vi.advanceTimersByTimeAsync(300)
    expect(box.dataset.phase).toBe('done')
    expect(box.dataset.progress).toBe('100')
    expect(reload).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(300)
    expect(reload).toHaveBeenCalledOnce()
  })
})

describe('"Uppdaterad" after the reload', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    sessionStorage.clear()
    vi.useRealTimers()
  })

  it('shows once, only with the flag, and fades away', () => {
    vi.useFakeTimers()
    expect(showUpdatedIfFlagged()).toBe(false)
    expect(document.querySelector('.booqy-updated')).toBeNull()
    sessionStorage.setItem('booqy-updated', '1')
    expect(showUpdatedIfFlagged()).toBe(true)
    expect(document.querySelector('.booqy-updated')?.textContent).toContain('Uppdaterad')
    expect(sessionStorage.getItem('booqy-updated')).toBeNull()
    expect(showUpdatedIfFlagged()).toBe(false)
    vi.advanceTimersByTime(2_000)
    expect(document.querySelector('.booqy-updated')).toBeNull()
  })

  it('stays quiet when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(showUpdatedIfFlagged()).toBe(false)
    vi.restoreAllMocks()
  })
})
