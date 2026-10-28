import { useQuery as useTanstackQuery, keepPreviousData } from "@tanstack/react-query";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  /** A request is active, including background/placeholder transitions. */
  fetching: boolean;
  /** The visible data belongs to the previous query key. */
  placeholder: boolean;
  error: string | null;
  reload: () => void;
}

// Optional per-callsite freshness controls. Defaults mirror the global
// queryClient (refetch-on-mount when stale). Set
// `refetchOnMount: "always"` + `staleTime: 0` on a list query that must
// reflect a sibling tab's create the instant the consumer mounts.
export interface UseQueryOptions {
  refetchOnMount?: boolean | "always";
  staleTime?: number;
  // Set true on a PAGINATED / tab-switched list so changing page/tab keeps the
  // previous rows on screen while the next slice loads, instead of flashing an
  // empty table + spinner (TanStack v5's keepPreviousData behaviour). Purely
  // presentational — does not touch the query key or caching.
  keepPreviousData?: boolean;
  // When false the fetch never fires (TanStack `enabled`). Use to HARD-GATE a
  // permission-restricted query: pair it with NOT rendering the consuming
  // section so a user who lacks the permission neither renders nor fetches —
  // no 403, no fetch-then-hide flicker. Defaults to true. While disabled the
  // hook reports loading=false so the gated branch renders without a spinner.
  enabled?: boolean;
}

/**
 * The cache identity of a callsite. A string for the common case, or an array
 * when a callsite wants to compose one (e.g. `["assr-list", scope]`).
 *
 * Convention — mirror what the app's direct TanStack callsites already do
 * (see mobile/sharedInvalidate.ts): a stable, human-readable ROOT that names
 * the subject. Most keys here are the endpoint's url shape (`/api/projects/
 * brands`), with a `#suffix` when two callsites hit the same url but want
 * different results (`/api/users` vs `/api/users#unwrapped`).
 */
export type UseQueryKey = string | ReadonlyArray<string | number | boolean>;

/**
 * Build the TanStack key. Exported for the unit test — the whole point of this
 * function is a property that is invisible at any single callsite.
 *
 * Still namespaced under "uq" so these can never collide with the named roots
 * the direct-TanStack callsites use (["grns-paged", ...] and friends).
 */
export function buildQueryKey(
  key: UseQueryKey,
  deps: ReadonlyArray<unknown> = [],
): unknown[] {
  return ["uq", ...(typeof key === "string" ? [key] : key), ...deps];
}

/**
 * Backed by TanStack Query (see lib/queryClient.ts) — caching, request dedup
 * and cache-while-revalidate.
 *
 * `key` IDENTIFIES THE CALLSITE and is required. It used to be derived from
 * `fetcher.toString()`, which is a correctness bug, not a style one: two
 * callsites whose fetcher bodies happen to be textually identical silently
 * SHARE one cache entry, so one screen can render another's data. That is not
 * hypothetical — 50 of the 126 callsites in this app had a textual twin. They
 * survived only because every twin happened to hit the same endpoint and want
 * the same shape; the first pair that didn't would have cross-fed data with
 * nothing in the diff to suggest it. Minification makes it worse, not better:
 * the bundler collapses whitespace, so two bodies that differ only in
 * formatting are distinct in dev and identical in production.
 *
 * Two callsites SHOULD share a key when they want the same data — that is
 * request dedup and it is the reason the mail-center and projects lookups are
 * cheap. They must NOT share one when the result differs in shape or in error
 * behaviour, because only ONE queryFn runs per key.
 *
 * Callsites must still keep their dynamic values in `deps` — the key names the
 * QUESTION, the deps supply its PARAMETERS.
 */
export function useQuery<T>(
  key: UseQueryKey,
  fetcher: (signal?: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  options: UseQueryOptions = {},
): QueryState<T> {
  const enabled = options.enabled ?? true;
  const q = useTanstackQuery<T>({
    queryKey: buildQueryKey(key, deps),
    queryFn: ({ signal }) => fetcher(signal),
    enabled,
    ...(options.refetchOnMount !== undefined && {
      refetchOnMount: options.refetchOnMount,
    }),
    ...(options.staleTime !== undefined && { staleTime: options.staleTime }),
    // keepPreviousData: hold the last successful data while the next key's
    // fetch is in flight, so a page/tab switch never blanks the list.
    ...(options.keepPreviousData && { placeholderData: keepPreviousData }),
  });
  return {
    data: q.data ?? null,
    // A disabled query stays `isPending` in TanStack v5 (status pending,
    // fetchStatus idle). Report loading=false so a hard-gated consumer renders
    // its hidden/empty branch instead of a permanent spinner.
    //
    // NOTE for direct TanStack callsites: use `isPending`, NOT `isLoading`.
    // isLoading is (isPending && isFetching), so it is FALSE while a query is
    // pending but not actively fetching — i.e. disabled, or PAUSED because the
    // device is offline. A gate written `if (isLoading) <spinner>; if (error ||
    // !data) <error>` therefore paints its ERROR branch on a flaky connection
    // before the fetch ever runs, then swaps to content when it resolves — the
    // "error first, then it loads" class of bug. This wrapper already uses
    // isPending for exactly that reason.
    loading: enabled ? q.isPending : false,
    fetching: enabled ? q.isFetching : false,
    placeholder: enabled ? q.isPlaceholderData : false,
    error: q.error ? (q.error as Error).message || String(q.error) : null,
    reload: () => {
      void q.refetch();
    },
  };
}
