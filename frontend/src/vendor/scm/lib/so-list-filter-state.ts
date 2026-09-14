// The Sales Order list's second-level filters as state — the ONE logic layer
// behind the phone "Filter" sheet (mobile/MobileSoFilterSheet.tsx) and the
// desktop filter bar (pages/scm-v2/SoListFilterBar.tsx). Those two files differ
// only in how they draw; everything that decides WHAT is filtered lives here or
// in the shared model (../../shared/so-list-filter-model.ts, byte-identical to
// the backend parser).
//
// URL is state (CLAUDE.md): the applied rows are repeated `f` params and the
// first-level status is `status`, so a filtered view survives a refresh and can
// be shared. A half-built row never reaches the URL or the API — the server
// would refuse it, and an empty "Name contains" is not a filter.

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { useDebouncedValue } from './hooks';
import {
  parseSoListFilters,
  serializeSoListFilters,
  soFilterDefaultRow,
  soFilterIsComplete,
  SO_FILTER_MAX_ROWS,
  SO_FILTER_PARAM,
  type SoFilterFieldKey,
  type SoListFilter,
} from '../../shared/so-list-filter-model';

export function readSoListFilters(params: URLSearchParams): SoListFilter[] {
  return parseSoListFilters(params.getAll(SO_FILTER_PARAM)).filters;
}

/** A copy of `params` carrying exactly `filters` (complete rows only), with the
 *  page index dropped — a filter change always starts again at page 1. */
export function writeSoListFilters(params: URLSearchParams, filters: readonly SoListFilter[]): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(SO_FILTER_PARAM);
  next.delete('page');
  appendSoListFilterParams(next, filters);
  return next;
}

export function appendSoListFilterParams(usp: URLSearchParams, filters: readonly SoListFilter[]): void {
  for (const s of serializeSoListFilters(filters.filter(soFilterIsComplete))) usp.append(SO_FILTER_PARAM, s);
}

export function draftAdd(draft: readonly SoListFilter[], field: SoFilterFieldKey): SoListFilter[] {
  return draft.length >= SO_FILTER_MAX_ROWS ? [...draft] : [...draft, soFilterDefaultRow(field)];
}
export function draftChangeField(draft: readonly SoListFilter[], index: number, field: SoFilterFieldKey): SoListFilter[] {
  return draft.map((r, i) => (i === index ? soFilterDefaultRow(field) : r));
}
export function draftUpdate(draft: readonly SoListFilter[], index: number, patch: Partial<Pick<SoListFilter, 'op' | 'value'>>): SoListFilter[] {
  return draft.map((r, i) => (i === index ? { ...r, ...patch } : r));
}
export function draftRemove(draft: readonly SoListFilter[], index: number): SoListFilter[] {
  return draft.filter((_, i) => i !== index);
}

/** The applied first-level status and second-level rows, read from and written
 *  to the URL. `status` is the lowercase tab key ('all' when absent). */
export function useSoListFilters() {
  const [params, setParams] = useSearchParams();
  const key = params.getAll(SO_FILTER_PARAM).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the serialised rows so an unrelated param change keeps the same array
  const filters = useMemo(() => readSoListFilters(params), [key]);
  const status = params.get('status') ?? 'all';

  const apply = useCallback((next: { status?: string; filters: readonly SoListFilter[] }) => {
    setParams((cur) => {
      const out = writeSoListFilters(cur, next.filters);
      if (next.status !== undefined) {
        if (next.status === 'all') out.delete('status');
        else out.set('status', next.status);
      }
      return out;
    }, { replace: true });
  }, [setParams]);

  const clear = useCallback(() => {
    setParams((cur) => {
      const out = writeSoListFilters(cur, []);
      out.delete('status');
      return out;
    }, { replace: true });
  }, [setParams]);

  return { filters, status, apply, clear };
}

/** "Apply · N orders": the order count the DRAFT would produce, from the same
 *  list endpoint and the same server-side filters, one row requested. */
export function useSoListCountPreview(args: {
  status: string;
  q: string;
  filters: readonly SoListFilter[];
  enabled: boolean;
  debounceMs?: number;
}): { count: number | undefined; isFetching: boolean } {
  const usp = new URLSearchParams();
  usp.set('page', '0');
  usp.set('pageSize', '1');
  if (args.status && args.status !== 'all') usp.set('status', args.status.toUpperCase());
  if (args.q.trim()) usp.set('q', args.q.trim());
  appendSoListFilterParams(usp, args.filters);
  const qs = useDebouncedValue(usp.toString(), args.debounceMs ?? 350);
  const res = useQuery({
    queryKey: ['mfg-sales-orders-paged', 'count-preview', qs],
    queryFn: ({ signal }) => authedFetch<{ total?: number }>(`/mfg-sales-orders?${qs}`, { signal }),
    enabled: args.enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  return { count: res.data?.total, isFetching: res.isFetching };
}
