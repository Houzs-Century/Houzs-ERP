// Vendored SLICE of apps/backend/src/lib/flow-queries.ts — the Outstanding
// surface (the unified outstanding filter across all 8 modules) the
// Outstanding page reads. Copied verbatim; all reads go through the vendored
// authedFetch (→ /api/scm/outstanding…). The `baseQuery` factory is inlined.

import { useQuery } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

// baseQuery is a custom-hook factory — only ever called from use* hooks below.
// eslint-disable-next-line react-hooks/rules-of-hooks
const baseQuery = <T>(key: string[], path: string) => useQuery({
  queryKey: key,
  queryFn: () => authedFetch<T>(path),
  staleTime: 30_000,
  retry: retryUnlessClientError,
  retryDelay: 800,
});

export type OutstandingModule =
  | 'po' | 'grn' | 'pi' | 'pr' | 'so' | 'do' | 'si';

export type OutstandingFilterMode = 'outstanding' | 'completed' | 'all';

export type OutstandingRow = Record<string, unknown> & {
  is_outstanding: boolean;
};

export const useOutstanding = (
  module: OutstandingModule,
  opts?: { mode?: OutstandingFilterMode; from?: string; to?: string },
) => {
  const params = new URLSearchParams();
  const outstanding = opts?.mode === 'completed' ? 'false'
                    : opts?.mode === 'all' ? 'all'
                    : 'true';
  params.set('outstanding', outstanding);
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to)   params.set('to',   opts.to);
  return baseQuery<{ rows: OutstandingRow[] }>(
    ['outstanding', module, params.toString()],
    `/outstanding/${module}?${params.toString()}`,
  );
};

export type OutstandingSummary = Record<OutstandingModule, {
  count: number;
  total_centi?: number;
  total_outstanding_centi?: number;
}>;

export const useOutstandingSummary = (opts?: { from?: string; to?: string }) => {
  const params = new URLSearchParams();
  if (opts?.from) params.set('from', opts.from);
  if (opts?.to)   params.set('to',   opts.to);
  const qs = params.toString();
  return baseQuery<{ summary: OutstandingSummary }>(
    ['outstanding-summary', qs],
    `/outstanding/summary${qs ? `?${qs}` : ''}`,
  );
};
