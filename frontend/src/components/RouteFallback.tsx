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
/** hardRecover() always ends in reload(), but its awaits (SW unregister, cache
 *  delete) are not guaranteed to settle. Don't strand the user on a skeleton. */
const RECOVER_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 8_000;

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

function isStaleChunkError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported|Unable to preload CSS|Failed to fetch dynamically imported|preload|module script|MIME type/i.test(
    msg,
  );
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
}

interface BoundaryProps {
  children: React.ReactNode;
  /** Changes when the route changes — a crash is cleared on navigation so one
   *  page's render error never bricks the whole shell. */
  resetKey?: string;
}

export class ChunkReloadBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, recovering: false };
  private recoverTimer: number | null = null;

  static getDerivedStateFromError(error: Error): BoundaryState {
    // Decide the RENDER here, in the same commit that catches: a stale chunk we
    // are about to self-heal shows the skeleton; anything else shows the panel.
    return { error, recovering: isStaleChunkError(error) && canHardRecover() };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isStaleChunkError(error)) {
      // markHardRecover() returning false means sessionStorage is unusable, so
      // we can't remember this attempt — reloading blind would loop. Show the
      // panel and let the user press Reload.
      if (canHardRecover() && markHardRecover()) {
        // Unregister the old SW + purge caches, THEN reload once (cooldown-
        // guarded) so the fresh hashed build is fetched from the network.
        void hardRecover();
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
      this.setState({ error: null, recovering: false });
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

  render() {
    // Self-heal in flight: keep showing "loading", the reload is coming.
    if (this.state.recovering) return <PageSkeleton />;
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <p className="text-sm font-medium text-ink">Something went wrong loading this page.</p>
          <p className="max-w-md text-xs text-ink-muted">
            Please reload to try again. If it keeps happening, let IT know.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                // Full recovery, not a plain reload: a plain reload kept failing
                // for the owner because the old SW re-served the stale shell.
                markHardRecover();
                this.setState({ recovering: true });
                void hardRecover();
              }}
              className="rounded-lg border border-border-subtle px-4 py-2 text-sm font-medium text-ink hover:bg-surface-dim"
            >
              Reload
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
