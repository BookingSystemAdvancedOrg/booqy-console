import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import {
  deleteBackdrop,
  getLibrary,
  loadLibrary,
  selectBackdrop,
  subscribeLibrary,
  uploadBackdrop,
  type BackdropItem,
  type UploadError,
} from '../backdropStore'
import { BackdropPreview } from './BackdropPreview'

const UPLOAD_ERRORS: Record<UploadError, string> = {
  'not-image': 'That is not a picture. Choose a JPG, PNG, WebP or HEIC image.',
  unreadable: 'The picture could not be read here. Try a JPG or PNG.',
  'too-large': 'The picture is too large, even shrunk. Try another one.',
  limit: 'Your library is full. Remove a picture to upload a new one.',
  failed: 'The picture could not be saved. Try again.',
}

const at = (e: MouseEvent) => (e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)
const when = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

/** The operator's own pictures: a grid with upload, select and preview. */
export function BackdropLibrary() {
  const lib = useSyncExternalStore(subscribeLibrary, getLibrary, getLibrary)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [preview, setPreview] = useState<number | null>(null)
  const file = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!lib.loaded) void loadLibrary()
  }, [lib.loaded])
  useEffect(() => {
    if (!menuFor) return
    const close = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('.bg-tile-menu')) setMenuFor(null)
    }
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMenuFor(null)
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [menuFor])

  async function onFile(f: File | undefined) {
    if (!f) return
    setError(null)
    const err = await uploadBackdrop(f, setProgress)
    setProgress(null)
    if (err) {
      setError(UPLOAD_ERRORS[err])
      file.current?.focus()
    }
    if (file.current) file.current.value = ''
  }

  async function remove(item: BackdropItem) {
    setConfirmFor(null)
    setMenuFor(null)
    if (!(await deleteBackdrop(item.id))) setError('The picture could not be removed. Try again.')
  }

  const full = lib.items.length >= lib.max

  return (
    <div className="bg-library">
      <div className="bg-library-head">
        <span className="bg-library-count">
          {lib.items.length} of {lib.max} pictures
        </span>
      </div>

      {lib.loaded && lib.items.length === 0 && (
        <p className="bg-library-empty">No pictures yet. Upload one and it lands here and becomes your background straight away.</p>
      )}

      <ul className="bg-grid" aria-label="Your pictures">
        <li className="bg-cell">
          <label className={`bg-tile bg-tile--upload${full ? ' is-disabled' : ''}`} aria-disabled={full || undefined}>
            <input
              ref={file}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              className="bg-upload-input"
              disabled={full || progress !== null}
              aria-label="Upload a new picture"
              aria-describedby={error ? 'bg-library-error' : undefined}
              onChange={(e) => void onFile(e.currentTarget.files?.[0])}
            />
            {progress === null ? (
              <span className="bg-upload-label">
                <span aria-hidden="true" className="bg-upload-plus">+</span>
                {full ? 'Library full' : 'Upload new'}
              </span>
            ) : (
              <span className="bg-upload-progress" role="progressbar" aria-label="Uploading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <span className="bg-upload-bar" style={{ inlineSize: `${Math.round(progress * 100)}%` }} />
                <span className="bg-upload-pct">{Math.round(progress * 100)} %</span>
              </span>
            )}
          </label>
        </li>
        {lib.items.map((item, index) => {
          const selected = item.id === lib.selectedId
          return (
            <li key={item.id} className="bg-cell">
              <div className={`bg-tile${selected ? ' is-selected' : ''}`}>
                <button type="button" className="bg-thumb" aria-label={`View picture from ${when(item.uploadedAt)}${selected ? ', selected as background' : ''}`} onClick={() => setPreview(index)}>
                  <img src={item.thumbUrl} alt={`Your background from ${when(item.uploadedAt)}`} loading="lazy" decoding="async" />
                </button>
                {selected && (
                  <span className="bg-check" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  </span>
                )}
                <div className="bg-tile-menu">
                  <button
                    type="button"
                    className="bg-tile-more"
                    aria-label={`More for the picture from ${when(item.uploadedAt)}`}
                    aria-expanded={menuFor === item.id}
                    onClick={() => {
                      setConfirmFor(null)
                      setMenuFor(menuFor === item.id ? null : item.id)
                    }}
                  >
                    <span aria-hidden="true">…</span>
                  </button>
                  {menuFor === item.id && (
                    <div className="bg-menu" role="menu">
                      {!selected && (
                        <button type="button" role="menuitem" className="row-action" onClick={(e) => { setMenuFor(null); void selectBackdrop(item.id, at(e)) }}>
                          Use as background
                        </button>
                      )}
                      <button type="button" role="menuitem" className="row-action" onClick={() => { setMenuFor(null); setPreview(index) }}>
                        View
                      </button>
                      {confirmFor === item.id ? (
                        <button type="button" role="menuitem" className="row-action row-action--danger" onClick={() => void remove(item)}>
                          Yes, remove
                        </button>
                      ) : (
                        <button type="button" role="menuitem" className="row-action row-action--danger" onClick={() => setConfirmFor(item.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {error && (
        <p id="bg-library-error" className="bg-library-error" role="alert">
          {error}
        </p>
      )}

      {preview !== null && lib.items[preview] && (
        <BackdropPreview
          items={lib.items}
          index={preview}
          selectedId={lib.selectedId}
          onIndex={setPreview}
          onClose={() => setPreview(null)}
          onUse={(id, origin) => void selectBackdrop(id, origin)}
          onDelete={async (id) => {
            const next = lib.items.length - 1
            if (await deleteBackdrop(id)) setPreview(next > 0 ? Math.min(preview, next - 1) : null)
          }}
        />
      )}
    </div>
  )
}
