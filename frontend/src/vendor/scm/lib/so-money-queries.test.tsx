// The money hooks' wire contract and the converted row's vocabulary
// (docs/bugs/0931). authed-fetch is mocked at the module seam.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({ authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { EMPTY_BANK, convertParamOf, convertPicksFrom, newOrderWithMoneyHref, refundAskGaps, useCancelledWithMoney, useOrderMoney, useRequestRefund } from './so-money-queries';

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

  test('the refund request POSTs the amount, the reason and the customer\'s bank, trimmed (owner 2026-10-14)', async () => {
    mockedFetch.mockResolvedValueOnce({ id: 'r1', requestNo: '2990-PRQ-2610-001' });
    const { result } = renderHook(() => useRequestRefund('2990-SO-2607-010'), { wrapper });
    const r = await result.current.mutateAsync({ amountSen: 40_000, reason: ' why ', bankName: ' Maybank ', bankAccountNo: '5123 4567 8901 ', bankAccountName: 'AH MENG' });
    expect(r.requestNo).toBe('2990-PRQ-2610-001');
    const [path, init] = mockedFetch.mock.calls[0]!;
    expect(path).toBe('/mfg-sales-orders/2990-SO-2607-010/money/refund');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ amountSen: 40_000, reason: 'why', bankName: 'Maybank', bankAccountNo: '5123 4567 8901', bankAccountName: 'AH MENG' });
  });

  test('what is still needed before a refund request may go', () => {
    expect(refundAskGaps({ reason: '', ...EMPTY_BANK })).toEqual(['the reason', "the customer's bank", 'the account number', 'the name on the account']);
    expect(refundAskGaps({ reason: 'x', bankName: 'Maybank', bankAccountNo: ' ', bankAccountName: 'AH MENG' })).toEqual(['the account number']);
    expect(refundAskGaps({ reason: 'x', bankName: 'Maybank', bankAccountNo: '5123', bankAccountName: 'AH MENG' })).toEqual([]);
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
