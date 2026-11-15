import { ReactNode, useLayoutEffect, useRef, useState } from "react";

/** Which sides of a sideways-scrolling box have more to show. */
export function edgesOf(el: { scrollLeft: number; scrollWidth: number; clientWidth: number }): string {
  const left = el.scrollLeft > 1;
  const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  return [left && "left", right && "right"].filter(Boolean).join(" ");
}

/**
 * A wide table in its ticket (.table-wrap): a soft shadow on the side that
 * scrolls further (styles.css .scroll-edges), so a cut-off column reads as
 * "more this way" instead of clipped.
 */
export function ScrollEdges({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState("");
  useLayoutEffect(() => {
    const wrap = box.current?.querySelector<HTMLElement>(".table-wrap");
    if (!wrap) return;
    const update = () => setMore(edgesOf(wrap));
    update();
    wrap.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    ro?.observe(wrap);
    const table = wrap.querySelector("table");
    if (table) ro?.observe(table);
    return () => { wrap.removeEventListener("scroll", update); window.removeEventListener("resize", update); ro?.disconnect(); };
  }, []);
  return <div ref={box} className="scroll-edges" data-more={more || undefined}>{children}</div>;
}
