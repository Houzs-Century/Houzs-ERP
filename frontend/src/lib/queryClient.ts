import { QueryClient, MutationCache } from "@tanstack/react-query";
import { installCrossTabSync, mutationSucceeded, mutationSettled } from "./cross-tab-sync";
import { installQueryPersist } from "./query-persist";
import { invalidate as invalidateReadCache, onApiWrite } from "../api/cache";

export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return status === 408 || status === 429;
  }
  return true;
}

export function isPagedListKey(key: readonly unknown[]): boolean {
  return typeof key[0] === "string" && key[0].endsWith("-paged");
}

export const queryClient = new QueryClient({
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

installCrossTabSync(queryClient);

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

installQueryPersist(queryClient);
