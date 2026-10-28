// TanStack Query hooks for /currencies — the owner-maintained currency MASTER
// (migration 0193). The source of truth for the currency dropdown list + each
// currency's current rate to MYR. Mirrors the pattern in inventory-queries.ts.
//
// HOUZS VENDOR — verbatim from 2990's apps/backend/src/lib/currencies-queries.ts.
// The endpoint resolves to /api/scm/currencies via the vendored authedFetch
// base (backend Phase 1-A migration 0082 seeds MYR/RMB/USD/SGD at rate 1).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { createElement, Fragment } from 'react';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type CurrencyRow = {
  code: string;
  name: string;
  symbol: string | null;
  rate_to_myr: string | number;   // numeric(14,6) — PostgREST returns it as a string
  is_active: boolean;
  sort_order: number;
  updated_at: string;
};

/* All currencies (active + inactive) — for the Maintenance page. */
export function useCurrencies(opts?: { activeOnly?: boolean }) {
  const activeOnly = opts?.activeOnly ?? false;
  return useQuery({
    queryKey: ['currencies', activeOnly],
    queryFn: () =>
      authedFetch<{ currencies: CurrencyRow[] }>(
        `/currencies${activeOnly ? '?active=true' : ''}`,
      ).then((r) => r.currencies),
    staleTime: 5 * 60_000,
    retry: retryUnlessClientError,
  });
}

/* ACTIVE currencies only — what every currency <select> in the app reads. The
   master is the source of truth, so adding a currency is fully UI. Falls back
   to MYR-only at the call site when the list hasn't loaded yet. */
export function useActiveCurrencies() {
  return useCurrencies({ activeOnly: true });
}

/* Map a currency code → its current rate_to_myr (a JS number). Used by the New
   forms to prefill the exchange-rate input when a foreign currency is picked. */
export function rateFor(rows: CurrencyRow[] | undefined, code: string): number {
  const row = (rows ?? []).find((r) => r.code === code);
  const n = Number(row?.rate_to_myr ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/* The list of codes for a <select>: the ACTIVE master codes, with the currently
   selected value always present (even if it's been deactivated since) so the
   dropdown still shows it, and MYR guaranteed as a safe fallback while the list
   is still loading. Keeps the master's sort order. */
export function currencyCodesWith(rows: CurrencyRow[] | undefined, current?: string): string[] {
  const codes = (rows ?? []).map((r) => r.code);
  const out = codes.length > 0 ? [...codes] : ['MYR'];
  if (current && !out.includes(current)) out.unshift(current);
  return out;
}

export function useCreateCurrency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      code: string;
      name: string;
      symbol?: string;
      rateToMyr?: number;
      sortOrder?: number;
    }) =>
      authedFetch<{ currency: CurrencyRow }>(`/currencies`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['currencies'] }),
    onError: writeFailed,
  });
}

/* Drop-in <option> list for an existing currency <select>, driven by the ACTIVE
   master (migration 0193). Renders nothing structural — just the <option>s — so
   it slots into a page's own <select className=…> without restructuring. The
   `current` value is always present even if since-deactivated. Written with
   createElement so this .ts query module needs no JSX/.tsx rename. */
export function CurrencyOptions({ current }: { current?: string }) {
  const { data: rows } = useActiveCurrencies();
  const codes = currencyCodesWith(rows, current);
  return createElement(
    Fragment,
    null,
    codes.map((c) => createElement('option', { key: c, value: c }, c)),
  );
}

export function useUpdateCurrency() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, ...body }: {
      code: string;
      name?: string;
      symbol?: string;
      rateToMyr?: number;
      isActive?: boolean;
      sortOrder?: number;
    }) =>
      authedFetch<{ currency: CurrencyRow }>(`/currencies/${code}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['currencies'] }),
    onError: writeFailed,
  });
}
