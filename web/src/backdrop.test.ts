import { afterEach, describe, expect, it } from 'vitest'
import { clearBackdrop, installBackdrop, readBackdrop, saveBackdrop } from './backdrop'
import { BACKDROP_KEY } from './storageRegistry'

const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='

afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.userBackdrop
})

describe('own backdrop', () => {
  it('sets a saved picture as --user-backdrop on <html>', () => {
    localStorage.setItem(BACKDROP_KEY, PIXEL)
    installBackdrop()
    expect(document.documentElement.style.getPropertyValue('--user-backdrop')).toContain(PIXEL)
    expect(document.documentElement.dataset.userBackdrop).toBe('on')
  })

  it('ignores values that are not pictures', () => {
    localStorage.setItem(BACKDROP_KEY, 'javascript:alert(1)')
    expect(readBackdrop()).toBeNull()
    installBackdrop()
    expect(document.documentElement.dataset.userBackdrop).toBeUndefined()
  })

  it('removes the picture and goes back to the Booqy backdrop', () => {
    localStorage.setItem(BACKDROP_KEY, PIXEL)
    installBackdrop()
    clearBackdrop()
    expect(localStorage.getItem(BACKDROP_KEY)).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--user-backdrop')).toBe('')
  })

  it('refuses files that are not pictures', async () => {
    const file = new File(['hej'], 'a.txt', { type: 'text/plain' })
    expect(await saveBackdrop(file)).toBe('not-image')
  })
})
