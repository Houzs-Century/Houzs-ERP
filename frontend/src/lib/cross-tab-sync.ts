// ---------------------------------------------------------------------------
// Cross-tab data sync (adapted from 2990's cross-tab invalidation bus, itself
// ported from HOOKKA, to TanStack Query). One tab's successful WRITE tells the
// other open tabs to refetch, so a price / stock / status change made in tab A
// shows up in tab B without a manual refresh.
//
// Deliberately coarse: we broadcast a single "data changed" signal and the
// receiving tab invalidates its ACTIVE queries. staleTime still gates the
// actual network refetch, so this can't cause a refetch storm. BroadcastChannel
// is same-origin only and never delivers a message back to the tab that sent
// it, so the writing tab (which already invalidated via its own onSuccess) is
// untouched.
// ---------------------------------------------------------------------------

import type { QueryClient } from "@tanstack/react-query";

const CHANNEL = "houzs-scm-data-sync";

let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null; // very old browsers
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  return channel;
}

/** Tell other tabs that something was written here. Called once from the global
    MutationCache onSuccess so EVERY successful mutation propagates — no per-hook
    wiring needed. */
export function broadcastDataChanged(): void {
  try {
    getChannel()?.postMessage({ t: "changed" });
  } catch {
    /* best-effort */
  }
}

/** Listen for other tabs' writes and invalidate so open lists/details refetch.
    Call once at startup with the app's QueryClient. */
export function installCrossTabSync(qc: QueryClient): void {
  const ch = getChannel();
  if (!ch) return;
  ch.onmessage = (e: MessageEvent) => {
    if ((e.data as { t?: string } | null)?.t === "changed") {
      // Invalidate everything but only refetch what's on screen (active);
      // background queries just get marked stale for their next mount.
      void qc.invalidateQueries({ refetchType: "active" });
    }
  };
}
