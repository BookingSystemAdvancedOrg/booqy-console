# Console UI tests (layout, accessibility, visual)

Playwright suite for the operator console on the local Vite dev server. No
network: a stubbed Cognito session (`lib/ui-fixtures.ts` writes fake tokens to
localStorage) and a stubbed API on `https://api.e2e.test` (fixtures in the same
file). Next to the live-dev e2e specs.

```bash
npm ci
npx playwright install chromium webkit firefox
npm run test:ui                         # all sizes, Chromium + WebKit + Firefox (@x)
npx playwright test -c playwright.ui.config.ts --project=chromium -g "finance 390"
npm run test:ui:update                  # rewrite the baselines (review the diff!)
npm run ui:report
```

Dev server port: `UI_PORT` (default 7175); workers: `UI_WORKERS`.

## What it checks

Every page x every size x light and dark (where the app has both):

- Sizes (Chromium): 320, 360, 375, 390, 414 (phones), 768 and 820 portrait,
  1024 and 1180 landscape (tablets), 1280, 1440, 1920, 2560 (desktop).
  WebKit (Safari) and Firefox run 390, 820 and 1440 (tests tagged `@x`). The Firefox build that Playwright 1.63 installs on the dev Mac does not start ("Could not find profile folder"), so Firefox has not been run yet; run `--project=firefox` on CI or after a Playwright update.
- Layout (`lib/ui-audit.ts`, identical in all four apps): no sideways page
  scroll, nothing cut off at the window edge, text not clipped, nothing
  covering a button or input, fixed bars, dialogs and drawers inside the window
  (and scrollable if taller), the floating help button overlapping nothing
  (fixed bars anywhere, any content at the end of the page), tap targets of at
  least 44 px on phones (reported as `low`, never fails the run), visible
  keyboard focus on the first tab stops.
- Accessibility: `@axe-core/playwright`, serious and critical only.
- Visual regression: `toHaveScreenshot` at the sizes in `VISUAL`
  (`UI_VISUAL_SIZES`, default `360,1280`, to keep the repo small), animations
  off, reduced motion, fixed clock. Baselines are macOS Chromium; update them
  on a Mac.
- Every test appends its findings to `test-results/ui-issues.jsonl`;
  `node summarize-ui.mjs` ranks them by severity (`--json out.json` for the
  report).

Specs are named `*.ui.ts` so the app's own unit tests never pick them up.
