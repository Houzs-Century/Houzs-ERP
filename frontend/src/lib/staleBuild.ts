// ---------------------------------------------------------------------------
// Deploy churn: what a failed dynamic import() means, and who gets told.
//
// TWO independent populations of dynamic import live in this tree, and only one
// of them can ever reach a React error boundary:
//
//   1. React.lazy under <Suspense> — as of 2026-08-18, 137 in App.tsx and 28
//      under src/mobile (`grep -c 'lazy(' frontend/src/App.tsx`,
//      `git grep -c 'lazy(' -- 'frontend/src/mobile'`), plus a handful of
//      NON-route lazies (AnnouncementMedia, MobileAnnouncementPopup,
//      ModularAssignSupplierDialog). A failure here surfaces as a RENDER error,
//      so ChunkReloadBoundary catches it and can self-heal. That half was
//      already covered.
//   2. `await import(...)` inside an async event handler — print a PO, export a
//      grid to XLSX, pull in jspdf. React never sees these. The rejection is
//      caught by the handler's own try/catch and shown as a toast, so no
//      boundary runs, and errorReporter's `unhandledrejection` listener never
//      fires either because nothing is left unhandled. As of 2026-08-18 there
//      are 55 such sites outside tests, and patching them one at a time is not
//      a fix of the class. The command that reproduces 55 has to drop comment
//      lines, because THIS comment and NewVersionBanner's header both quote the
//      phrase and an unfiltered `git grep -c` counts its own prose:
//        git grep -n "await import(" -- 'frontend/src' ':!*.test.*' \
//          | grep -vE "^[^:]+:[0-9]+: *(//|\*)" | wc -l
//
// Vite's preload helper is the ONE place both populations pass through. Vite
// rewrites a dynamic import to `__vitePreload(() => import(...), deps)`, whose
// tail is literally `return baseModule().catch(handlePreloadError)`, and
// handlePreloadError dispatches a cancelable `vite:preloadError` on window
// before rethrowing. Listening there covers the whole class at one site.
//
// MEASURED, not assumed — because "every dynamic import goes through it" is a
// completeness claim and this repo has been burned by unbacked ones. Built this
// tree with `npx vite build` on 2026-08-18 and parsed all 410 emitted chunks
// with the TypeScript parser, counting `import()` call expressions and checking
// each for an enclosing `F(() => …, __vite__mapDeps([…]))`:
//
//     chunks=410 dynamic-import sites=329 wrapped-by-preload-helper=329 bare=0
//
// That is one build of one tree on one day, so it is evidence about THIS
// toolchain rather than a law about Vite. The shape it depends on is pinned by
// staleBuild.test.ts, which reads `return baseModule().catch(handlePreloadError)`
// and the event dispatch back out of node_modules/vite — if a Vite upgrade
// changes the helper, the suite goes red instead of the coverage going quietly
// dead. Re-run the scan (it is in the commit body) rather than trusting the
// number above after a Vite bump.
//
// WHAT THIS DOES AND DOES NOT DO — stated plainly, because the previous pass
// left the gap undisclosed:
//   • It does NOT retry the import, and it does NOT reload. The operator
//     deliberately clicked Print with data on screen; reloading under them is
//     the thing this whole area exists to avoid.
//   • It does NOT preventDefault, so the error still propagates to the caller's
//     own catch and the existing toast is unchanged.
//   • It DOES raise the version banner, so the operator gets an explanation and
//     a Refresh button instead of a raw "Failed to fetch dynamically imported
//     module: …" string and a button that will fail identically forever.
//   • In DEV nothing fires: native `import()` is not wrapped. Dev has no hashed
//     chunks, so there is nothing to strand.
// ---------------------------------------------------------------------------

import { reportClientError } from "./errorReporter";

/** The text of whatever was thrown. ONE site, read by both matchers below: a
 *  rejected dynamic import can carry anything (a string, an Event, a
 *  DOMException), so the optional chain and both fallbacks are real guards, not
 *  ceremony — which is why the parameter is typed with an OPTIONAL `message`
 *  rather than cast to `Error`. */
export function errorMessage(err: unknown): string {
  const carrier = err as { message?: unknown } | null | undefined;
  return String(carrier?.message ?? err ?? "");
}

/** BROAD. Decides whether to attempt RECOVERY, nothing else. The bare-word
 *  alternatives at the end (`preload`, `module script`, `MIME type`) are there
 *  because browsers word this failure differently and we have not enumerated
 *  every wording; a wrong guess costs one reload, which is cheap. */
const RECOVERABLE =
  /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload|module script|MIME type/i;

/** NARROW. Decides what we TELL A HUMAN, and it is deliberately not the matcher
 *  above. Asserting "a newer version was deployed" is a claim about the world:
 *  an unrelated render error that happens to contain the word `preload` would
 *  otherwise send an operator to reload, pay a service-worker unregister plus a
 *  cache purge that was never needed, watch the same failure, and report to IT
 *  that deploys are breaking the app. Every alternative here is a full phrase a
 *  browser emits ONLY when a module the network could not deliver was imported.
 *  `Expected a JavaScript module script` is the stale-service-worker shape —
 *  the shell served under a hashed .js URL — which is also a real deploy fact. */
const DEPLOY_EVIDENCE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Loading chunk .*failed|Importing a module script failed|Unable to preload CSS|Expected a JavaScript module script/i;

export function isStaleChunkError(err: unknown): boolean {
  return RECOVERABLE.test(errorMessage(err));
}

/** True only when the error is proof, on its own words, that a module could not
 *  be fetched — the bar for saying "a newer version was deployed" out loud. */
export function isDeployStaleEvidence(err: unknown): boolean {
  return DEPLOY_EVIDENCE.test(errorMessage(err));
}

// --- the store the banner reads -------------------------------------------
// Deliberately module-level rather than React context: the failure is dispatched
// from Vite's helper, outside React entirely, and can land before the banner has
// mounted (or while it is unmounted on a route that hides it).

let chunkFailed = false;
const listeners = new Set<() => void>();

export function subscribeChunkFailure(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function chunkFailureSnapshot(): boolean {
  return chunkFailed;
}

/** Record a dynamic-import failure. Latching, not a counter: once this tab is
 *  known to be on a stranded build, a second failure changes nothing an operator
 *  would act on differently, and re-notifying would just re-render the pill. */
export function noteChunkFailure(err: unknown): void {
  if (chunkFailed) return;
  // The narrow matcher, not the broad one: this decides whether a human is told
  // their build is stale. A module that threw during EVALUATION also reaches
  // handlePreloadError, and that is a page bug, not a deploy.
  if (!isDeployStaleEvidence(err)) return;
  chunkFailed = true;
  // WHO GETS REPORTED HERE, stated accurately — an earlier version of this
  // comment said "unlike a route chunk, this failure self-heals for nobody",
  // and that is false. This listener cannot tell the two populations apart:
  // the helper wraps ROUTE lazies too (329 of 329 sites in the build, see the
  // header), so a routine route-chunk miss that ChunkReloadBoundary is about
  // to heal on its own also lands here and also gets reported.
  //
  // That looks like it contradicts RouteFallback's giveUp(), which reports only
  // the PERSISTED case on the stated grounds that routine misses "would be pure
  // noise". It does not, for two reasons, and both are load-bearing:
  //   • VOLUME. The store latches at the guard above, so this fires at most once
  //     per tab per session no matter how many imports fail. giveUp() sits on a
  //     path a busy tab can reach repeatedly.
  //   • BAR. It is gated on isDeployStaleEvidence, the narrow matcher, so what
  //     is reported is "a tab could not fetch a module", which is worth one line
  //     whether or not a boundary healed it.
  //
  // The same overlap has a VISIBLE consequence, so it was measured rather than
  // reasoned about: because the banner is mounted at RootApp it sits outside
  // both RouteCrashBoundary and MobileCrashBoundary, so a route-chunk failure
  // that spends the ladder puts the crash PANEL and this pill on screen at once.
  // Checked 2026-08-18 in a browser against a throwaway harness that mounted the
  // real ChunkReloadBoundary (seeded with a `hard` mark so it renders the panel)
  // beside the real banner, and read getBoundingClientRect for both:
  //   375x812   panel "Reload now" 204-242, pill 650-722 — no overlap
  //   375x420   panel "Reload now" 204-242, pill 258-330 — no overlap, and
  //             elementFromPoint at the button's centre returns the BUTTON
  //   1280x800  panel "Reload now" 188-226, pill 728-776 — no overlap
  // The panel is in normal flow near the top; the pill is fixed to the bottom
  // inset. Both offer the same correct action and neither covers the other.
  reportClientError(err, "chunk-load-failed");
  for (const notify of [...listeners]) notify();
}

let installed = false;

/** Install the one listener that covers every dynamic import in the build.
 *  Call once, before React mounts. Idempotent.
 *
 *  Returns a disposer. Production never calls it — the listener lives as long as
 *  the document — but a window is shared across tests in jsdom, so a suite that
 *  cannot detach would leak a listener per test file and the next file's first
 *  dispatch would be observed by every earlier module instance. */
export function installChunkFailureWatch(): () => void {
  if (installed || typeof window === "undefined") return () => {};
  installed = true;
  const onPreloadError = (event: Event) => {
    // Vite hangs the original rejection on `.payload`. Never call
    // preventDefault(): that would swallow the error before the caller's own
    // catch runs, silently changing what 55 handlers do.
    noteChunkFailure((event as Event & { payload?: unknown }).payload);
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    installed = false;
  };
}
