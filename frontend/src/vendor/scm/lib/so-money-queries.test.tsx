// The money hooks' wire contract and the converted row's vocabulary
// (docs/bugs/0931). authed-fetch is mocked at the module seam.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { convertParamOf, convertPicksFrom, newOrderWithMoneyHref, useCancelledWithMoney, useOrderMoney, useRequestRefund } from './so-money-queries';

const mockedFetch = vi.mocked(authedFetch);
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);
beforeEach(() => { mockedFetch.mockReset(); });

describe('the wire', () => {
  test('the panel reads GET /mfg-sales-orders/:docNo/money', async () => {
    mockedFetch.mockResolvedValueOnce({ money: { docNo: 'X' }, others: [] });
    const { result } = renderHook(() => useOrderMoney('2990-SO-2607-010'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/mfg-sales-orders/2990-SO-2607-010/money');
  });

  test('Finance\'s list, narrowed by phone for the New SO page', async () => {
    mockedFetch.mockResolvedValueOnce({ orders: [], totalRemainingSen: 0 });
    const { result } = renderHook(() => useCancelledWithMoney('0123'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedFetch).toHaveBeenCalledWith('/mfg-sales-orders/cancelled-with-money?phone=0123');
  });

  test('the refund request POSTs the amount and the note', async () => {
    mockedFetch.mockResolvedValueOnce({ id: 'pv1', pvNumber: '2990Draft-2609-003' });
    const { result } = renderHook(() => useRequestRefund('2990-SO-2607-010'), { wrapper });
    await result.current.mutateAsync({ amountSen: 40_000, note: 'why' });
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/mfg-sales-orders/2990-SO-2607-010/money/refund');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ amountSen: 40_000, note: 'why' });
  });
});

describe('the ?convert= parameter', () => {
  test('round-trips picks, drops junk and zero amounts, and opens the New SO page with the customer copied', () => {
    const picks = [{ docNo: '2990-SO-2607-010', amountSen: 40_000 }, { docNo: '2990-SO-2607-024', amountSen: 30_000 }, { docNo: '', amountSen: 5 }, { docNo: 'X', amountSen: 0 }];
    expect(convertParamOf(picks)).toBe('2990-SO-2607-010:40000,2990-SO-2607-024:30000');
    expect(convertPicksFrom('2990-SO-2607-010:40000, 2990-SO-2607-024:30000,junk,SO:x,SO-1:0')).toEqual([
      { docNo: '2990-SO-2607-010', amountSen: 40_000 }, { docNo: '2990-SO-2607-024', amountSen: 30_000 },
    ]);
    expect(convertPicksFrom(null)).toEqual([]);
    expect(newOrderWithMoneyHref('2990-SO-2607-010', picks.slice(0, 1))).toBe('/scm/sales-orders/new?copyFrom=2990-SO-2607-010&convert=2990-SO-2607-010%3A40000');
  });
});
