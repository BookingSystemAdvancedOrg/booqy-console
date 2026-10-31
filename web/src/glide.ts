/**
 * The chosen option glides, like the "Boka bord · Beställ mat · Catering ·
 * Kassa" tabs on booqy.se: every pick-one control (the page tabs and the chip
 * groups) gets a sand track and one espresso pill (::before) that slides and
 * stretches to the chosen option instead of jumping.
 *
 * The pages render plain buttons; this only measures them and sets
 * data-glide and --glide-x/-y/-w/-h on the group (React never touches those
 * attributes). A group becomes a glider once it has two or more options and
 * one is chosen. The style sits at the end of styles.css.
 */

// `.chips--plain` opts a group out: plain chips that switch with a simple click
const GROUPS = [".tabs", ".chips:not(.chips--plain)"];
const ACTIVE = ".tab--on, .chip--on, [aria-pressed='true'], [aria-selected='true']";

function place(bar: HTMLElement) {
  const items = Array.from(bar.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches("button, a"));
  const on = items.find((c) => c.matches(ACTIVE));
  if (!bar.dataset.glide) {
    if (items.length < 2 || !on) return;
    bar.dataset.glide = "track";
  }
  if (!on || !on.getClientRects().length) {
    delete bar.dataset.glideOn;
    return;
  }
  const box = bar.getBoundingClientRect();
  const r = on.getBoundingClientRect();
  bar.style.setProperty("--glide-x", `${r.left - box.left - bar.clientLeft + bar.scrollLeft}px`);
  bar.style.setProperty("--glide-y", `${r.top - box.top - bar.clientTop + bar.scrollTop}px`);
  bar.style.setProperty("--glide-w", `${r.width}px`);
  bar.style.setProperty("--glide-h", `${r.height}px`);
  if (bar.dataset.glideOn === undefined) {
    // the first placement lands without sliding in from the edge
    bar.dataset.glideOn = "";
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.dataset.glidePlaced = ""; }));
  }
}

let queued = false;
function placeAll() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (const selector of GROUPS) document.querySelectorAll<HTMLElement>(selector).forEach(place);
  });
}

let installed = false;

/** Watches the page once; any group that appears or changes choice is placed again. */
export function installGlide() {
  if (installed || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  installed = true;
  new MutationObserver(placeAll).observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-pressed", "aria-selected"],
  });
  window.addEventListener("resize", placeAll);
  void document.fonts?.ready.then(placeAll);
  placeAll();
}
