import { useEffect, useState } from "react";
import { useBusy } from "../busy";

// Quick answers (the status polling, a fast save) don't flash the strip.
const SHOW_AFTER_MS = 250;
const DONE_MS = 900;

/**
 * The strip at the top while anything loads or saves: wine red runs in from
 * the left with a shimmer moving along it, creeps on while the work runs,
 * then fills the width and fades when it's done. Screen readers hear
 * "Loading" and "Done".
 */
export function BusyBar() {
  const { active, finishedAt } = useBusy();
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");

  useEffect(() => {
    if (active) {
      const t = window.setTimeout(() => setPhase("busy"), SHOW_AFTER_MS);
      return () => window.clearTimeout(t);
    }
    setPhase((p) => (p === "busy" ? "done" : p));
    const t = window.setTimeout(() => setPhase("idle"), DONE_MS);
    return () => window.clearTimeout(t);
  }, [active, finishedAt]);

  useEffect(() => {
    document.documentElement.classList.toggle("is-busy", phase === "busy");
    return () => document.documentElement.classList.remove("is-busy");
  }, [phase]);

  return (
    <div className={`busy-bar busy-bar--${phase}`} aria-hidden={phase === "idle"}>
      <div className="busy-bar__fill"><span className="busy-bar__wave" /></div>
      <span className="sr-only" role="status" aria-live="polite">
        {phase === "busy" ? "Loading" : phase === "done" ? "Done" : ""}
      </span>
    </div>
  );
}
