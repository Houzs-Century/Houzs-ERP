// TanStack Query client. The custom useQuery hook (hooks/useQuery.ts) runs on
// top of this, so every existing data call gets caching + request dedup +
// cache-while-revalidate with no callsite changes.
//
// PERF: the global staleTime was 0, so EVERY query that doesn't set its own
// refetched from scratch on every mount / navigation — the main reason heavy
// pages (Service cases, Projects, Team, dashboards) showed a full-load spinner
// each time you came back to them. A modest 30s staleTime lets a revisited page
// serve its cached snapshot instantly and only revalidate once the data is
// older than that. This is SAFE because reads-after-writes stay fresh: every
// mutation calls invalidateQueries (same tab) and the keys it invalidated are
// broadcast → invalidateQueries on those keys (other tabs), and invalidation ignores staleTime and forces
// an active refetch. Queries that must always be live (role/permission lists,
// see pages/Team.tsx) already override with staleTime:0 + refetchOnMount:"always",
// and /api/auth/* is never cached (see api/cache.ts NEVER_CACHE).
//
// gcTime keeps a page's cached data in memory after it unmounts so re-opening it
// is instant (cache-while-revalidate: cached rows show immediately, a background
// refetch replaces them if stale — NO loading spinner). Measured: a warm revisit
// of the SCM SO/PO lists already refetches=false, skeleton=false. Bumped 5min →
// 30min so that "instant re-open" window covers a whole work session, not just a
// quick there-and-back — the SCM doc lists (SO/PO/DO/SI/GRN) were showing a
// full-load spinner whenever a revisit fell outside the old 5-min window. It does
// NOT survive a full page reload / PWA reopen (in-memory only); a localStorage
// snapshot layer for cold-open instancy is the tracked follow-up. refetchOnWindow-
// Focus stays off. Callsites with their own staleTime (SCM + mobile) are
// unaffected — an explicit option always wins over these defaults.
import { QueryClient, MutationCache } from "@tanstack/react-query";
import { installCrossTabSync, mutationSucceeded, mutationSettled } from "./cross-tab-sync";
import { installQueryPersist } from "./query-persist";
import { invalidate as invalidateReadCache, onApiWrite } from "../api/cache";

/* Retry policy — one retry, EXCEPT for a 4xx (2026-07-19, fix/so-maintenance-403).
   The bare `retry: 1` re-sent every failure once, including authorization
   failures: the owner's DevTools showed /inventory/warehouses,
   /delivery-planning-regions and .../states each 403 TWICE on one page load. A
   403 is a decision, not a blip — the second call cannot succeed, so it is pure
   latency for the operator (the error banner arrives a retry-delay late) and
   double load on the Worker. On a bad day it is worse than pointless: an outage
   that 4xxs broadly doubles its own request volume.

   Both error shapes in this app carry `.status` — api/client.ts's HttpError and
   the SCM authedFetch error — so ONE predicate covers every query. Anything
   without a numeric status (network drop, timeout, thrown string) keeps the
   single retry it has today; 5xx keeps it too, because that genuinely can
   self-heal (Hyperdrive cold start). Only 400-499 is dropped, and 408/429 are
   deliberately kept: a request timeout and a rate-limit are both "try again". */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status === 408 || status === 429;
  }
  return true;
}

/* The paged document lists ('grns-paged', 'purchase-invoices-paged', ...) are siblings of their root key, not under
   it, so a row action that refreshed only ['grns'] left the list row showing its old status until the page was
   reopened. Any successful write marks every paged list stale; only the one on screen refetches. */
export function isPagedListKey(key: readonly unknown[]): boolean {
  return typeof key[0] === "string" && key[0].endsWith("-paged");
}

export const queryClient = new QueryClient({
  // Cross-tab sync: every successful write tells other open tabs which query
  // keys it invalidated. One central hook in the MutationCache, so no
  // per-mutation wiring is needed.
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      mutationSucceeded(mutation);
      void queryClient.invalidateQueries({ predicate: (q) => isPagedListKey(q.queryKey) });
    },
    onSettled: (_data, _error, _vars, _ctx, mutation) => {
      mutationSettled(mutation);
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 30 * 60_000,
      refetchOnWindowFocus: false,
      retry: retryUnlessClientError,
    },
  },
});

// Listen for other tabs' writes and invalidate our active queries.
installCrossTabSync(queryClient);

/* A write through api.post/patch/put/del (not a useMutation) cleared only the 15 s read cache of its own resource:
   a list read through hooks/useQuery kept its old rows until it went stale (30 s), and a read of another resource
   (a project archived through /api/projects, read back elsewhere) kept its read cache too. Any such write now drops
   the read cache and marks every hooks/useQuery read stale; only what is on screen refetches. Writes on a timer or
   on mount that change nothing anyone is reading are left out, or every screen would refetch on each one. */
const QUIET_WRITES = [
  /^\/api\/presence/,
  /^\/api\/projects\/[^/]+\/read(\?|$)/,
  /^\/api\/mail-center\/threads\/[^/]+\/replying(\?|$)/,
];
export function isQuietWrite(path: string): boolean {
  return QUIET_WRITES.some((r) => r.test(path));
}
onApiWrite((path) => {
  if (isQuietWrite(path)) return;
  invalidateReadCache("/api");
  void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === "uq" });
});

// Persist the SCM document-list queries to localStorage so a COLD open (fresh
// session / full reload / PWA reopen) renders the last-known list instantly and
// revalidates in the background — no full-load spinner. Runs at module init so
// the cache is seeded before the first render. See query-persist.ts.
installQueryPersist(queryClient);
