import { ReactNode, useEffect, useRef } from "react";
import { celebrate } from "./Celebrate";
import { DrawnTick } from "./StepFlow";
import { Notice } from "./ui";

/** A green notice for a rare, consequential step done (a domain ordered, a DNS
 * zone ready): the tick draws, the notice pops once, a chime (ux-motion #19).
 * `id` keeps it to once per session. */
export function DoneMoment({ id, children }: { id: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { celebrate(ref.current, "step", id); }, [id]);
  return (
    <div ref={ref}>
      <Notice kind="ok"><DrawnTick className="run-tick" /> {children}</Notice>
    </div>
  );
}
