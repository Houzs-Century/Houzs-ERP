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
//      are 55 such sites outside tests
//      (`git grep -c "await import(" -- 'frontend/src' ':!*.test.*'`), and
//      patching them one at a time is not a fix of the class.
//
// Vite's preload helper is the ONE place both populations pass through. Every
// dynamic import in a production build is rewritten to `__vitePreload(() =>
// import(...), deps)`, whose tail is literally
// `return baseModule().catch(handlePreloadError)`, and handlePreloadError
// dispatches a cancelable `vite:preloadError` on window before rethrowing.
// Listening there covers the whole class at one site.
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
  // IT should know: unlike a route chunk, this failure self-heals for nobody —
  // the operator's click just silently did nothing useful.
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
