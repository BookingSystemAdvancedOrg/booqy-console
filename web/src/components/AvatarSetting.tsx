import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { coverCrop, cropSquare, getMyAvatar, loadMyAvatar, removeMyAvatar, saveMyAvatar, subscribeMyAvatar } from "../avatar";
import { Avatar } from "./Avatar";
import { Modal } from "./ui";

const VIEW = 240;

/** Settings: your own profile picture. Choose, position in a square, save. */
export function AvatarSetting({ name, email }: { name?: string; email?: string }) {
  const mine = useSyncExternalStore(subscribeMyAvatar, getMyAvatar, getMyAvatar);
  const [file, setFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!mine.loaded) void loadMyAvatar();
  }, [mine.loaded]);

  return (
    <div className="setting-row">
      <div className="avatar-setting__who">
        <Avatar url={mine.url} name={name} email={email} size="lg" />
        <div>
          <p className="strong">Profile picture</p>
          <p className="muted small">Shown next to your name in the operator list. Only you can change yours.</p>
        </div>
      </div>
      <div className="avatar-setting__actions">
        <label className="setting-toggle avatar-setting__choose">
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            className="avatar-setting__input"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              setError(null);
              if (f) setFile(URL.createObjectURL(f));
              e.currentTarget.value = "";
            }}
          />
          {mine.url ? "Change picture" : "Choose picture"}
        </label>
        {mine.url && (
          <button type="button" className="row-action row-action--danger" onClick={() => void removeMyAvatar().then((ok) => !ok && setError("The picture could not be removed. Try again."))}>
            Remove
          </button>
        )}
        {error && <p className="error-text small" role="alert">{error}</p>}
      </div>
      {file && (
        <CropDialog
          src={file}
          onClose={() => {
            URL.revokeObjectURL(file);
            setFile(null);
            input.current?.focus();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function CropDialog({ src, onClose, onError }: { src: string; onClose: () => void; onError: (m: string) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const crop = size ? coverCrop(size.w, size.h, VIEW, zoom, offset.x, offset.y) : null;

  async function save() {
    if (!img.current || !crop) return;
    setBusy(true);
    let ok = false;
    try {
      ok = await saveMyAvatar(await cropSquare(img.current, crop, VIEW));
    } catch {
      ok = false;
    }
    setBusy(false);
    if (!ok) onError("The picture could not be saved. Try again, or try a JPG or PNG.");
    onClose();
  }

  const nudge = (dx: number, dy: number) => setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));

  return (
    <Modal title="Position your picture" onClose={onClose}>
      <div className="avatar-crop">
        <div
          className="avatar-crop__view"
          style={{ inlineSize: VIEW, blockSize: VIEW }}
          tabIndex={0}
          role="application"
          aria-label="Drag, or use the arrow keys, to position the picture"
          onKeyDown={(e) => {
            const step = e.shiftKey ? 24 : 8;
            if (e.key === "ArrowLeft") nudge(-step, 0);
            else if (e.key === "ArrowRight") nudge(step, 0);
            else if (e.key === "ArrowUp") nudge(0, -step);
            else if (e.key === "ArrowDown") nudge(0, step);
            else return;
            e.preventDefault();
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <img
            ref={img}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            onError={() => {
              onError("The picture could not be read here. Try a JPG or PNG.");
              onClose();
            }}
            style={crop ? { transform: `translate(${crop.x}px, ${crop.y}px) scale(${crop.scale})` } : { opacity: 0 }}
          />
        </div>
        <label className="avatar-crop__zoom">
          <span className="small muted">Zoom</span>
          <input type="range" min={1} max={3} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.currentTarget.value))} />
        </label>
        <div className="row avatar-crop__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!crop || busy}>{busy ? "Saving…" : "Save picture"}</button>
        </div>
      </div>
    </Modal>
  );
}
