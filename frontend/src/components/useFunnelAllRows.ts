// ----------------------------------------------------------------------------
// useFunnelAllRows — widen DataTable's client-side column funnels from the
// loaded page to the WHOLE filtered set (owner 2026-09-16).
//
// A column funnel is client-side, so on a server-paged list it only ever saw
// the rows on the current page: funnelling e.g. Creditor Name hid rows on THIS
// page and left every match on later pages unreached, and the funnel checklist
// listed only values that happened to be loaded. When a caller wires
// `funnelAllRows` and a funnel is active, this hook fetches every row the server
// filters match (all pages — the same read the line export uses) and hands that
// set back as the funnels' base; DataTable already row-windows, so the DOM stays
// bounded and no client pager is needed.
//
// Keyed on the server-filter `signature` (tab + search + sort): ticking values
// re-filters the held set client-side without refetching, and only a tab/search/
// sort change refetches. `fetchedSigRef` holds the signature we have or are
// fetching, so the inline config object being new each render does not re-fire
// the read.
// ----------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';

/** Reported by `onScopeChange`. `active` = a funnel is widening to the whole
 *  filtered set (the page hides its server pager); `loading` = that set is still
 *  in flight (the loaded page shows meanwhile). `null` = page-local funnels. */
export type FunnelAllRowsScope = { active: boolean; loading: boolean };

export type FunnelAllRowsConfig<T> = {
  fetchRows: (need: { exportKeys: string[]; filterKeys: string[] }) => Promise<T[]>;
  signature: string;
  onScopeChange: (scope: FunnelAllRowsScope | null) => void;
  onError: (error: Error) => void;
};

/**
 * The rows the funnels should run over: the whole matching set once it has
 * arrived, else `pageRows` (the loaded page — so funnels stay page-local until
 * the set lands, and always when the feature is not wired). `wanted` is "a
 * funnel is active and the feature is on"; `funnelKeys` are the active funnel
 * column keys, passed to the fetch so it can enrich the columns being funnelled.
 */
export function useFunnelAllRows<T>(
  pageRows: T[] | null | undefined,
  wanted: boolean,
  funnelKeys: string[],
  config: FunnelAllRowsConfig<T> | undefined,
): T[] | null | undefined {
  const [held, setHeld] = useState<{ signature: string; rows: T[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedSigRef = useRef<string | null>(null);
  // Latest funnel keys without making them refetch: the held set is the same
  // regardless of which values (or columns) are ticked.
  const keysRef = useRef(funnelKeys);
  keysRef.current = funnelKeys;

  useEffect(() => {
    if (!config || !wanted) {
      fetchedSigRef.current = null;
      setHeld((cur) => (cur === null ? cur : null));
      setLoading((l) => (l ? false : l));
      return;
    }
    const { signature, fetchRows, onError } = config;
    if (fetchedSigRef.current === signature) return; // held or already in flight
    fetchedSigRef.current = signature;
    const filterKeys = keysRef.current;
    let cancelled = false;
    setLoading(true);
    fetchRows({ exportKeys: filterKeys, filterKeys })
      .then((rows) => { if (!cancelled) setHeld({ signature, rows }); })
      .catch((e) => {
        if (cancelled) return;
        // A failed read (incl. "too many to hold") reverts to page-local funnels
        // rather than showing a set that looks complete but is not.
        fetchedSigRef.current = null;
        setHeld(null);
        onError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [config, wanted]);

  const ready = wanted && held !== null && held.signature === (config?.signature ?? null);

  // Tell the caller whether to hide its server pager while a scope is active.
  const onScopeChange = config?.onScopeChange;
  useEffect(() => {
    if (!onScopeChange) return;
    onScopeChange(wanted ? { active: true, loading: !ready || loading } : null);
  }, [onScopeChange, wanted, ready, loading]);

  return ready ? held.rows : pageRows;
}
