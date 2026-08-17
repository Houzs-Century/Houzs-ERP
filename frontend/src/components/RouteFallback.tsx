import React from "react";
import { useLocation } from "react-router-dom";
import { Skeleton } from "./Skeleton";
import { reportClientError } from "../lib/errorReporter";

/**
 * Suspense fallback for lazily-loaded route chunks — a brand-tinted page
 * shape (header, KPI tiles, table block) instead of a blank screen or a
 * bare "Loading..." line. Pattern from Hookka's PageSkeleton.
 */
export function PageSkeleton() {
  return (
    <div className="space-y-6 p-1" aria-busy="true" aria-label="Loading page">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-lg" />
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/**
 * Catches chunk-load failures after a redeploy (the old bundle references
 * hashed chunk files that no longer exist) and reloads the page once to
 * pick up the new build. Any other render error shows a compact retry
 * panel instead of a white screen.
 */
const RECOVER_AT_KEY = "chunk-recovered-at";
/** A recovery that didn't stick must not immediately trigger another one. Any
 *  chunk error within this window of the last attempt shows the panel instead.
 *  Time-based, not once-per-session: a tab left open across a LATER deploy
 *  still self-heals once. */
const RECOVER_COOLDOWN_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 8_000;
/** Budget for the single cache-busting probe of the chunk that failed (see
 *  probeChunk). Short on purpose: the operator is staring at a skeleton for the
 *  whole of it, and an answer we don't get in time is treated as "transient",
 *  which is the CHEAP branch — so a slow probe costs nothing but the wait. */
const PROBE_TIMEOUT_MS = 3_000;
/** hardRecover() always ends in reload(), but its awaits (SW unregister, cache
 *  delete) are not guaranteed to settle. Don't strand the user on a skeleton.
 *  DERIVED, never typed: the watchdog must outlast the worst legitimate
 *  recovery — probe budget, then cleanup budget — or it fires the "recovery
 *  failed" panel while the reload it is supposed to follow is still coming. */
const RECOVER_TIMEOUT_MS = PROBE_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + 1_000;

declare const __BUILD_ID__: string;
/** The build this bundle was compiled from — the same define errorReporter
 *  stamps onto every reported event, so a panel in client_errors can be read
 *  against the build that produced it. */
export const CURRENT_BUILD_ID =
  typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev";

/** A remembered recovery attempt: WHEN, and on WHICH build it was made. */
type RecoverMark = { at: number; buildId: string };

/** Read the stored attempt. Deliberately does NOT catch a storage failure —
 *  the caller turns that into "must not self-heal". A corrupt/unparsable value
 *  reads as no attempt (the cooldown's job is to stop loops, not to survive
 *  garbage). */
function readRecoverMark(): RecoverMark | null {
  const raw = sessionStorage.getItem(RECOVER_AT_KEY);
  if (!raw) return null;
  // Legacy value: a bare timestamp, written by a build from before the mark
  // carried a build id. Treat it as an attempt on THIS build so upgrading a
  // live tab can never hand out an extra reload.
  if (/^\d+$/.test(raw)) return { at: Number(raw), buildId: CURRENT_BUILD_ID };
  try {
    const parsed = JSON.parse(raw) as Partial<RecoverMark> | null;
    const at = Number(parsed?.at ?? 0);
    if (!at) return null;
    return { at, buildId: String(parsed?.buildId ?? CURRENT_BUILD_ID) };
  } catch {
    return null;
  }
}

/** Whether we may self-heal now. False when we already tried within the
 *  cooldown — or when sessionStorage is unavailable, since without a memory
 *  across reloads an auto-reload would loop forever.
 *
 *  The cooldown is scoped to the BUILD, not just to the clock (owner
 *  2026-07-31): main deployed several times within an hour, so his tab
 *  self-healed onto a new bundle and then hit a fresh chunk failure on THAT
 *  bundle seconds later — inside the 60s window, which spent his one attempt
 *  and left him on the panel across /scm/purchase-orders, /scm/grns, /projects
 *  and /assr. A recorded attempt from a DIFFERENT build has already done its
 *  job (the reload landed a new build), so the next failure is a new fault and
 *  gets its own attempt. This cannot loop: the build id only changes when a
 *  reload actually picks up a new deploy, and a repeat failure on the same
 *  build falls back to the time cooldown. */
function canHardRecover(): boolean {
  try {
    const mark = readRecoverMark();
    if (!mark) return true;
    if (mark.buildId !== CURRENT_BUILD_ID) return true;
    return Date.now() - mark.at > RECOVER_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markHardRecover(): boolean {
  try {
    sessionStorage.setItem(
      RECOVER_AT_KEY,
      JSON.stringify({ at: Date.now(), buildId: CURRENT_BUILD_ID } satisfies RecoverMark),
    );
    return true;
  } catch {
    return false;
  }
}

/** The text of whatever was thrown. ONE site, read by both matchers below: the
 *  `Error` in componentDidCatch's signature is React's promise, not a proof — a
 *  rejected dynamic import can carry anything — so the optional chain is a real
 *  guard the type system cannot see, and it is worth writing exactly once. */
function errorMessage(err: unknown): string {
  return String((err as Error)?.message ?? err ?? "");
}

function isStaleChunkError(err: unknown): boolean {
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload|module script|MIME type/i.test(
    errorMessage(err),
  );
}

/** The chunk URL the browser names in the failure — "Failed to fetch
 *  dynamically imported module: https://erp.houzscentury.com/assets3/Foo-x.js".
 *  Restricted to our OWN origin: this URL is fed to fetch(), and an error
 *  message is attacker-influenceable in principle (a third-party script's
 *  rejection can reach the same boundary), so a cross-origin probe would be a
 *  request we never meant to make. Any other error shape returns null and the
 *  caller keeps the old unconditional behaviour. */
function chunkUrlFrom(err: unknown): string | null {
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
type ChunkProbe = "present" | "absent" | "unknown";

/**
 * Ask ONCE whether the chunk is really missing, before spending a hard
 * recovery on it. A hard recovery unregisters every service worker and deletes
 * every cache — the right price for a stranded build, a wildly wrong one for a
 * network hiccup, which is what a lone failed import usually is.
 *
 * `cache: "reload"` bypasses the browser HTTP cache on the way out, so an
 * aborted/poisoned entry for this exact URL is re-fetched rather than replayed.
 * It does NOT bypass the service worker, which is deliberate: a still-installed
 * old worker answering a hashed /assets/*.js with the app shell is precisely
 * the stale-deploy shape hardRecover exists for, and we want to SEE it.
 */
async function probeChunk(url: string): Promise<ChunkProbe> {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "reload", credentials: "same-origin", signal: abort.signal });
    // A missing chunk is a real 404 at the edge — functions/[[path]].ts turns
    // the SPA-fallback shell back into one for any static-asset extension, and
    // that is the answer this branch is reading.
    if (!res.ok) return "absent";
    // 200 with an HTML body under a .js URL is the SW/edge poisoning described
    // in hardRecover's header. Same verdict as a 404: only the unregister fixes it.
    return /javascript|ecmascript/i.test(res.headers.get("content-type") ?? "")
      ? "present"
      : "absent";
  } catch {
    // Offline, aborted, blocked. NOT evidence the build moved — and purging
    // every cache while offline destroys the only copy of the shell the service
    // worker could still serve. Stay on the cheap branch.
    return "unknown";
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * HARD recovery after a redeploy strands the client. Purging Cache Storage
 * alone was NOT enough (owner 2026-07-04, "Something went wrong loading this
 * page" stuck across reloads): a still-registered OLD service worker keeps
 * intercepting fetches and can serve the app-shell HTML for a hashed
 * /assets/*.js request -> "Expected a JavaScript module but got text/html" ->
 * the import fails AGAIN after a plain reload. So we UNREGISTER every service
 * worker AND delete every cache, THEN reload — the next load fetches the fresh
 * build from the network and registers the current SW. Best-effort; always
 * reloads even if a step throws.
 *
 * UNSAVED WORK. Every path here ends in reload(), which fires `beforeunload`,
 * so the pages that register a guard (PaymentsTable) still warn — the browser
 * dialog is not bypassed by anything below. And the AUTOMATIC arm can only fire
 * on a lazy import, every one of which is a ROUTE, so react-router has already
 * unmounted the form by the time this runs: the edit was lost at navigation,
 * not here. What is NOT covered is an app-wide dirty-form registry — most forms
 * register no guard at all — and building one is a cross-cutting change well
 * outside this boundary. Left deliberately, and stated here so the next reader
 * does not assume it was considered and handled.
 */
/* Guarded because hardRecover is FIRE-AND-FORGET: componentDidCatch starts it
   without awaiting, so its continuation can land after the caller's environment
   is gone. In a browser `window` is always there; in a torn-down jsdom it is
   not, and the bare deref threw `ReferenceError: window is not defined` as an
   unhandled error attributed to whatever test file was running at the time. */
const defaultReload = () => {
  if (typeof window !== "undefined") window.location.reload();
};

export async function hardRecover(reload = defaultReload): Promise<void> {
  const cleanup = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
      }
    } catch {}
    try {
      if ("caches" in window) {
        const ks = await caches.keys();
        await Promise.all(ks.map((k) => caches.delete(k).catch(() => false)));
      }
    } catch {}
  };
  // Browser APIs can hang indefinitely. Reload anyway before the boundary's
  // watchdog exposes the manual recovery panel; the cooldown prevents loops.
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, CLEANUP_TIMEOUT_MS); }),
    ]);
  } finally {
    // The deadline has done its job the moment the race settles — when cleanup
    // wins, leaving it pending is a timer that outlives what scheduled it.
    if (deadline !== undefined) clearTimeout(deadline);
  }
  reload();
}

interface BoundaryState {
  error: Error | null;
  /** Self-heal is in flight. Renders the page skeleton, NOT the error panel:
   *  hardRecover() is async, so showing the panel here is what made the owner
   *  see "error 先然後再 loading 出來" — the crash flashed for the few hundred
   *  ms until the reload landed, on a load that then recovered fine. */
  recovering: boolean;
  /** The caught error was a stale-chunk failure, so the panel can say WHAT went
   *  wrong ("this tab is on an older build") and offer the action that actually
   *  fixes it, instead of the generic "something went wrong" that left the
   *  operator with nothing to do but stare at it. */
  staleChunk: boolean;
}

interface BoundaryProps {
  children: React.ReactNode;
  /** Changes when the route changes — a crash is cleared on navigation so one
   *  page's render error never bricks the whole shell. */
  resetKey?: string;
}

export class ChunkReloadBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, recovering: false, staleChunk: false };
  private recoverTimer: number | null = null;

  static getDerivedStateFromError(error: Error): BoundaryState {
    // Decide the RENDER here, in the same commit that catches: a stale chunk we
    // are about to self-heal shows the skeleton; anything else shows the panel.
    const staleChunk = isStaleChunkError(error);
    return { error, recovering: staleChunk && canHardRecover(), staleChunk };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isStaleChunkError(error)) {
      // markHardRecover() returning false means sessionStorage is unusable, so
      // we can't remember this attempt — reloading blind would loop. Show the
      // panel and let the user press Reload.
      if (canHardRecover() && markHardRecover()) {
        // Probe first, then reload as cheaply as the answer allows.
        void this.recoverFromStaleChunk(error);
        return;
      }
      // A reload already failed to fix it — surface it instead of looping.
      console.error("[chunk-recover] stale chunk error persisted:", error?.message ?? error);
      // Report the PERSISTED case only: routine post-deploy chunk misses
      // self-heal silently above and would be pure noise, but a recovery that
      // did not stick means a user is staring at the panel — IT should know.
      reportClientError(error, "stale-chunk-persisted");
      this.setState({ recovering: false });
      return;
    }
    // A real render error (bad data shape, unguarded access, ...). Log it so
    // IT can find and fix the underlying page bug instead of it recurring
    // invisibly behind the generic panel.
    console.error("[route-crash]", error?.message ?? error, info?.componentStack ?? "");
    // Report AND fall through to the fallback render — never swallow, never
    // change behaviour. React catches render errors before window.onerror can,
    // so without this call a white-screen class of crash would stay invisible
    // to the daily digest. reportClientError never throws and never loops.
    reportClientError(error, "route-crash");
  }

  /**
   * The AUTOMATIC arm of stale-chunk recovery, and the one place that decides
   * how expensive a recovery this failure has earned.
   *
   * Before this existed, every failed import — including a single dropped
   * request on a flaky office connection — cost a full service-worker
   * unregister plus a purge of every Cache Storage namespace, which throws away
   * the offline shell and every cached asset the tab had. One re-fetch of the
   * chunk that failed tells us which of the two situations we are in, and the
   * cheap branch is the common one.
   *
   * Async on purpose, and started WITHOUT await from componentDidCatch: the
   * body runs synchronously up to the probe, so an error carrying no usable URL
   * still escalates in the same tick it always did.
   */
  private async recoverFromStaleChunk(error: Error): Promise<void> {
    const url = chunkUrlFrom(error);
    // No URL to probe ("Loading chunk 42 failed", a CSS preload failure).
    // Nothing new to learn, so keep the behaviour this boundary always had.
    if (!url) {
      void hardRecover();
      return;
    }
    if ((await probeChunk(url)) === "absent") {
      // The chunk really is gone (or the old SW is answering with the shell).
      // Only unregister + purge fixes that; a plain reload would fail again.
      void hardRecover();
      return;
    }
    // The chunk fetches fine now, so the build is not the problem — the import
    // just lost a round trip. React.lazy memoises the rejection, so a re-render
    // cannot retry it; a plain reload is the smallest thing that works, and it
    // leaves the service worker and the caches intact. If the same failure
    // survives the reload, the cooldown routes the second one to the panel,
    // whose button escalates to the full recovery.
    defaultReload();
  }

  componentDidMount(): void {
    if (this.state.recovering) this.startRecoverTimer();
  }

  componentDidUpdate(prevProps: BoundaryProps, prevState: BoundaryState): void {
    if (this.state.recovering && !prevState.recovering) {
      this.startRecoverTimer();
    }
    // Recover on navigation: when the route changes while a crash is showing,
    // clear it so the destination page renders. A single boundary wraps every
    // route, so without this a crash on one page persists app-wide until a
    // full reload (owner 2026-07-13: "整个 system 都崩溃掉了").
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.clearRecoverTimer();
      this.setState({ error: null, recovering: false, staleChunk: false });
    }
    // NOTE: the recovery guard is deliberately NOT cleared on a successful
    // render. It used to be, which re-armed it the moment the app shell
    // rendered — so a chunk error arriving right after (the lazy route
    // resolving) could reload again, and again. The cooldown replaces it.
  }

  componentWillUnmount(): void {
    this.clearRecoverTimer();
  }

  private clearRecoverTimer(): void {
    if (this.recoverTimer !== null) {
      window.clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
  }

  private startRecoverTimer(): void {
    this.clearRecoverTimer();
    this.recoverTimer = window.setTimeout(() => {
      // The reload never landed — stop pretending to load and show the panel.
      this.setState({ recovering: false });
    }, RECOVER_TIMEOUT_MS);
  }

  /** The MANUAL arm. The cooldown governs the automatic reload only — it exists
   *  to stop a loop nobody asked for, and a click is not a loop. So this never
   *  consults canHardRecover(): when the operator is looking at the panel
   *  BECAUSE the cooldown refused to self-heal, the button in front of them has
   *  to be the thing that works, not a second refusal. It still RECORDS the
   *  attempt, so the automatic arm stays rate-limited afterwards. */
  private manualRecover(): void {
    // Full recovery, not a plain reload: a plain reload kept failing for the
    // owner because the old SW re-served the stale shell.
    markHardRecover();
    this.setState({ recovering: true });
    void hardRecover();
  }

  render() {
    // Self-heal in flight: keep showing "loading", the reload is coming.
    if (this.state.recovering) return <PageSkeleton />;
    if (this.state.error) {
      const stale = this.state.staleChunk;
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm font-medium text-ink">
            {stale
              ? "This tab is running an older version of the app."
              : "Something went wrong loading this page."}
          </p>
          <p className="max-w-md text-xs text-ink-muted">
            {stale
              ? "A newer version was deployed, so this page could not load. Reload to pick it up — any unsaved changes on this page will be lost. If it keeps happening, let IT know."
              : "Please reload to try again. If it keeps happening, let IT know."}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => this.manualRecover()}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-ink hover:bg-surface-dim"
            >
              {stale ? "Reload now" : "Reload"}
            </button>
            <a
              href="/"
              className="rounded-lg px-4 py-2 text-sm font-medium text-ink-secondary hover:text-ink hover:bg-surface-dim"
            >
              Go to overview
            </a>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Location-aware wrapper for ChunkReloadBoundary. Feeds the current pathname as
 * the reset key so a page crash is cleared the moment the user navigates
 * elsewhere (in-app nav via the sidebar recovers without a reload). Use this at
 * the app shell instead of ChunkReloadBoundary directly.
 */
export function RouteCrashBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <ChunkReloadBoundary resetKey={location.pathname}>{children}</ChunkReloadBoundary>;
}
