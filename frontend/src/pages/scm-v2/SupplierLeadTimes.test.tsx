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
  useCategoryLeadTimes: () => ({
    data: {
      categories: [
        { key: 'sofa', label: 'Sofa' }, { key: 'bedframe', label: 'Bedframe' },
        { key: 'carpet', label: 'Rugs' }, { key: 'others', label: 'Others' },
      ],
      leadTimes: { null: { sofa: 7, bedframe: 7, others: 10 } },
    },
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

  const writes = () => authedFetch.mock.calls.filter(([, o]) => o && (o.method === 'PUT' || o.method === 'DELETE'));
  const input = (label: string) => screen.getByLabelText(`${label} lead time in days`) as HTMLInputElement;
  const saveButton = () => screen.getByRole('button', { name: /^save/i }) as HTMLButtonElement;

  test('lists every category the server sends, a new one included, with what a blank box uses', async () => {
    authedFetch.mockResolvedValueOnce({ leadTimes: { sofa: 20 } });
    renderPanel();

    expect((await screen.findByLabelText('Sofa lead time in days') as HTMLInputElement).value).toBe('20');
    expect(input('Rugs').value).toBe('');
    expect(screen.getAllByText('Default: 7 days')).toHaveLength(2);
    expect(screen.getByText('Others: 10 days')).toBeTruthy();
  });

  test('one Save writes every changed row: a number PUTs, an emptied box DELETEs', async () => {
    authedFetch.mockResolvedValueOnce({ leadTimes: { sofa: 20 } });
    renderPanel();
    await screen.findByLabelText('Sofa lead time in days');
    expect(saveButton().disabled).toBe(true);

    authedFetch.mockResolvedValue({ ok: true, leadTimes: {} });
    fireEvent.change(input('Sofa'), { target: { value: '' } });
    fireEvent.change(input('Rugs'), { target: { value: '14' } });
    expect(saveButton().textContent).toBe('Save 2 changes');
    fireEvent.click(saveButton());

    await waitFor(() => expect(writes()).toHaveLength(2));
    const [del, put] = writes();
    expect(del![1].method).toBe('DELETE');
    expect(JSON.parse(del![1].body)).toEqual({ supplierId: SUP, category: 'sofa' });
    expect(put![1].method).toBe('PUT');
    expect(JSON.parse(put![1].body)).toEqual({ supplierId: SUP, category: 'carpet', leadDays: 14 });
  });

  test('typing the saved number back is not a change', async () => {
    authedFetch.mockResolvedValueOnce({ leadTimes: { sofa: 20 } });
    renderPanel();
    await screen.findByLabelText('Sofa lead time in days');
    fireEvent.change(input('Sofa'), { target: { value: '20' } });
    expect(saveButton().disabled).toBe(true);
  });
});
