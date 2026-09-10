// SupplierLeadTimes — the owner's manual per-(supplier, category) lead time, on
// the supplier page (owner 2026-09-11). A value here overrides the category
// default for that supplier; blank uses the default; clearing removes it.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const authedFetch = vi.fn();
vi.mock('../../vendor/scm/lib/authed-fetch', () => ({ authedFetch: (...a: unknown[]) => authedFetch(...a) }));
vi.mock('../../vendor/scm/lib/mutation-error', () => ({ writeFailed: () => {} }));
vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  // Base defaults so the rows can show "(default N)".
  useCategoryLeadTimes: () => ({
    data: { leadTimes: { null: { sofa: 7, bedframe: 7, mattress: 0, accessory: 0, service: 0 } } },
    isLoading: false,
  }),
}));

import { SupplierLeadTimes } from './SupplierLeadTimes';

const SUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SupplierLeadTimes supplierId={SUP} />
    </QueryClientProvider>,
  );
}

describe('SupplierLeadTimes', () => {
  beforeEach(() => authedFetch.mockReset());

  test('shows an override where set, and the default where not', async () => {
    authedFetch.mockResolvedValueOnce({
      leadTimes: { sofa: 20, bedframe: null, mattress: null, accessory: null },
    });
    renderPanel();

    // sofa has an override -> "override set"; the input carries 20.
    expect(await screen.findByText('override set')).toBeTruthy();
    const sofaInput = screen.getByLabelText('sofa lead time override in days') as HTMLInputElement;
    expect(sofaInput.value).toBe('20');

    // bedframe is not overridden -> uses the default (7).
    expect(screen.getByText('using default (7)')).toBeTruthy();
  });

  test('saving a number PUTs the override; clearing it DELETEs', async () => {
    authedFetch.mockResolvedValueOnce({
      leadTimes: { sofa: null, bedframe: null, mattress: null, accessory: null },
    });
    renderPanel();
    await screen.findByLabelText('sofa lead time override in days');

    // Type 12 into sofa and Save -> PUT with leadDays 12. (The write is followed
    // by a refetch, so find the call that carries a method, not the last call.)
    authedFetch.mockResolvedValue({ ok: true });
    fireEvent.change(screen.getByLabelText('sofa lead time override in days'), { target: { value: '12' } });
    const sofaRow = screen.getByLabelText('sofa lead time override in days').closest('label')!;
    fireEvent.click(sofaRow.querySelector('button')!);
    await waitFor(() => {
      const write = authedFetch.mock.calls.find(([, o]) => o && (o.method === 'PUT' || o.method === 'DELETE'));
      expect(write).toBeTruthy();
      expect(write![0]).toBe('/mrp-supplier-lead-times');
      expect(write![1].method).toBe('PUT');
      expect(JSON.parse(write![1].body)).toEqual({ supplierId: SUP, category: 'sofa', leadDays: 12 });
    });
  });

  test('clearing an existing override DELETEs it (blank = use default)', async () => {
    authedFetch.mockResolvedValueOnce({
      leadTimes: { sofa: 20, bedframe: null, mattress: null, accessory: null },
    });
    renderPanel();
    const sofaInput = await screen.findByLabelText('sofa lead time override in days');

    authedFetch.mockResolvedValue({ ok: true });
    fireEvent.change(sofaInput, { target: { value: '' } });
    const sofaRow = sofaInput.closest('label')!;
    fireEvent.click(sofaRow.querySelector('button')!);
    await waitFor(() => {
      const write = authedFetch.mock.calls.find(([, o]) => o && (o.method === 'PUT' || o.method === 'DELETE'));
      expect(write).toBeTruthy();
      expect(write![0]).toBe('/mrp-supplier-lead-times');
      expect(write![1].method).toBe('DELETE');
      expect(JSON.parse(write![1].body)).toEqual({ supplierId: SUP, category: 'sofa' });
    });
  });
});
