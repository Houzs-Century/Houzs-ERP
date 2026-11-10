// ---------------------------------------------------------------------------
// Cross-tab data sync (adapted from 2990's cross-tab invalidation bus, itself
// ported from HOOKKA, to TanStack Query). One tab's successful WRITE tells the
// other open tabs to refetch, so a price / stock / status change made in tab A
// shows up in tab B without a manual refresh.
//
// Deliberately coarse: we broadcast a single "data changed" signal and the
// receiving tab invalidates its ACTIVE queries. Invalidation does NOT wait for
// staleTime, so a hidden tab defers its refetch until it is shown (below). BroadcastChannel
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

/* A HIDDEN TAB DOES NOT REFETCH. Invalidation ignores staleTime, so every write
   in any tab used to re-read every on-screen query of every other tab, hidden
   or not: a background Merchant Recon tab re-read each of its reports (one
   heavy request per report) on every save made elsewhere. Hidden, a message
   only marks the queries stale; the first time the tab is shown again it
   re-reads once, however many writes it missed. */
function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Listen for other tabs' writes and invalidate so open lists/details refetch.
    Call once at startup with the app's QueryClient. */
export function installCrossTabSync(qc: QueryClient): void {
  const ch = getChannel();
  if (ch) listenForWrites(qc, ch);
}

/** The listener itself, on a given channel; returns the uninstaller. */
export function listenForWrites(qc: QueryClient, ch: BroadcastChannel): () => void {
  let missedWhileHidden = false;
  ch.onmessage = (e: MessageEvent) => {
    if ((e.data as { t?: string } | null)?.t !== "changed") return;
    if (isHidden()) {
      missedWhileHidden = true;
      void qc.invalidateQueries({ refetchType: "none" });
      return;
    }
    // Invalidate everything but only refetch what's on screen (active);
    // background queries just get marked stale for their next mount.
    void qc.invalidateQueries({ refetchType: "active" });
  };
  const onVisible = () => {
    if (isHidden() || !missedWhileHidden) return;
    missedWhileHidden = false;
    void qc.invalidateQueries({ refetchType: "active" });
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    ch.onmessage = null;
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}
