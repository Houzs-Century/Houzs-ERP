import { useState } from "react";
import { useLocation } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { useVersionCheck } from "../hooks/useVersionCheck";

/**
 * NewVersionBanner — a non-blocking "a newer version is ready" prompt.
 *
 * Mounted ONCE near the app root. When useVersionCheck detects that a newer
 * build is live, it shows a small bottom-centre pill with a "刷新" button.
 * We never reload from under the operator — they click when they're ready, so
 * a deploy mid-data-entry can't wipe their work. Clicking enters a brief
 * loading state (spinning icon) so a double-click can't fire two reloads.
 *
 * useLocation is read HERE and not in App(): App creates the element tree for
 * 137 lazy routes on every render, and subscribing it to the location would
 * re-run all of that on every navigation. This banner is a leaf, so the
 * subscription costs one re-render of one pill.
 */
export function NewVersionBanner() {
  const { pathname } = useLocation();
  const { updateReady } = useVersionCheck({ routeKey: pathname });
  const [reloading, setReloading] = useState(false);
  if (!updateReady) return null;

  const reload = () => {
    setReloading(true);
    window.location.reload();
  };

  return (
    <div
      className="fixed bottom-3 left-1/2 z-[100] flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full bg-ink py-2.5 pl-[18px] pr-3 text-[12.5px] text-white shadow-slab sm:bottom-6"
      role="status"
      aria-live="polite"
    >
      {/* breathing petrol dot */}
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
      </span>
      <span className="truncate">
        A newer version is ready
        <span className="ml-1.5 text-ink-muted">· refresh to update</span>
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
