/* HC-0158: in the By model view a model's collapsed header row has its own
   trash. It queues every shown line of the model with the per-line deletes:
   hidden until Save Counts, one Undo bar, the code named once. The header also
   splits a sum that hides +2 / -1 buckets, and each line names its source PO. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const take = {
  id: 'st-1', take_no: 'HC-STK-2610-006', status: 'OPEN', warehouse_id: 'w1',
  scope_type: 'CATEGORY', scope_value: 'BEDFRAME', take_date: '2026-10-24', notes: null,
  posted_at: null, cancelled_at: null, created_at: '2026-10-24T03:31:00Z', created_by: null,
  assignee_staff_id: null, assignee_staff_ids: [], blind: false,
  warehouse: { id: 'w1', code: 'KL WAREHOUSE', name: 'Balakong' },
};
const line = (over: Record<string, unknown>) => ({
  id: 'l1', stock_take_id: 'st-1', item_code: 'FENRIR-(Q)', product_name: 'FENRIR BEDFRAME (5FT)', variant_key: 'a',
  variant_label: 'Fabric A', system_qty: 0, counted_qty: null, variance: null, notes: null, created_at: '',
  counted_by: null, counted_at: null, added_on_count: false, est_unit_cost_sen: null, ...over,
});

const DETAIL = {
  isPending: false, error: null, refetch: () => Promise.resolve(),
  data: {
    take,
    lines: [
      line({ variant_key: '', variant_label: null, system_qty: 2, source_pos: [{ po: 'HC-PO-009630', qty: 1 }] }),
      line({ id: 'l2', variant_key: 'b', variant_label: 'Fabric B', system_qty: -1 }),
      line({ id: 'l3', item_code: 'HB109NL', product_name: 'LATEX PILLOW', variant_key: '', variant_label: null, system_qty: 1 }),
    ],
    viewer: { isAssignee: false, canSupervise: false, blindActive: false },
  },
};
const delLine = vi.fn(() => Promise.resolve({}));
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>();
  const idle = { isPending: false, mutate: vi.fn() };
  return {
    ...real,
    useStockTakeDetail: () => DETAIL,
    useUpdateStockTakeLines: () => ({ isPending: false, mutateAsync: vi.fn(() => Promise.resolve({})) }),
    usePostStockTake: () => idle,
    useCancelStockTake: () => idle,
    useReverseStockTake: () => idle,
    useDeleteStockTake: () => idle,
    useUpdateStockTakeHeader: () => idle,
    useAddStockTakeLine: () => ({ isPending: false, mutateAsync: vi.fn(() => Promise.resolve({})) }),
    useDeleteStockTakeLine: () => ({ isPending: false, mutateAsync: delLine }),
    useStockTakeBucketOptions: () => ({ data: [], isLoading: false }),
  };
});
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: () => '—' }),
}));
vi.mock('../../vendor/scm/lib/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/admin-queries')>()),
  usePickableStaff: () => ({ data: [] }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => vi.fn(),
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockTakeDetail } from './StockTakeDetail';

const draw = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } })}>
    <MemoryRouter initialEntries={['/scm/stock-takes/st-1']}>
      <Routes><Route path="/scm/stock-takes/:id" element={<StockTakeDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe('Stock Take detail — HC-0158 model delete', () => {
  test('a model of +2 and -1 buckets says so on its header; an open line names its PO and the rest', () => {
    draw();
    expect(screen.getByText('+2 / −1')).toBeTruthy();
    expect(screen.queryByText('HC-PO-009630')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'FENRIR-(Q)' }));
    expect(screen.getByText('HC-PO-009630')).toBeTruthy();
    expect(screen.getByText('1 without PO')).toBeTruthy();
  });

  test('the header trash queues the whole model; Undo brings it back; Save Counts deletes each line', async () => {
    delLine.mockClear();
    draw();
    expect(screen.getByRole('button', { name: 'FENRIR-(Q)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Delete all \d+ lines of HB109NL/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete all 2 lines of FENRIR-(Q)' }));
    expect(screen.queryByRole('button', { name: 'FENRIR-(Q)' })).toBeNull();
    expect(screen.getByText(/2 lines deleted on Save Counts/)).toBeTruthy();
    expect(screen.getByText('FENRIR-(Q)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByRole('button', { name: 'FENRIR-(Q)' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete all 2 lines of FENRIR-(Q)' }));
    expect(delLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    await waitFor(() => expect(delLine).toHaveBeenCalledTimes(2));
    expect(delLine).toHaveBeenCalledWith({ id: 'st-1', lineId: 'l1' });
    expect(delLine).toHaveBeenCalledWith({ id: 'st-1', lineId: 'l2' });
    expect(screen.getByLabelText('Counted qty for HB109NL')).toBeTruthy();
  });
});
