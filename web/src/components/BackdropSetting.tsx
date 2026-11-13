import { useEffect, useState, type MouseEvent } from 'react'
import { isDesktopShell } from '../desktopDownloads'
import { readGlassBackdrop, setGlassBackdrop, subscribeGlassBackdrop, SWATCHES, type GlassBackdrop } from '../glassBackdrop'

const at = (e: MouseEvent) => (e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)

/**
 * Background behind the glass. In the desktop app: See-through (the default)
 * or Colour. A browser cannot be see-through, so there it offers the colours
 * with Booqy's backdrop as the default.
 */
export function BackdropSetting() {
  const shell = isDesktopShell()
  const [value, setValue] = useState<GlassBackdrop>(readGlassBackdrop)
  const [lastColour, setLastColour] = useState(value.mode === 'colour' ? value.colour : SWATCHES[0].colour)
  useEffect(() => subscribeGlassBackdrop(() => setValue(readGlassBackdrop())), [])

  const pick = (colour: string, e?: MouseEvent) => {
    setLastColour(colour)
    setGlassBackdrop({ mode: 'colour', colour }, e ? at(e) : undefined)
  }
  const clear = (e: MouseEvent) => setGlassBackdrop({ mode: 'clear' }, at(e))
  const colour = value.mode === 'colour' ? value.colour : null

  const swatches = (
    <div className="backdrop-swatches" role="group" aria-label="Colour behind the glass">
      {!shell && (
        <button type="button" className="backdrop-swatch backdrop-swatch--brand" aria-pressed={colour === null} aria-label="Booqy backdrop" title="Booqy backdrop" onClick={clear} />
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
  )

  return (
    <div className="backdrop-setting">
      {shell && (
        <div className="backdrop-segment" role="group" aria-label="Background">
          <button type="button" aria-pressed={colour === null} onClick={clear}>
            See-through
          </button>
          <button type="button" aria-pressed={colour !== null} onClick={(e) => colour === null && pick(lastColour, e)}>
            Colour
          </button>
        </div>
      )}
      {(!shell || colour !== null) && swatches}
    </div>
  )
}
