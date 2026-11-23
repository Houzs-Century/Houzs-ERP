/* Reopen a cancelled stock take (owner 2026-11-23): the detail page shows a
   Reopen button on a CANCELLED take, and clicking it (confirmed) fires the
   reopen mutation — the server re-snapshots the sheet to current stock. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const take = {
  id: 'st-9', take_no: 'HC-STK-2611-006', status: 'CANCELLED', warehouse_id: 'w1',
  scope_type: 'CATEGORY', scope_value: 'ACCESSORY', take_date: '2026-11-21', notes: null,
  posted_at: '2026-11-23T06:03:00Z', cancelled_at: '2026-11-23T06:07:00Z',
  created_at: '2026-11-21T04:00:00Z', created_by: null,
  assignee_staff_id: 's-adrian', assignee_staff_ids: ['s-adrian'], blind: false,
  warehouse: { id: 'w1', code: 'KL WAREHOUSE', name: 'Balakong' },
};
const DETAIL = {
  isPending: false, error: null, refetch: () => Promise.resolve(),
  data: {
    take,
    lines: [{
      id: 'l1', stock_take_id: 'st-9', item_code: 'MATT-A', product_name: 'Mattress A',
      variant_key: '', variant_label: null, system_qty: 4, counted_qty: null, variance: null,
      notes: null, created_at: '', counted_by: null, counted_at: null, added_on_count: false,
      est_unit_cost_sen: null,
    }],
    viewer: { isAssignee: false, canSupervise: true, blindActive: false },
  },
};
const reopenMutate = vi.fn();
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>();
  const idle = { isPending: false, mutate: vi.fn(), mutateAsync: vi.fn(() => Promise.resolve({})) };
  return {
    ...real,
    useStockTakeDetail: () => DETAIL,
    useUpdateStockTakeLines: () => idle,
    usePostStockTake: () => idle,
    useApproveStockTake: () => idle,
    useRejectStockTake: () => idle,
    useCancelStockTake: () => idle,
    useReverseStockTake: () => idle,
    useReopenStockTake: () => ({ isPending: false, mutate: reopenMutate }),
    useDeleteStockTake: () => idle,
    useUpdateStockTakeHeader: () => idle,
    useAddStockTakeLine: () => idle,
    useDeleteStockTakeLine: () => idle,
    useStockTakeBucketOptions: () => ({ data: [], isLoading: false }),
  };
});
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: () => '—' }),
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
    <MemoryRouter initialEntries={['/scm/stock-takes/st-9']}>
      <Routes><Route path="/scm/stock-takes/:id" element={<StockTakeDetail />} /></Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe('Stock Take detail — reopen a cancelled take', () => {
  test('a CANCELLED take shows Reopen; clicking it (confirmed) fires the reopen mutation', async () => {
    reopenMutate.mockClear();
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Reopen/ }));
    await waitFor(() => expect(reopenMutate).toHaveBeenCalledWith('st-9', expect.anything()));
  });
});
