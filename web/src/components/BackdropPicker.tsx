import { useRef, useState } from "react";
import { clearBackdrop, readBackdrop, saveBackdrop, type BackdropError } from "../backdrop";
import { withBusy } from "../busy";

const ERRORS: Record<BackdropError, string> = {
  "not-image": "That is not a picture. Choose a JPG, PNG or WebP file.",
  unreadable: "The picture could not be read. Try another file.",
  "too-large": "The picture did not fit in the browser. Try a smaller one.",
};

/** Picks your own picture behind the glass, or goes back to Booqy's backdrop. */
export function BackdropPicker({ id }: { id: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [hasOwn, setHasOwn] = useState(() => readBackdrop() !== null);
  const [error, setError] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setError(null);
    const err = await withBusy(() => saveBackdrop(file));
    if (err) {
      setError(ERRORS[err]);
      input.current?.focus();
    } else {
      setHasOwn(true);
    }
    if (input.current) input.current.value = "";
  }

  return (
    <div className="backdrop-picker">
      <div className="backdrop-picker__actions">
        <label className="setting-toggle backdrop-picker__choose">
          <input
            ref={input}
            id={id}
            type="file"
            accept="image/*"
            className="backdrop-picker__input"
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(e) => void onPick(e.currentTarget.files?.[0])}
          />
          {hasOwn ? "Change picture" : "Choose picture"}
        </label>
        {hasOwn && (
          <button
            type="button"
            className="setting-toggle"
            onClick={() => {
              clearBackdrop();
              setHasOwn(false);
              setError(null);
            }}
          >
            Booqy backdrop
          </button>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} className="error-text small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
