
import { useEffect } from "react";
import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { queryClient as appQueryClient } from "./queryClient";

/** How often due keys are looked for. A tick that finds nothing due costs nothing. */
export const POLL_TICK_MS = 10_000;
/** Coming back to the tab refetches anything at least this old (rapid alt-tab costs nothing). */
export const RETURN_REFRESH_MIN_AGE_MS = 15_000;

interface Entry {
  key: QueryKey;
  client: QueryClient;
  intervals: number[];
}

const entries = new Map<string, Entry>();
let ticker: ReturnType<typeof setInterval> | undefined;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function refreshIfOlderThan(e: Entry, minAgeMs: number, now: number): void {
  const state = e.client.getQueryState(e.key);
  if (state?.fetchStatus === "fetching") return;
  const settledAt = state ? Math.max(state.dataUpdatedAt, state.errorUpdatedAt) : 0;
  if (now - settledAt < minAgeMs) return;
  void e.client.refetchQueries({ queryKey: e.key, exact: true, type: "active" });
}

/** Exported for tests. */
export function pollTick(now: number = Date.now()): void {
  if (isHidden()) return;
  for (const e of entries.values()) refreshIfOlderThan(e, Math.min(...e.intervals), now);
}

/** Exported for tests. */
export function onPollVisibilityChange(now: number = Date.now()): void {
  if (isHidden()) return;
  for (const e of entries.values()) {
    refreshIfOlderThan(e, Math.min(RETURN_REFRESH_MIN_AGE_MS, ...e.intervals), now);
  }
}

function start(): void {
  if (ticker !== undefined) return;
  ticker = setInterval(() => pollTick(), POLL_TICK_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }
}

function stop(): void {
  if (ticker === undefined) return;
  clearInterval(ticker);
  ticker = undefined;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibility);
  }
}

function onVisibility(): void {
  onPollVisibilityChange();
}

/** Register a key for visible-only polling. Returns the unregister function. */
export function registerVisiblePoll(
  key: QueryKey,
  intervalMs: number,
  client: QueryClient = appQueryClient,
): () => void {
  const id = hashKey(key);
  let entry = entries.get(id);
  if (!entry) {
    entry = { key, client, intervals: [] };
    entries.set(id, entry);
  }
  entry.intervals.push(intervalMs);
  start();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const e = entries.get(id);
    if (!e) return;
    const i = e.intervals.indexOf(intervalMs);
    if (i >= 0) e.intervals.splice(i, 1);
    if (e.intervals.length === 0) entries.delete(id);
    if (entries.size === 0) stop();
  };
}

/**
 * Keep `queryKey` fresh every `intervalMs` while the tab is visible. The query
 * itself must NOT set `refetchInterval` (that would bring back the per-reader
 * timers). `intervalMs: false` or `enabled: false` registers nothing.
 */
export function useVisiblePoll(
  queryKey: QueryKey,
  intervalMs: number | false,
  enabled: boolean,
  client: QueryClient = appQueryClient,
): void {
  const id = hashKey(queryKey);
  useEffect(() => {
    if (!enabled || intervalMs === false) return;
    return registerVisiblePoll(queryKey, intervalMs, client);
  }, [id, intervalMs, enabled, client]);
}

/** Test helper: forget every registration. */
export function resetVisiblePollForTests(): void {
  entries.clear();
  stop();
}
