import React from "react";
import { useLocation } from "react-router-dom";
import { Skeleton } from "./Skeleton";
import { reportClientError } from "../lib/errorReporter";
import {
  CHUNK_PROBE_TIMEOUT_MS,
  chunkUrlFrom,
  isDeployStaleEvidence,
  isStaleChunkError,
  probeChunk,
} from "../lib/staleBuild";
import { BUILD_ID } from "../lib/buildId";

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

const RECOVER_AT_KEY = "chunk-recovered-at";
const RECOVER_COOLDOWN_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 8_000;
const RECOVER_TIMEOUT_MS = CHUNK_PROBE_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + 1_000;

/** The build this tab booted from — the same id errorReporter stamps onto every
 *  reported event, so a panel in client_errors can be read against the build
 *  that produced it. Read from index.html (lib/buildId.ts), not compiled in. */
export const CURRENT_BUILD_ID = BUILD_ID;

type RecoverKind = "soft" | "hard";
type RecoverMark = { at: number; buildId: string; kind: RecoverKind };

function readRecoverMark(): RecoverMark | null {
  const raw = sessionStorage.getItem(RECOVER_AT_KEY);
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return { at: Number(raw), buildId: CURRENT_BUILD_ID, kind: "hard" };
  try {
    const parsed = JSON.parse(raw) as Partial<RecoverMark> | null;
    const at = Number(parsed?.at ?? 0);
    if (!at) return null;
    return {
      at,
      buildId: String(parsed?.buildId ?? CURRENT_BUILD_ID),
      kind: parsed?.kind === "soft" ? "soft" : "hard",
    };
  } catch {
    return null;
  }
}

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
 * the browser's own confirm dialog and nothing below bypasses it. PaymentsTable
 * registers one, and so does LeaveGuardBridge for every form holding
 * hooks/useLeaveGuard (the main create / edit forms). A form that holds neither
 * still loses its edits with no prompt.
 */
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
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => { deadline = setTimeout(resolve, CLEANUP_TIMEOUT_MS); }),
    ]);
  } finally {
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
  staleChunk: boolean;
}

interface BoundaryProps {
  children: React.ReactNode;
  resetKey?: string;
}

export class ChunkReloadBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, recovering: false, staleChunk: false };
  private recoverTimer: number | null = null;

  static getDerivedStateFromError(error: Error): BoundaryState {
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
        void this.recoverFromStaleChunk(error);
        return;
      }
      if (step === "escalate") {
        if (this.mark("hard", error)) void hardRecover();
        return;
      }
      this.giveUp(error);
      return;
    }
    console.error("[route-crash]", error?.message ?? error, info?.componentStack ?? "");
    reportClientError(error, "route-crash");
  }

  private async recoverFromStaleChunk(error: Error): Promise<void> {
    const url = chunkUrlFrom(error);
    if (!url) {
      if (this.mark("hard", error)) void hardRecover();
      return;
    }
    if ((await probeChunk(url)) === "absent") {
      if (this.mark("hard", error)) void hardRecover();
      return;
    }
    if (this.mark("soft", error)) defaultReload();
  }

  private mark(kind: RecoverKind, error: Error): boolean {
    if (markHardRecover(kind)) return true;
    this.giveUp(error);
    return false;
  }

  private giveUp(error: Error): void {
    console.error("[chunk-recover] stale chunk error persisted:", error?.message ?? error);
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
      this.setState({ recovering: false });
    }, RECOVER_TIMEOUT_MS);
  }

  private manualRecover(): void {
    markHardRecover("hard");
    this.setState({ recovering: true });
    void hardRecover();
  }

  render() {
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
