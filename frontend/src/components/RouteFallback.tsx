import React from "react";
import { useLocation } from "react-router-dom";
import { Skeleton } from "./Skeleton";
import { reportClientError } from "../lib/errorReporter";
import { errorMessage, isDeployStaleEvidence, isStaleChunkError } from "../lib/staleBuild";

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

/** How expensive the remembered attempt was.
 *  `soft` = a plain reload (the probe said the chunk was fetchable, so the build
 *  was probably fine); `hard` = the full service-worker unregister + cache purge. */
type RecoverKind = "soft" | "hard";
/** A remembered recovery attempt: WHEN, on WHICH build, and HOW expensive. */
type RecoverMark = { at: number; buildId: string; kind: RecoverKind };

/** Read the stored attempt. Deliberately does NOT catch a storage failure —
 *  the caller turns that into "must not self-heal". A corrupt/unparsable value
 *  reads as no attempt (the cooldown's job is to stop loops, not to survive
 *  garbage). */
function readRecoverMark(): RecoverMark | null {
  const raw = sessionStorage.getItem(RECOVER_AT_KEY);
  if (!raw) return null;
  // Legacy value: a bare timestamp, written by a build from before the mark
  // carried a build id. Treat it as an attempt on THIS build so upgrading a
  // live tab can never hand out an extra reload — and as `hard`, the kind that
  // grants no further escalation, for exactly the same reason.
  if (/^\d+$/.test(raw)) return { at: Number(raw), buildId: CURRENT_BUILD_ID, kind: "hard" };
  try {
    const parsed = JSON.parse(raw) as Partial<RecoverMark> | null;
    const at = Number(parsed?.at ?? 0);
    if (!at) return null;
    return {
      at,
      buildId: String(parsed?.buildId ?? CURRENT_BUILD_ID),
      // A mark written before this build knew about kinds recorded the full
      // recovery, so default to the strict answer.
      kind: parsed?.kind === "soft" ? "soft" : "hard",
    };
  } catch {
    return null;
  }
}

/** What this failure has earned, given what the last one already spent.
 *
 *  `probe`    — nothing recent to go on. Ask the network whether the chunk is
 *               really gone, then reload as cheaply as the answer allows.
 *  `escalate` — we already spent a SOFT reload on this build seconds ago and the
 *               failure survived it. That is the 2026-07-04 shape: a
 *               still-registered old service worker re-serving the stale shell,
 *               which no number of plain reloads will fix. Go straight to the
 *               full recovery instead of showing the panel — origin/main would
 *               have self-healed here, and the earlier version of this file
 *               regressed that by spending the single automatic slot on the
 *               cheap branch before the probe verdict was even known.
 *  `panel`    — the expensive recovery has already been tried and did not stick,
 *               or sessionStorage is unusable so we cannot remember anything.
 *               Anything automatic from here is a loop; hand it to the operator.
 *
 *  This cannot loop. Within one build the ladder only climbs — none -> soft ->
 *  hard -> panel — and each rung writes its mark before it reloads.
 *
 *  The cooldown is scoped to the BUILD, not just to the clock (owner
 *  2026-07-31): main deployed several times within an hour, so his tab
 *  self-healed onto a new bundle and then hit a fresh chunk failure on THAT
 *  bundle seconds later — inside the 60s window, which spent his one attempt
 *  and left him on the panel across /scm/purchase-orders, /scm/grns, /projects
 *  and /assr. A recorded attempt from a DIFFERENT build has already done its
 *  job (the reload landed a new build), so the next failure is a new fault and
 *  gets its own attempt. The build id only changes when a reload actually picks
 *  up a new deploy, and a repeat failure on the same build falls back to the
 *  time cooldown. */
function recoverStep(): "probe" | "escalate" | "panel" {
  try {
    const mark = readRecoverMark();
    if (!mark) return "probe";
    if (mark.buildId !== CURRENT_BUILD_ID) return "probe";
    if (Date.now() - mark.at > RECOVER_COOLDOWN_MS) return "probe";
    return mark.kind === "soft" ? "escalate" : "panel";
  } catch {
    return "panel";
  }
}

/** Remember the attempt we are ABOUT to make, and which kind it is. Returns
 *  false when sessionStorage refused — the caller must then not reload at all,
 *  because an attempt we cannot remember is an attempt that repeats forever. */
function markHardRecover(kind: RecoverKind): boolean {
  try {
    sessionStorage.setItem(
      RECOVER_AT_KEY,
      JSON.stringify({ at: Date.now(), buildId: CURRENT_BUILD_ID, kind } satisfies RecoverMark),
    );
    return true;
  } catch {
    return false;
  }
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
 * UNSAVED WORK — the gap is REAL, and this paragraph used to deny it.
 *
 * It claimed the automatic arm "can only fire on a lazy import, every one of
 * which is a ROUTE, so react-router has already unmounted the form by the time
 * this runs". That is false. ChunkReloadBoundary catches any render error in its
 * subtree, and three lazy imports in this tree are NOT route entries — they can
 * fail with the operator's form still mounted and still dirty:
 *   • components/AnnouncementBanner.tsx lazy-loads AnnouncementMedia inside the
 *     persistent banner mounted above the routes in App.tsx;
 *   • mobile/MobileApp.tsx lazy-loads MobileAnnouncementPopup, an overlay;
 *   • pages/scm-v2/ProductModelDetail.tsx:50 lazy-loads AssignSupplierDialog,
 *     a dialog opened from inside a detail page.
 *
 * What actually protects unsaved work is only this: every path here ends in
 * reload(), which fires `beforeunload`, so a page that registers a guard gets
 * the browser's own confirm dialog and nothing below bypasses it. Exactly ONE
 * page registers one today (PaymentsTable). Every other form loses its edits
 * with no prompt.
 *
 * Not fixed here, deliberately: the fix is an app-wide dirty-form registry, a
 * cross-cutting change well outside this boundary. Stated at full strength so
 * the next reader does not inherit a false reason to skip it.
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
  /** The caught error is PROOF, in its own words, that a module could not be
   *  fetched — so the panel may say WHAT went wrong ("this tab is on an older
   *  build") and offer the action that fixes it, instead of the generic
   *  "something went wrong" that left the operator with nothing to do.
   *
   *  Gated on isDeployStaleEvidence, NOT on the broad isStaleChunkError that
   *  decides recovery. The broad matcher accepts the bare words `preload`,
   *  `module script` and `MIME type` on purpose — a wrong guess there costs one
   *  reload. Telling an operator "a newer version was deployed" is a claim about
   *  the world: get it wrong and they reload for nothing, see the same failure,
   *  and report to IT that deploys are breaking the app. */
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
    return {
      error,
      recovering: isStaleChunkError(error) && recoverStep() !== "panel",
      staleChunk: isDeployStaleEvidence(error),
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isStaleChunkError(error)) {
      const step = recoverStep();
      if (step === "probe") {
        // Probe first, then reload as cheaply as the answer allows.
        void this.recoverFromStaleChunk(error);
        return;
      }
      if (step === "escalate") {
        // A plain reload was already spent on this build seconds ago and the
        // failure came back. Only the unregister + purge fixes that shape.
        if (this.mark("hard", error)) void hardRecover();
        return;
      }
      // The expensive recovery already failed to fix it — surface it, don't loop.
      this.giveUp(error);
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
      if (this.mark("hard", error)) void hardRecover();
      return;
    }
    if ((await probeChunk(url)) === "absent") {
      // The chunk really is gone (or the old SW is answering with the shell).
      // Only unregister + purge fixes that; a plain reload would fail again.
      if (this.mark("hard", error)) void hardRecover();
      return;
    }
    // The chunk fetches fine now ("present"), or we could not tell ("unknown" —
    // offline, aborted). Either way the build is not PROVEN to be the problem,
    // and a plain reload is the smallest thing that can work: React.lazy
    // memoises the rejection so a re-render cannot retry it, and this leaves the
    // service worker and the caches intact.
    //
    // The mark is written as `soft`, and that word is what stops this being a
    // dead end. If the failure survives the reload, recoverStep() reads the soft
    // mark and returns "escalate" — the next attempt runs the FULL recovery
    // automatically. That is the "unknown" case the probe cannot resolve: a
    // genuinely stale build behind a still-registered old worker, where the
    // earlier version of this file spent the single automatic slot on a plain
    // reload and then refused the operator, on a failure origin/main would have
    // healed on the first try.
    if (this.mark("soft", error)) defaultReload();
  }

  /** Record the attempt about to be made. False means sessionStorage refused, so
   *  we must NOT reload — an attempt we cannot remember repeats forever. The
   *  panel goes up instead, and its button is a human decision, not a loop; that
   *  is the same situation giveUp() exists to report, so it reports it. */
  private mark(kind: RecoverKind, error: Error): boolean {
    if (markHardRecover(kind)) return true;
    this.giveUp(error);
    return false;
  }

  /** Every automatic rung is spent and the failure is still here. */
  private giveUp(error: Error): void {
    console.error("[chunk-recover] stale chunk error persisted:", error?.message ?? error);
    // Report the PERSISTED case only: routine post-deploy chunk misses self-heal
    // silently and would be pure noise, but a recovery that did not stick means
    // a user is staring at the panel — IT should know.
    reportClientError(error, "stale-chunk-persisted");
    this.setState({ recovering: false });
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
   *  consults recoverStep(): when the operator is looking at the panel BECAUSE
   *  the ladder ran out, the button in front of them has to be the thing that
   *  works, not a second refusal. It still RECORDS the attempt (as `hard`, the
   *  kind it performs), so the automatic arm stays rate-limited afterwards. */
  private manualRecover(): void {
    // Full recovery, not a plain reload: a plain reload kept failing for the
    // owner because the old SW re-served the stale shell.
    markHardRecover("hard");
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
              ? "This page could not load part of the app."
              : "Something went wrong loading this page."}
          </p>
          {/* "usually", not "was": the narrow matcher proves a MODULE could not
              be fetched, which is a deploy nine times out of ten and a dead
              connection the tenth. Say the thing the evidence supports. */}
          <p className="max-w-md text-xs text-ink-muted">
            {stale
              ? "A file it needs is missing — usually because a newer version was deployed while this tab stayed open. Reload to pick it up; any unsaved changes on this page will be lost. If it keeps happening, let IT know."
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
