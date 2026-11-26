import { useQuery as useTanstackQuery, keepPreviousData } from "@tanstack/react-query";

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  fetching: boolean;
  placeholder: boolean;
  error: string | null;
  reload: () => void;
}

export interface UseQueryOptions {
  refetchOnMount?: boolean | "always";
  staleTime?: number;
  keepPreviousData?: boolean;
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
    ...(options.keepPreviousData && { placeholderData: keepPreviousData }),
  });
  return {
    data: q.data ?? null,
    // !data) <error>` therefore paints its ERROR branch on a flaky connection
    loading: enabled ? q.isPending : false,
    fetching: enabled ? q.isFetching : false,
    placeholder: enabled ? q.isPlaceholderData : false,
    error: q.error ? (q.error as Error).message || String(q.error) : null,
    reload: () => {
      void q.refetch();
    },
  };
}
