/* A save refreshes every screen that shows what it moved (ported from Conts ERP #1126):
   - a voucher post / approve / cancel refreshes the PIs, AP bills, advances, reservations and bank board it settles;
   - putting a PO on hold refreshes the keys the PO screens actually read ('mfg-purchase-orders'), not 'purchase-orders';
   - a DO created or a line added refreshes the stock screens.
   authed-fetch is mocked at the module seam; each test drives the real hook and reads which keys it invalidated. */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('./authed-fetch', async (orig) => ({ ...(await orig<Record<string, unknown>>()), authedFetch: vi.fn() }));

import { authedFetch } from './authed-fetch';
import { useApprovePaymentVoucher, useCancelPaymentVoucher, usePostPaymentVoucher } from './payment-voucher-queries';
import { useSetDocumentHold } from './document-hold-queries';
import { useAddMfgDeliveryOrderItem, useCreateMfgDeliveryOrder } from './delivery-order-queries';

const fetchMock = vi.mocked(authedFetch);

function setup<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const spy = vi.spyOn(qc, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(hook, { wrapper });
  const keys = () => spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown }).queryKey));
  return { result, keys };
}

beforeEach(() => { fetchMock.mockReset(); });

describe('payment voucher: posting refreshes what it settled', () => {
  test.each([
    ['post', usePostPaymentVoucher],
    ['approve (posts the GL in the same request)', useApprovePaymentVoucher],
    ['cancel', useCancelPaymentVoucher],
  ])('%s', async (_name, hook) => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const { result, keys } = setup(() => (hook as () => { mutateAsync: (id: string) => Promise<unknown> })());
    await act(async () => { await result.current.mutateAsync('pv-1'); });
    for (const k of ['purchase-invoices', 'purchase-invoice-detail', 'ap-invoices', 'ap-invoice', 'supplier-advances', 'pv-reservations', 'daily-bank']) {
      expect(keys()).toContain(JSON.stringify([k]));
    }
    expect(keys()).toContain(JSON.stringify(['payment-voucher-detail', 'pv-1']));
  });
});

describe('hold marker on a purchase order refreshes the keys the PO screens read', () => {
  test('po', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const { result, keys } = setup(() => useSetDocumentHold('po'));
    await act(async () => { await result.current.mutateAsync({ key: 'po-1', onHold: true }); });
    expect(keys()).toContain(JSON.stringify(['mfg-purchase-orders']));
    expect(keys()).toContain(JSON.stringify(['mfg-purchase-order-detail']));
  });
});

describe('a DO created or a line added refreshes the stock screens', () => {
  test('create', async () => {
    fetchMock.mockResolvedValueOnce({ id: 'd1', doNumber: 'DO-1' });
    const { result, keys } = setup(() => useCreateMfgDeliveryOrder());
    await act(async () => { await result.current.mutateAsync({}); });
    expect(keys()).toContain(JSON.stringify(['inventory']));
  });
  test('add line', async () => {
    fetchMock.mockResolvedValueOnce({ item: {} });
    const { result, keys } = setup(() => useAddMfgDeliveryOrderItem());
    await act(async () => { await result.current.mutateAsync({ id: 'd1', itemCode: 'X' }); });
    expect(keys()).toContain(JSON.stringify(['inventory']));
  });
});
