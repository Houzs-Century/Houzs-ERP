## Every deploy deleted the chunks open tabs still needed, so Print failed with Failed to fetch dynamically imported module [high]

<!-- area: Deploy, CI, migrations -->

**Symptom.** 2026-09-14, staff on HC-SO-012016 pressed Print in the preview and
got "PDF generation failed — Failed to fetch dynamically imported module:
https://erp.houzscentury.com/assets3/sales-order-pdf-C9QaiR37.js". The "This tab
is on an older version" pill appeared, but pressing Print again failed the same
way. `curl` of that URL the same morning: `404 text/plain`, body `Not found`.

**Root cause (traced).** Three things stacked.

1. **A Pages deploy is atomic.** `deploy.yml` runs
   `wrangler pages deploy ./dist`, so the new deployment serves only the files
   of the new build. Every file of the previous build that the new one lacks
   stops existing. 54 commits reached `main` in the 24h before this entry
   (`git log origin/main --since='24 hours ago'`), and the frontend job deploys
   on every one of them.
2. **Almost every file was renamed on every build, even with no code change.**
   `vite.config.ts` put `__BUILD_ID__ = Date.now()` into a `define`. That string
   lands in `initial-app-*.js`, a chunk's file name hashes its content, and every
   chunk importing `initial-app` inherits the new name. Measured on this tree:
   building commit `97e63c909` twice renamed **391 of 561** files in
   `dist/assets3`, `sales-order-pdf` and `jspdf.es.min` among them. With the
   build id pinned to a constant, the same double build renamed **0**; across 11
   consecutive `main` commits of 2026-09-13/14 each step renamed 390-393 files
   and only one `initial-app-*` change each time.
3. **A print is an `await import()` inside a click handler.** No React boundary
   sees it, so `ChunkReloadBoundary` never recovers; `staleBuild.ts` only raised
   the banner, by design, and the button kept importing the dead URL.

**Fix.**

- **Build id out of the code.** `vite.config.ts` writes it into
  `<meta name="houzs-build-id">` in `index.html`; `src/lib/buildId.ts` reads it
  for `RouteFallback`, `errorReporter` and `query-persist`. Two builds of the
  same tree now rename 0 of 561 files. `src/lib/buildId.test.ts` fails if any
  source file or the Vite config compiles `__BUILD_ID__` back in (red on the
  unfixed tree: it named `RouteFallback.tsx`, `errorReporter.ts`,
  `query-persist.ts`).
- **Keep the previous builds' files in every deployment.** New step in
  `deploy.yml` before `pages deploy`: `frontend/scripts/retain-previous-assets.mjs`
  reads the live `asset-manifest.json`, downloads each hashed file the new build
  lacks, checks it is 200, not HTML (the 2026-07-31 edge-poison shape) and the
  exact sha256, and writes it beside the new build — never over a file the new
  build has, so `index.html` and `sw.js` are the new build's. Files no build
  produced for 7 days are dropped, and the deployment stays under 19,000 files
  (Pages allows 20,000), oldest dropped first. Fail-safe: every operational
  failure is a warning and exit 0; the step is `continue-on-error` with a
  6-minute timeout. Rules in `scripts/lib/asset-retention.mjs`, 13 tests in
  `scripts/retain-previous-assets.test.mjs` (red before the module existed),
  run in `ci.yml`. Local rehearsal against a served copy of the previous build:
  561 built + 391 carried, deployment 1,287 files / 31.3 MB, largest file 1.16 MB,
  every carried file byte-identical, `index.html` the new build's.
- **The service worker passes a retained chunk through.** Its activate step
  purges old caches; `cacheFirst` then goes to the network, which now has the
  file. Pinned in `scripts/check-service-worker.mjs` (red when pass-through is
  replaced by a 504).
- **Safety net for a tab older than the window.** `src/lib/chunkActionRecovery.ts`
  listens to Vite's `vite:preloadError`. When the failure is proof a module
  could not be fetched, a print the operator started is in flight
  (`usePrintPreview` and `PrintChainProvider` track it), the page can reopen that
  preview, nothing unsaved is on screen (`src/lib/unsavedWork.ts`: `/new`,
  `/from-*`, `?edit=`, an open dirty `Panel`, unsaved payment rows, the payment
  voucher's edit toggle) and no such reload happened in 5 minutes, it reloads
  once and reopens the same preview (detail pages via
  `useOpenPrintPreviewFromUrl`, lists via `PrintChainProvider`). Otherwise the
  banner stays, and its Refresh button now reopens the print too. Tests red first:
  `chunkActionRecovery.test.ts` (module missing), `PrintPreviewModal.resume.test.tsx`
  and the new `PrintChainProvider.test.tsx` cases (4 failed before the hooks were
  wired).

**Not covered, stated plainly.** A page that prints without mounting
`useOpenPrintPreviewFromUrl` (e.g. the phone's SO detail) gets the banner, not an
automatic reload. The frontend still deploys on every `main` push; that is
deliberate in `deploy.yml` (collapsed queue runs), and with stable file names it
no longer renames unchanged code.

**Ref.** fix/keep-previous-build-assets, 2026-09-14.
