/* Light or dark mode, set before the first paint so nothing flashes.
   The choice lives in localStorage under "booqy-theme" (src/theme.ts and
   src/storageRegistry.ts); without one the console follows the system.
   A plain blocking script (not a module) so it runs before the first
   frame, and a file of its own because CloudFront's CSP only allows
   script-src 'self'. Cached for a year under this name: if it changes,
   bump the version in the file name and in index.html. */
;(function (root) {
  var theme = null;
  try {
    theme = localStorage.getItem("booqy-theme");
  } catch {
    /* private mode without storage */
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  root.setAttribute("data-theme", theme);
  // The browser's own frame (meta theme-color) follows the wall.
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#1f0002" : "#350001");
})(document.documentElement);
