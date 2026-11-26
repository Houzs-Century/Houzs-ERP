
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

const RECOVERABLE =
  /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload|module script|MIME type/i;

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
  if (!isDeployStaleEvidence(err)) return;
  chunkFailed = true;
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
    noteChunkFailure((event as Event & { payload?: unknown }).payload);
  };
  window.addEventListener("vite:preloadError", onPreloadError);
  return () => {
    window.removeEventListener("vite:preloadError", onPreloadError);
    installed = false;
  };
}


/** Budget for the single cache-busting probe of the chunk that failed (see
 *  probeChunk). Short on purpose: the operator is staring at a skeleton for the
 *  whole of it, and an answer we don't get in time is treated as "transient",
 *  which is the CHEAP branch — so a slow probe costs nothing but the wait. */
export const CHUNK_PROBE_TIMEOUT_MS = 3_000;

/** The chunk URL the browser names in the failure — "Failed to fetch
 *  dynamically imported module: https://erp.houzscentury.com/assets3/Foo-x.js".
 *  Restricted to our OWN origin: this URL is fed to fetch(), and an error
 *  message is attacker-influenceable in principle (a third-party script's
 *  rejection can reach the same boundary), so a cross-origin probe would be a
 *  request we never meant to make. Any other error shape returns null and the
 *  caller keeps the old unconditional behaviour. */
export function chunkUrlFrom(err: unknown): string | null {
  const m = errorMessage(err).match(/\bhttps?:\/\/[^\s"'()]+\.[mc]?js\b/i);
  if (!m) return null;
  try {
    const url = new URL(m[0]);
    if (typeof window === "undefined" || url.origin !== window.location.origin) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** What one cache-busting re-fetch says about the chunk the import could not
 *  get. Deliberately three-valued: "we could not tell" is not "it is gone". */
export type ChunkProbe = "present" | "absent" | "unknown";

/**
 * Ask ONCE whether the chunk is really missing, before spending a recovery on
 * it. Shared by RouteFallback (render failures) and chunkActionRecovery (a print
 * click). A hard recovery unregisters every service worker and deletes
 * every cache — the right price for a stranded build, a wildly wrong one for a
 * network hiccup, which is what a lone failed import usually is.
 *
 * `cache: "reload"` bypasses the browser HTTP cache on the way out, so an
 * aborted/poisoned entry for this exact URL is re-fetched rather than replayed.
 * It does NOT bypass the service worker, which is deliberate: a still-installed
 * old worker answering a hashed /assets/*.js with the app shell is precisely
 * the stale-deploy shape hardRecover exists for, and we want to SEE it.
 */
export async function probeChunk(url: string): Promise<ChunkProbe> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), CHUNK_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "reload", credentials: "same-origin", signal: abort.signal });
    if (!res.ok) return "absent";
    return /javascript|ecmascript/i.test(res.headers.get("content-type") ?? "")
      ? "present"
      : "absent";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(deadline);
  }
}
