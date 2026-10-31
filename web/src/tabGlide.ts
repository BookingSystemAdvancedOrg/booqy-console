/**
 * The chosen tab glides, like the "Så funkar det" tabs on booqy.se: every
 * `.tabs` bar gets one lacquered pill (`.tabs::before`) that slides to the
 * chosen `.tab--on` and stretches to its width, instead of the pill jumping.
 * The pages keep rendering plain tabs; this only measures them and sets
 * `--glide-x` and `--glide-w` on the bar. Reduced motion: it moves without
 * the glide (see styles.css).
 */

function place(bar: HTMLElement) {
  const on = bar.querySelector<HTMLElement>(".tab--on");
  if (!on) {
    bar.classList.remove("is-glide", "is-placed");
    return;
  }
  const box = bar.getBoundingClientRect();
  const r = on.getBoundingClientRect();
  bar.style.setProperty("--glide-x", `${r.left - box.left - bar.clientLeft + bar.scrollLeft}px`);
  bar.style.setProperty("--glide-w", `${r.width}px`);
  if (!bar.classList.contains("is-glide")) {
    // the first placement lands without sliding in from the left
    bar.classList.add("is-glide");
    requestAnimationFrame(() => requestAnimationFrame(() => bar.classList.add("is-placed")));
  }
}

let queued = false;
function placeAll() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    document.querySelectorAll<HTMLElement>(".tabs").forEach(place);
  });
}

let installed = false;

/** Watches the page once; any tab bar that appears or changes tab is placed again. */
export function installTabGlide() {
  if (installed || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  installed = true;
  new MutationObserver(placeAll).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", placeAll);
  void document.fonts?.ready.then(placeAll);
  placeAll();
}
