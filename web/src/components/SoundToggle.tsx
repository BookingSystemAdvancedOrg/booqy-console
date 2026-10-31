import { useSound } from "../press";

/**
 * The top-bar button that switches the click sound on and off (src/press.ts).
 * A toggle button (aria-pressed): pressed = sound on, like booqy.se's
 * "Ljud på/av" in English.
 */
export function SoundToggle({ className = "" }: { className?: string }) {
  const [on, toggle] = useSound();
  return (
    <button
      type="button"
      className={`theme-toggle sound-toggle${className ? ` ${className}` : ""}`}
      aria-pressed={on}
      aria-label="Click sound"
      title={on ? "Click sound on" : "Click sound off"}
      onClick={toggle}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5 6 9H3v6h3l5 4z" />
        {on ? (
          <>
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </>
        ) : (
          <path d="m17 9 5 6M22 9l-5 6" />
        )}
      </svg>
    </button>
  );
}
