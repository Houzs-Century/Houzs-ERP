import { useState, useSyncExternalStore } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { useVersionCheck } from "../hooks/useVersionCheck";
import { chunkFailureSnapshot, subscribeChunkFailure } from "../lib/staleBuild";
import { runBeforeManualReload } from "../lib/beforeManualReload";

/**
 * NewVersionBanner — a non-blocking "this tab is behind the deploy" prompt.
 *
 * It has TWO triggers, and they are not the same event:
 *   • useVersionCheck — a poll noticed a newer build is live. Nothing has broken
 *     yet; this is the pre-warning.
 *   • lib/staleBuild — a dynamic import ALREADY failed. Something the operator
 *     clicked did not work, and every one of the 55 `await import()` handlers
 *     (print a PO, export a grid) fails silently into a toast with no way out
 *     but this. See that file's header for why one listener covers all of them.
 * The second one gets stronger copy, because the operator is not being offered
 * an upgrade — they are being told why the button they pressed did nothing.
 *
 * MOUNTED ONCE, in main.tsx's RootApp, NOT in App.tsx. AuthGate renders
 * MobileApp INSTEAD of App, so a mount inside App() reached the desktop shell
 * only and every mobile screen got no warning at all — half the product, and the
 * half used in the field. Mounting beside AuthGate covers both surfaces from one
 * site. It stays OUTSIDE the public surfaces (survey, portal, reset) on purpose:
 * those are single-screen flows, and there is no reason to poll on them.
 *
 * This banner never reloads from under the operator — they click when they're
 * ready, so a deploy mid-data-entry can't wipe their work. (The one automatic
 * reload in this area is lib/chunkActionRecovery.ts, for a PRINT with no unsaved
 * work on screen; when it declines, this banner is what the operator gets, and
 * its button reopens that print after the reload.) Clicking enters a brief loading
 * state (spinning icon) so a double-click can't fire two reloads.
 *
 * useLocation is read HERE and not in App(): App creates the element tree for
 * 137 lazy routes on every render, and subscribing it to the location would
 * re-run all of that on every navigation. This banner is a leaf, so the
 * subscription costs one re-render of one pill. On mobile the pathname never
 * changes (MobileApp holds `tab`/`screen` in useState and deliberately keeps
 * them out of the URL), so there the navigation check simply never fires and the
 * 60s poll is the whole mechanism — which is what it was everywhere before.
 */
export function NewVersionBanner() {
  const { pathname } = useLocation();
  const { updateReady } = useVersionCheck({ routeKey: pathname });
  const chunkFailed = useSyncExternalStore(
    subscribeChunkFailure,
    chunkFailureSnapshot,
    chunkFailureSnapshot,
  );
  const [reloading, setReloading] = useState(false);
  if (!updateReady && !chunkFailed) return null;

  const reload = () => {
    setReloading(true);
    if (chunkFailed) runBeforeManualReload();
    window.location.reload();
  };

  return (
    <div
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+90px)] left-1/2 z-[100] flex w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-3 rounded-2xl bg-ink px-4 py-2.5 text-[12.5px] text-white shadow-slab sm:w-auto sm:rounded-full sm:pl-[18px] sm:pr-3 lg:bottom-6"
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      <span className="min-w-0 leading-snug">
        {chunkFailed ? "This tab is on an older version" : "A newer version is ready"}
        <span className="ml-1.5 text-ink-muted">
          {chunkFailed ? "· refresh to finish that action" : "· refresh to update"}
        </span>
      </span>
      <button
        type="button"
        onClick={reload}
        disabled={reloading}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-white hover:bg-primary-ink disabled:opacity-80"
      >
        <RefreshCw size={14} strokeWidth={2} className={reloading ? "animate-spin" : ""} />
        {reloading ? "Refreshing…" : "Refresh now"}
      </button>
    </div>
  );
}
