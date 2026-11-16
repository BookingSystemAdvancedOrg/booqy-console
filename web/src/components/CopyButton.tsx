import { ReactNode, useEffect, useRef, useState } from "react";
import { CheckMark } from "./save";

/** Copy to the clipboard: "Copied" with a check for a moment. Without clipboard
 * access (http, permissions) the text opens selected, to copy by hand. */
export function CopyButton({ text, children = "Copy", label, className = "btn btn--small" }: {
  text: string; children?: ReactNode; label?: string; className?: string;
}) {
  const [done, setDone] = useState(false);
  const [manual, setManual] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (manual) { box.current?.focus(); box.current?.select(); }
  }, [manual]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setManual(false);
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1500);
    } catch {
      setManual(true);
      box.current?.select();
    }
  }
  return (
    <>
      <button type="button" className={className} aria-label={label} onClick={() => void copy()}>
        {done ? <><CheckMark />Copied</> : children}
      </button>
      {manual && (
        <textarea ref={box} className="input mono copy-manual" aria-label="Copy by hand" readOnly value={text}
                  rows={Math.min(6, text.split("\n").length)} style={{ width: "100%", marginTop: 6 }}
                  onFocus={(e) => e.target.select()} />
      )}
    </>
  );
}
