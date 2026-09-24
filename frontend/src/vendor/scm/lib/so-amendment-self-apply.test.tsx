/* Owner 2026-09-24: 「for SO amendment - 如果是 Logistic admin 修改客户信息,
 * Delivery Date - 无需 approver」.
 *
 * The server says WHICH halves the raiser may apply themselves; this hook is
 * what then applies them, through the ordinary approve route. Pinned here
 * because all four surfaces that raise an amendment go through this one hook,
 * and because the failure path matters as much as the happy one: a refused
 * apply must leave a raised amendment and a truthful message, never an error
 * that makes the operator think nothing was saved. */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authedFetch = vi.fn();
vi.mock('./authed-fetch', () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  idempotentInit: (_k: string | undefined, init: RequestInit) => init,
}));

const { useCreateAmendment } = await import('./so-amendment-queries');

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const submit = async () => {
  const { result } = renderHook(() => useCreateAmendment(), { wrapper });
  const res = await result.current.mutateAsync({ docNo: 'HC-SO-000001', lines: [] });
  await waitFor(() => expect(authedFetch).toHaveBeenCalled());
  return res;
};

/** Which paths were called, in order. */
const paths = () => authedFetch.mock.calls.map((c) => String(c[0]));

beforeEach(() => authedFetch.mockReset());

describe('raising an amendment the raiser may apply', () => {
  it('applies each offered half through the ordinary approve route', async () => {
    authedFetch
      .mockResolvedValueOnce({ amendment: { id: 'a1' }, amendments: [{ id: 'a1' }], selfApprovable: ['a1'] })
      .mockResolvedValueOnce({ amendment: { id: 'a1' }, revision: 3 });
    const res = await submit();
    expect(paths()).toEqual([
      '/mfg-sales-orders/HC-SO-000001/amendments',
      '/so-amendments/a1/approve-so',
    ]);
    expect(authedFetch.mock.calls[1]![1]).toMatchObject({ method: 'PATCH' });
    expect(res.autoApplied).toBe(1);
  });

  it('applies BOTH halves when the server offers both', async () => {
    authedFetch
      .mockResolvedValueOnce({ amendment: { id: 'a1' }, amendments: [{ id: 'a1' }, { id: 'a2' }], selfApprovable: ['a1', 'a2'] })
      .mockResolvedValue({ ok: true });
    const res = await submit();
    expect(paths()).toContain('/so-amendments/a2/approve-so');
    expect(res.autoApplied).toBe(2);
  });

  it('applies NOTHING when the server offers nothing — the ordinary queue path', async () => {
    authedFetch.mockResolvedValueOnce({ amendment: { id: 'a1' }, amendments: [{ id: 'a1' }], selfApprovable: [] });
    const res = await submit();
    expect(paths()).toEqual(['/mfg-sales-orders/HC-SO-000001/amendments']);
    expect(res.autoApplied).toBe(0);
  });

  it('treats an older server (no field at all) as "nothing to apply"', async () => {
    authedFetch.mockResolvedValueOnce({ amendment: { id: 'a1' } });
    const res = await submit();
    expect(paths()).toHaveLength(1);
    expect(res.autoApplied).toBe(0);
  });

  /* THE FAILURE PATH. The amendment was raised; only the shortcut failed. The
     submit must SUCCEED and report 0 applied — the notice then says the desk is
     waiting, which is exactly what the queue now holds. */
  it('a refused apply does not fail the submit — the amendment stays raised', async () => {
    authedFetch
      .mockResolvedValueOnce({ amendment: { id: 'a1' }, amendments: [{ id: 'a1' }], selfApprovable: ['a1'] })
      .mockRejectedValueOnce(new Error('You do not have permission to approve the delivery lane.'));
    const res = await submit();
    expect(res.amendment).toMatchObject({ id: 'a1' });
    expect(res.autoApplied).toBe(0);
  });
});
