import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { clearAll as clearApiCache } from "../api/cache";
import { cn } from "../lib/utils";

/**
 * Global refresh — replaces the DATA on screen without reloading the app.
 * It lives in the shared chrome, so one control serves every page in the
 * product (Projects, Service cases, the SCM/2990 documents); there is exactly
 * one <Layout> in App.tsx, so there is no page it does not reach.
 *
 * TWO caches sit between a page and the server, and BOTH have to be dropped,
 * in this order. api/cache.ts is a 15-second memory cache in front of every
 * api.get(): invalidating TanStack alone refetches straight back INTO it and
 * re-serves the very rows the user asked to replace — the button would appear
 * to work and change nothing for 15s. api/cache.ts says so at its own
 * clearAll(), and AuthContext.resetMemoryCaches pairs the two the same way.
 *
 * Soft, not F5. A reload refreshes too, but it discards unsaved form state and
 * re-downloads the bundle. Data is what goes stale, so data is what this
 * replaces; NewVersionBanner still owns "a new build shipped". That is also
 * why this needs no PullToRefreshGuard: the guard exists because the pull
 * gesture defaults to window.location.reload(), which destroys drafts. This
 * refetches server state and leaves local drafts standing.
 *
 * invalidateQueries (not refetchQueries) is deliberate and matches
 * lib/cross-tab-sync.ts: it refetches what is ON SCREEN and marks everything
 * else stale, so the next page you open is fresh too rather than serving a
 * cache entry from before you pressed the button.
 */
export function RefreshButton() {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  async function refreshAll() {
    if (busy) return;
    setBusy(true);
    try {
      clearApiCache();
      await queryClient.invalidateQueries({ refetchType: "active" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void refreshAll()}
      disabled={busy}
      aria-label="Refresh data"
      title="Refresh data on this page"
      className={cn(
        // Same boxed tile as PresenceButton / NotificationBell's navbar tone,
        // so the utility cluster stays one row of matching controls.
        "inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-primary/40",
        busy
          ? "border-primary bg-primary-soft text-primary-ink"
          : "border-border bg-surface text-ink-secondary hover:border-border-strong hover:bg-surface-dim",
      )}
    >
      <RefreshCw size={16} className={cn(busy && "animate-spin")} />
    </button>
  );
}
