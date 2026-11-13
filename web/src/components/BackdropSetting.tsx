import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { removeBackdropImage, uploadBackdropImage, type UploadError } from '../backdropImage'
import { isDesktopShell } from '../desktopDownloads'
import {
  hasBackdropImage,
  readGlassBackdrop,
  refreshBackdropImage,
  setGlassBackdrop,
  subscribeGlassBackdrop,
  SWATCHES,
  type GlassBackdrop,
} from '../glassBackdrop'

const at = (e: MouseEvent) => (e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)

const UPLOAD_ERRORS: Record<UploadError, string> = {
  'not-image': 'That is not a picture. Choose a JPG, PNG, WebP or HEIC image.',
  unreadable: 'The picture could not be read here. Try a JPG or PNG.',
  'too-large': 'The picture is too large, even shrunk. Try another one.',
  failed: 'The picture could not be saved. Try again.',
}

type Tab = 'clear' | 'colour' | 'image'

/**
 * Background behind the glass. Desktop app: See-through (the default), Colour
 * or Your image. Browser: Colour (with Booqy's backdrop as the default) or
 * Your image; see-through only works in the app.
 */
export function BackdropSetting() {
  const shell = isDesktopShell()
  const [value, setValue] = useState<GlassBackdrop>(readGlassBackdrop)
  const [hasImage, setHasImage] = useState(hasBackdropImage)
  const [lastColour, setLastColour] = useState(value.mode === 'colour' ? value.colour : SWATCHES[0].colour)
  const [tab, setTab] = useState<Tab>(value.mode === 'clear' ? (shell ? 'clear' : 'colour') : value.mode)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(
    () =>
      subscribeGlassBackdrop(() => {
        setValue(readGlassBackdrop())
        setHasImage(hasBackdropImage())
      }),
    [],
  )
  useEffect(() => {
    if (tab === 'image' && !hasBackdropImage()) void refreshBackdropImage().then(setHasImage)
  }, [tab])

  const colour = value.mode === 'colour' ? value.colour : null
  const pick = (c: string, e?: MouseEvent) => {
    setLastColour(c)
    setGlassBackdrop({ mode: 'colour', colour: c }, e ? at(e) : undefined)
  }
  const clear = (e: MouseEvent) => setGlassBackdrop({ mode: 'clear' }, at(e))

  const choose = (next: Tab, e: MouseEvent) => {
    setError(null)
    setTab(next)
    if (next === 'clear') clear(e)
    else if (next === 'colour' && shell && colour === null) pick(lastColour, e)
    else if (next === 'image' && hasBackdropImage()) setGlassBackdrop({ mode: 'image' }, at(e))
  }

  async function onFile(f: File | undefined) {
    if (!f) return
    setError(null)
    const err = await uploadBackdropImage(f)
    if (err) {
      setError(UPLOAD_ERRORS[err])
      file.current?.focus()
    }
    if (file.current) file.current.value = ''
  }

  async function onRemove(e: MouseEvent) {
    setError(null)
    if (!(await removeBackdropImage(at(e)))) setError('The picture could not be removed. Try again.')
    else setTab(shell ? 'clear' : 'colour')
  }

  const tabs: { id: Tab; label: string }[] = [
    ...(shell ? [{ id: 'clear' as const, label: 'See-through' }] : []),
    { id: 'colour', label: 'Colour' },
    { id: 'image', label: 'Your image' },
  ]

  return (
    <div className="backdrop-setting">
      <div className="backdrop-segment" role="group" aria-label="Background">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={(e) => choose(t.id, e)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'colour' && (
        <div className="backdrop-swatches" role="group" aria-label="Colour behind the glass">
          {!shell && (
            <button
              type="button"
              className="backdrop-swatch backdrop-swatch--brand"
              aria-pressed={value.mode === 'clear'}
              aria-label="Booqy backdrop"
              title="Booqy backdrop"
              onClick={clear}
            />
          )}
          {SWATCHES.map((s) => (
            <button
              key={s.colour}
              type="button"
              className="backdrop-swatch"
              style={{ background: s.colour }}
              aria-pressed={colour === s.colour}
              aria-label={s.name}
              title={s.name}
              onClick={(e) => pick(s.colour, e)}
            />
          ))}
          <label
            className="backdrop-swatch backdrop-swatch--custom"
            title="Your own colour"
            data-selected={colour !== null && !SWATCHES.some((s) => s.colour === colour) ? 'true' : undefined}
            style={colour && !SWATCHES.some((s) => s.colour === colour) ? { background: colour } : undefined}
          >
            <span aria-hidden="true">+</span>
            <input type="color" aria-label="Your own colour" value={colour ?? lastColour} onChange={(e) => pick(e.currentTarget.value)} />
          </label>
        </div>
      )}

      {tab === 'image' && (
        <div className="backdrop-image">
          <label className="setting-toggle backdrop-image-choose">
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="backdrop-image-input"
              aria-describedby={error ? 'backdrop-image-error' : undefined}
              onChange={(e) => void onFile(e.currentTarget.files?.[0])}
            />
            {hasImage ? 'Change picture' : 'Choose picture'}
          </label>
          {hasImage && (
            <button type="button" className="row-action row-action--danger" onClick={(e) => void onRemove(e)}>
              Remove picture
            </button>
          )}
        </div>
      )}

      {error && (
        <p id="backdrop-image-error" className="backdrop-image-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
