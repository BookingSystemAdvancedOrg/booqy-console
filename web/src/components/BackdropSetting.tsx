import { useEffect, useState, type MouseEvent } from 'react'
import { BackdropLibrary } from './BackdropLibrary'
import { getLibrary, selectedItem } from '../backdropStore'
import { isDesktopShell } from '../desktopDownloads'
import {
  hasBackdropImage,
  readGlassBackdrop,
  setGlassBackdrop,
  subscribeGlassBackdrop,
  SWATCHES,
  type GlassBackdrop,
} from '../glassBackdrop'

const at = (e: MouseEvent) => (e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)

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

  useEffect(
    () =>
      subscribeGlassBackdrop(() => {
        setValue(readGlassBackdrop())
        setHasImage(hasBackdropImage())
      }),
    [],
  )

  const colour = value.mode === 'colour' ? value.colour : null
  const pick = (c: string, e?: MouseEvent) => {
    setLastColour(c)
    setGlassBackdrop({ mode: 'colour', colour: c }, e ? at(e) : undefined)
  }
  const clear = (e: MouseEvent) => setGlassBackdrop({ mode: 'clear' }, at(e))

  const choose = (next: Tab, e: MouseEvent) => {
    setTab(next)
    if (next === 'clear') clear(e)
    else if (next === 'colour' && shell && colour === null) pick(lastColour, e)
    else if (next === 'image' && (hasImage || (getLibrary().loaded && selectedItem()))) setGlassBackdrop({ mode: 'image' }, at(e))
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

      {tab === 'image' && <BackdropLibrary />}
    </div>
  )
}
