import { useEffect, useState } from "react";
import { Bar } from "@booqy/brand";
import { useBusy } from "../busy";

// Quick answers (the status polling, a fast save) don't flash the strip.
const SHOW_AFTER_MS = 250;
const DONE_MS = 900;

/**
 * The strip at the top while anything loads or saves: wine red runs in from
 * the left with a shimmer moving along it, creeps on while the work runs,
 * then fills the width and fades when it's done. Screen readers hear
 * "Loading" and "Done". The strip itself is the busy variant of Bar from
 * @booqy/brand (the shared brand pilot); the phase is worked out here.
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

  // busy-bar and busy-bar--<phase> stay as hooks for the tests; the look comes from Bar
  return <Bar variant="busy" phase={phase} position="fixed" className={`busy-bar busy-bar--${phase}`} busyLabel="Loading" doneLabel="Done" />;
}
