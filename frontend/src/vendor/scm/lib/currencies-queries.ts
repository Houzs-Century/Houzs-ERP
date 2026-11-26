
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch } from './authed-fetch';
import { writeFailed } from './mutation-error';
import { createElement, Fragment } from 'react';
import { retryUnlessClientError } from '../../../lib/retryPolicy';

export type CurrencyRow = {
  code: string;
  name: string;
  symbol: string | null;
  rate_to_myr: string | number;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
};

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

export function useActiveCurrencies() {
  return useCurrencies({ activeOnly: true });
}

export function rateFor(rows: CurrencyRow[] | undefined, code: string): number {
  const row = (rows ?? []).find((r) => r.code === code);
  const n = Number(row?.rate_to_myr ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

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
