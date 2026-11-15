import { afterEach, describe, expect, it } from 'vitest'
import {
  applyGlassBackdrop,
  forgetBackdropImage,
  hasBackdropImage,
  installGlassBackdrop,
  parseGlassBackdrop,
  readGlassBackdrop,
  refreshBackdropImage,
  setBackdropImageSource,
  setGlassBackdrop,
} from './glassBackdrop'
import { vi } from 'vitest'
import { GLASS_BACKDROP_KEY } from './storageRegistry'

afterEach(() => {
  localStorage.clear()
  forgetBackdropImage()
  setBackdropImageSource(async () => null)
  applyGlassBackdrop({ mode: 'clear' })
  vi.unstubAllGlobals()
})

describe('background behind the glass', () => {
  it('is see-through when nothing is chosen', () => {
    expect(readGlassBackdrop()).toEqual({ mode: 'clear' })
    installGlassBackdrop()
    expect(document.documentElement.dataset.glassBackdrop).toBeUndefined()
  })

  it('never moves anyone to Colour from an unknown or old value', () => {
    for (const v of ['', 'clear', 'colour', 'red', '#fff', '#12345', 'url(x)', 'data:image/png;base64,AA']) {
      expect(parseGlassBackdrop(v)).toEqual({ mode: 'clear' })
    }
    localStorage.setItem('booqy-backdrop', 'data:image/jpeg;base64,AA')
    expect(readGlassBackdrop()).toEqual({ mode: 'clear' })
  })

  it('reads a stored colour', () => {
    localStorage.setItem(GLASS_BACKDROP_KEY, '#6B1D24')
    expect(readGlassBackdrop()).toEqual({ mode: 'colour', colour: '#6b1d24' })
  })

  it('stores a colour and puts it on <html>', () => {
    setGlassBackdrop({ mode: 'colour', colour: '#7f9479' })
    expect(localStorage.getItem(GLASS_BACKDROP_KEY)).toBe('#7f9479')
    expect(document.documentElement.dataset.glassBackdrop).toBe('colour')
    expect(document.documentElement.style.getPropertyValue('--user-colour')).toBe('#7f9479')
  })

  it('back to see-through removes the stored value', () => {
    setGlassBackdrop({ mode: 'colour', colour: '#7f9479' })
    setGlassBackdrop({ mode: 'clear' })
    expect(localStorage.getItem(GLASS_BACKDROP_KEY)).toBeNull()
    expect(document.documentElement.dataset.glassBackdrop).toBeUndefined()
  })

  it('Your image shows the Booqy backdrop until the picture is decoded', () => {
    setGlassBackdrop({ mode: 'image' })
    expect(localStorage.getItem(GLASS_BACKDROP_KEY)).toBe('image')
    expect(document.documentElement.dataset.glassBackdrop).toBe('image-loading')
  })

  it('puts the picture on <html> once fetched and decoded', async () => {
    vi.stubGlobal(
      'Image',
      class {
        decoding = ''
        src = ''
        decode() {
          return Promise.resolve()
        }
      },
    )
    setBackdropImageSource(async () => 'https://images.example/backdrop?sig=1')
    setGlassBackdrop({ mode: 'image' })
    expect(await refreshBackdropImage()).toBe(true)
    expect(hasBackdropImage()).toBe(true)
    expect(document.documentElement.dataset.glassBackdrop).toBe('image')
    expect(document.documentElement.style.getPropertyValue('--user-image')).toContain('https://images.example/backdrop?sig=1')
  })

  it('without a picture on the server the page stays on the Booqy backdrop', async () => {
    setBackdropImageSource(async () => null)
    setGlassBackdrop({ mode: 'image' })
    expect(await refreshBackdropImage()).toBe(false)
    expect(document.documentElement.dataset.glassBackdrop).toBe('image-loading')
  })
})
