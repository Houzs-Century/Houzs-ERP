
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', () => ({
  authedFetch: vi.fn(() => Promise.resolve({ payment: { id: 'p1' }, ok: true })),
  API_URL: 'http://test.local/api/scm',
  humanApiError: (e: unknown) => String(e),
}));
vi.mock('./mutation-error', () => ({ writeFailed: () => {}, writeFailedAs: () => () => {} }));

import {
  useAddSalesOrderPayment, useAttachSalesOrderPaymentSlip, useDeleteSalesOrderPayment, useEditSalesOrderPayment,
} from './sales-order-queries';
import { soPdfPaidSen } from './sales-order-pdf';
import { soListBalanceSen, soListPaidSen } from './so-list-balance';

const DETAIL = ['mfg-sales-order-detail', 'SO-1'];
const OTHER = ['mfg-sales-order-detail', 'SO-2'];
const MONEY = ['so-money', 'SO-1'];

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(DETAIL, { salesOrder: { doc_no: 'SO-1', paid_sen_total: 50000 }, items: [] });
  qc.setQueryData(OTHER, { salesOrder: { doc_no: 'SO-2' }, items: [] });
  qc.setQueryData(MONEY, { ok: true });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}
const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

describe('a payment on the order refreshes the order detail that carries paid_sen_total', () => {
  const cases: Array<[string, (w: ReturnType<typeof setup>['wrapper']) => Promise<void>]> = [
    ['add', async (wrapper) => {
      const { result } = renderHook(() => useAddSalesOrderPayment(), { wrapper });
      await act(async () => { await result.current.mutateAsync({ docNo: 'SO-1', amountSen: 775700 }); });
    }],
    ['edit', async (wrapper) => {
      const { result } = renderHook(() => useEditSalesOrderPayment(), { wrapper });
      await act(async () => { await result.current.mutateAsync({ docNo: 'SO-1', id: 'p1', version: 1, amountSen: 775700 }); });
    }],
    ['delete', async (wrapper) => {
      const { result } = renderHook(() => useDeleteSalesOrderPayment(), { wrapper });
      await act(async () => { await result.current.mutateAsync({ docNo: 'SO-1', id: 'p1', version: 1 }); });
    }],
    ['attach slip', async (wrapper) => {
      const { result } = renderHook(() => useAttachSalesOrderPaymentSlip(), { wrapper });
      await act(async () => { await result.current.mutateAsync({ docNo: 'SO-1', id: 'p1', uploadSessionId: 'u1' }); });
    }],
  ];
  for (const [name, run] of cases) {
    test(name, async () => {
      const { qc, wrapper } = setup();
      expect(stale(qc, DETAIL)).toBe(false);
      await run(wrapper);
      expect(stale(qc, DETAIL)).toBe(true);
      expect(stale(qc, MONEY)).toBe(true);
      expect(stale(qc, OTHER)).toBe(false);
    });
  }
});

describe('soPdfPaidSen: Paid to date agrees with the rows printed', () => {
  const rows = [{ amount_sen: 50000 }, { amount_sen: 775700 }];
  test('a stale header total does not win over the rows the print lists', () => {
    expect(soPdfPaidSen({ paid_sen_total: 50000, paid_outside_ledger_sen: 0 }, rows)).toBe(825700);
  });
  test('a legacy header deposit outside the ledger is still counted', () => {
    expect(soPdfPaidSen({ paid_sen_total: 925700, paid_outside_ledger_sen: 100000 }, rows)).toBe(925700);
  });
  test('without the split (older server, consignment) the header total stands, then the rows', () => {
    expect(soPdfPaidSen({ paid_sen_total: 12300 }, rows)).toBe(12300);
    expect(soPdfPaidSen({}, rows)).toBe(825700);
  });
});

describe('SO list money never reads the stored header columns', () => {
  test('balance falls back to total minus the view paid, not the gross balance_sen', () => {
    const row = { local_total_sen: 100000, paid_total_sen: 60000, balance_sen: 100000, paid_sen: 0 };
    expect(soListBalanceSen(row)).toBe(40000);
    expect(soListBalanceSen({ ...row, balance_sen_live: 30000 })).toBe(30000);
  });
  test('paid is the view paid, and 0 when absent', () => {
    expect(soListPaidSen({ paid_total_sen: 60000 })).toBe(60000);
    expect(soListPaidSen({})).toBe(0);
    expect(soListPaidSen(null)).toBe(0);
  });
});
