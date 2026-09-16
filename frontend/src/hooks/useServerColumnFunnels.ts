// ----------------------------------------------------------------------------
// useServerColumnFunnels — lift DataTable's reported column funnels into a
// server-side list filter (owner 2026-09-16).
//
// A column funnel is client-side, so on a server-paged list it only ever saw the
// loaded page. The SCM list pages push their SERVER-FILTERABLE funnels (Customer/
// Creditor Name, Currency, …) into the list query so pagination runs over the
// filtered set; the grid still owns and applies every funnel client-side on the
// page (line-level / MRP funnels stay page-local). Each page passes a `map` that
// picks its server-filterable columns out of the funnel state.
//
// `onChange` fires when the server filter actually changes AFTER mount — the
// page resets to page 1 there. The first (mount-restore) report adopts the
// funnel WITHOUT resetting, so a deep-linked ?page= survives a refresh (mirrors
// the sort sync the list pages already do).
// ----------------------------------------------------------------------------

import { useRef, useState } from 'react';

export type ColFilters = Record<string, string[] | undefined>;

/** From a funnel state, the values ticked on one column, or undefined if none. */
export function funnelValues(colFilters: ColFilters, key: string): string[] | undefined {
  const v = colFilters[key];
  return v && v.length > 0 ? v : undefined;
}

export function useServerColumnFunnels<F extends Record<string, string[] | undefined>>(
  map: (colFilters: ColFilters) => F,
  onChange: () => void,
): { serverFunnels: F; onColFiltersChange: (colFilters: ColFilters) => void } {
  const [serverFunnels, setServerFunnels] = useState<F>(() => map({}));
  const syncedRef = useRef(false);
  const sigRef = useRef('');
  const onColFiltersChange = (colFilters: ColFilters) => {
    const next = map(colFilters);
    const sig = JSON.stringify(next);
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setServerFunnels(next);
    if (!syncedRef.current) { syncedRef.current = true; return; }
    onChange();
  };
  return { serverFunnels, onColFiltersChange };
}
