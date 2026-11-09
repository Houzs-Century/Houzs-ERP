/* Every caller of usePostPurchaseInvoice — the list, both detail pages, desktop
   and phone create — hears a missing AP journal from the hook itself. */
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { authedFetch, serviceNotify } = vi.hoisted(() => ({ authedFetch: vi.fn(), serviceNotify: vi.fn() }));
vi.mock('./authed-fetch', () => ({ authedFetch }));
vi.mock('./dialog-service', () => ({ serviceNotify }));
const { usePostPurchaseInvoice } = await import('./purchase-invoice-queries');

function post() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return renderHook(() => usePostPurchaseInvoice(), { wrapper }).result.current.mutateAsync('pi-1');
}

beforeEach(() => { authedFetch.mockReset(); serviceNotify.mockReset().mockResolvedValue(undefined); });

describe('posting a purchase invoice', () => {
  test('a refused journal raises an error dialog naming the reason', async () => {
    authedFetch.mockResolvedValue({ purchaseInvoice: {}, ledger: { posted: false, status: 'group_unbound', reason: 'Group SOFA has no purchase account.' } });
    const res = await post();
    expect(res.ledger?.posted).toBe(false);
    expect(serviceNotify).toHaveBeenCalledTimes(1);
    const arg = serviceNotify.mock.calls[0][0] as { title: string; body: string; tone: string };
    expect(arg.tone).toBe('error');
    expect(arg.body).toMatch(/^The AP liability is NOT in the ledger yet: Group SOFA has no purchase account\./);
  });

  test('a written journal raises nothing', async () => {
    authedFetch.mockResolvedValue({ purchaseInvoice: {}, ledger: { posted: true, status: 'posted', jeNo: 'JE-1' } });
    await post();
    expect(serviceNotify).not.toHaveBeenCalled();
  });

  test('migrated paperwork raises nothing', async () => {
    authedFetch.mockResolvedValue({ purchaseInvoice: {}, ledger: { posted: false, status: 'migrated_source', reason: null } });
    await post();
    expect(serviceNotify).not.toHaveBeenCalled();
  });
});
