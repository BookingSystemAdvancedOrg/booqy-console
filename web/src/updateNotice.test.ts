import { afterEach, describe, expect, it, vi } from 'vitest'
import { startUpdateNotice } from './updateNotice'

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
    vi.unstubAllGlobals()
    vi.useRealTimers()
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
})
