import { useEffect, useRef, useState } from 'react'
import type { BackdropItem } from '../backdropStore'
import { Modal } from './ui'

/**
 * Preview of one of your pictures: a centred glass dialog with the whole
 * picture. Arrows and swipe move between pictures, Esc and a click outside
 * close. The thumbnail shows blurred until the full picture has loaded.
 */
export function BackdropPreview({
  items,
  index,
  selectedId,
  onIndex,
  onClose,
  onUse,
  onDelete,
}: {
  items: BackdropItem[]
  index: number
  selectedId: string | null
  onIndex: (i: number) => void
  onClose: () => void
  onUse: (id: string, origin?: { x: number; y: number }) => void
  onDelete: (id: string) => void
}) {
  const item = items[index]
  const [loaded, setLoaded] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const start = useRef<number | null>(null)
  const go = (d: number) => onIndex((index + d + items.length) % items.length)

  useEffect(() => {
    setLoaded(false)
    setConfirm(false)
  }, [item.id])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && items.length > 1) go(1)
      else if (e.key === 'ArrowLeft' && items.length > 1) go(-1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  })

  const selected = item.id === selectedId
  const date = new Date(item.uploadedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <Modal title={selected ? 'Your background' : 'Your picture'} onClose={onClose} wide>
      <div className="bg-preview" aria-label={`Picture from ${date}`}>
        <div
          className="bg-preview-stage"
          onPointerDown={(e) => (start.current = e.clientX)}
          onPointerUp={(e) => {
            if (start.current === null || items.length < 2) return
            const dx = e.clientX - start.current
            start.current = null
            if (Math.abs(dx) > 48) go(dx < 0 ? 1 : -1)
          }}
          style={{ aspectRatio: `${item.width} / ${item.height}` }}
        >
          <img className="bg-preview-thumb" src={item.thumbUrl} alt="" aria-hidden="true" />
          <img
            key={item.id}
            className={`bg-preview-full${loaded ? ' is-loaded' : ''}`}
            src={item.url}
            alt={`Your background from ${date}`}
            decoding="async"
            onLoad={() => setLoaded(true)}
          />
          {items.length > 1 && (
            <>
              <button type="button" className="bg-preview-nav bg-preview-nav--prev" aria-label="Previous picture" onClick={() => go(-1)}>
                <span aria-hidden="true">‹</span>
              </button>
              <button type="button" className="bg-preview-nav bg-preview-nav--next" aria-label="Next picture" onClick={() => go(1)}>
                <span aria-hidden="true">›</span>
              </button>
            </>
          )}
        </div>
        <p className="bg-preview-meta">
          {date} · {item.width} × {item.height} px{items.length > 1 ? ` · ${index + 1} of ${items.length}` : ''}
        </p>
        <div className="bg-preview-actions">
          {confirm ? (
            <button type="button" className="row-action row-action--danger" onClick={() => onDelete(item.id)}>
              Yes, remove the picture
            </button>
          ) : (
            <button type="button" className="row-action row-action--danger" onClick={() => setConfirm(true)}>
              Remove
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary"
            disabled={selected}
            onClick={(e) => onUse(item.id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)}
          >
            {selected ? 'Your background' : 'Use as background'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
