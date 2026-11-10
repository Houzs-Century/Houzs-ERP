/* The deferred MRP enrichment fetch every list shares (PO, GRN, PI, SO; desktop
   and mobile). Fired AFTER the list renders, for the ids it just showed. Ids are
   sorted (stable cache keys under a re-sort) and chunked so a request stays
   bounded however far mobile scrolls; each chunk is cached on its own.

   The backend answers from the 15-min stored MRP snapshot and says so in `mrp`
   (backend/src/scm/lib/list-mrp-source.ts). Refresh re-fetches every chunk with
   `&refresh=1`; the server turns those into ONE live computation (rate-limited
   to one per minute and shared), so clicking twice does not compute twice. */
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';
import {
  combineListMrpMeta, withListMrpRefresh, type ListMrpMeta, type ListMrpStatus,
} from '../../../lib/listMrpStatus';

export function useListMrpEnrichmentChunks<E>(opts: {
  ids: string[];
  enabled: boolean;
  queryKeyPrefix: string;
  /** e.g. `/mfg-purchase-orders/list-mrp-enrichment?poIds=` */
  urlPrefix: string;
  chunkSize: number;
}): { byId: Map<string, E>; isFetching: boolean; mrp: ListMrpStatus } {
  const { ids, enabled, queryKeyPrefix, urlPrefix, chunkSize } = opts;
  const chunks = useMemo(() => {
    const uniq = [...new Set(ids.filter(Boolean))].sort();
    const out: string[][] = [];
    for (let i = 0; i < uniq.length; i += chunkSize) out.push(uniq.slice(i, i + chunkSize));
    return out;
  }, [ids, chunkSize]);

  const refreshRef = useRef(false);
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      enabled: enabled && chunk.length > 0,
      queryKey: [queryKeyPrefix, chunk.join(',')],
      queryFn: ({ signal }: { signal?: AbortSignal }) =>
        authedFetch<{ enrichment: Record<string, E>; mrp?: ListMrpMeta }>(
          withListMrpRefresh(`${urlPrefix}${encodeURIComponent(chunk.join(','))}`, refreshRef.current),
          { signal },
        ),
      staleTime: 30_000,
      retry: retryUnlessClientError,
      retryDelay: 800,
    })),
  });

  // Rebuild only when a chunk's data actually changes, not on every render.
  const sig = results.map((r) => r.dataUpdatedAt).join('|');
  const isFetching = results.some((r) => r.isFetching);
  const { byId, meta } = useMemo(() => {
    const map = new Map<string, E>();
    for (const r of results) {
      const e = r.data?.enrichment;
      if (e) for (const [k, v] of Object.entries(e)) map.set(k, v);
    }
    return { byId: map, meta: combineListMrpMeta(results.map((r) => r.data?.mrp)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `results` is read through its `sig` (per-chunk dataUpdatedAt); depending on the array itself would rebuild every render.
  }, [sig]);

  const qc = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    if (refreshRef.current) return;
    refreshRef.current = true;
    setRefreshing(true);
    void qc.refetchQueries({ queryKey: [queryKeyPrefix], type: 'active' }).finally(() => {
      refreshRef.current = false;
      setRefreshing(false);
    });
  }, [qc, queryKeyPrefix]);

  const mrp = useMemo(() => ({ meta, refresh, refreshing }), [meta, refresh, refreshing]);
  return { byId, isFetching, mrp };
}
