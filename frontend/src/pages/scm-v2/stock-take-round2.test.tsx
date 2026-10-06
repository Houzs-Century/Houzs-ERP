/* Stock Take round 2 (owner 2026-10-06): upload the counted paper sheet, apply
   the readings, save; a Rack column whose pick is saved with the counts.
   Built on the round-1 page harness. Round 1, as the detail page shows it:
   - RM gain / loss: a variance valued at the server's per-line cost estimate,
     in the summary and per line;
   - several assignees, named on the header and editable while OPEN;
   - Post is not gated on being an assignee (assignee is a record);
   - Add line for stock the sheet does not list;
   - the counted box is a digits-only text box (no spinner / wheel nudges). */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';

const take = {
  id: 'st-1', take_no: 'HC-STK-2610-001', status: 'OPEN', warehouse_id: 'w1',
  scope_type: 'CATEGORY', scope_value: 'MATTRESS', take_date: '2026-10-06', notes: null,
  posted_at: null, cancelled_at: null, created_at: '2026-10-06T04:00:00Z', created_by: null,
  assignee_staff_id: 's-adrian', assignee_staff_ids: ['s-adrian', 's-khalid'], blind: false,
  warehouse: { id: 'w1', code: 'KL WAREHOUSE', name: 'Balakong' },
};
const line = (over: Record<string, unknown>) => ({
  id: 'l1', stock_take_id: 'st-1', item_code: 'MATT-A', product_name: 'Mattress A', variant_key: '',
  variant_label: null, system_qty: 4, counted_qty: 6, variance: 2, notes: null, created_at: '',
  counted_by: null, counted_at: null, added_on_count: false, est_unit_cost_sen: 50_000, ...over,
});

/* ONE object for every render — a fresh one per call would re-fire the page's
   [detail.data] effect forever. */
const RACKS = { data: [{ id: 'r1', rack: 'Rack L5.1', zone: null }, { id: 'r2', rack: 'Rack R1.1', zone: null }] };
const DETAIL = {
  isPending: false, error: null, refetch: () => Promise.resolve(),
  data: {
    take,
    lines: [
      line({}),
      line({ id: 'l2', item_code: 'MATT-B', system_qty: 3, counted_qty: 1, variance: -2, est_unit_cost_sen: 20_000 }),
      line({ id: 'l3', item_code: 'PILLOW', system_qty: 0, counted_qty: 2, variance: 2, est_unit_cost_sen: null, added_on_count: true }),
    ],
    viewer: { isAssignee: false, canSupervise: false, blindActive: false },
  },
};
const updateLines = vi.fn();
const readSheet = vi.fn();
const updateHeader = vi.fn();
const addLine = vi.fn();
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>();
  const idle = { isPending: false, mutate: vi.fn() };
  return {
    ...real,
    useStockTakeDetail: () => DETAIL,
    useUpdateStockTakeLines: () => ({ isPending: false, mutate: updateLines }),
    useStockTakeRacks: () => RACKS,
    readStockTakeSheet: (...args: unknown[]) => readSheet(...args),
    usePostStockTake: () => idle,
    useCancelStockTake: () => idle,
    useReverseStockTake: () => idle,
    useDeleteStockTake: () => idle,
    useUpdateStockTakeHeader: () => ({ isPending: false, mutate: updateHeader }),
    useAddStockTakeLine: () => ({ isPending: false, mutate: addLine }),
    useStockTakeBucketOptions: () => ({ data: [], isLoading: false }),
  };
});
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: (id: string | null | undefined) => ({ 's-adrian': 'Adrian', 's-khalid': 'Khalid' } as Record<string, string>)[id ?? ''] ?? '—' }),
}));
vi.mock('../../vendor/scm/lib/admin-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/admin-queries')>()),
  usePickableStaff: () => ({ data: [{ id: 's-adrian', name: 'Adrian' }, { id: 's-khalid', name: 'Khalid' }, { id: 's-ain', name: 'Ain' }] }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: 'PILLOW', name: 'Pillow' }], isLoading: false }),
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

describe('Stock Take detail — round 2', () => {
  test('a rack typed on a line is matched to this warehouse rack and saved with the counts', () => {
    draw();
    fireEvent.change(screen.getByLabelText('Rack for MATT-A'), { target: { value: 'r1.1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    expect(updateLines).toHaveBeenCalledWith(
      { id: 'st-1', lines: [expect.objectContaining({ id: 'l1', rackId: 'r2' })] },
      expect.anything(),
    );
  });

  test('a rack that is not in this warehouse blocks the save', () => {
    updateLines.mockClear();
    draw();
    const box = screen.getByLabelText('Rack for MATT-A') as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'Z9.9' } });
    expect(box.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    expect(updateLines).not.toHaveBeenCalled();
  });

  /* Owner's KL WAREHOUSE take froze: a <select> per line put 704 x 77 options
     on the sheet. The rack box must add no options per line. */
  test('the rack column puts no dropdown options on the sheet', () => {
    draw();
    expect(document.querySelectorAll('[aria-label^="Rack for"] option').length).toBe(0);
  });

  test('the counted sheet is read, the readings are applied to the screen, then saved', async () => {
    readSheet.mockResolvedValue({
      takeNoRead: 'HC-STK-2610-001', takeNoMatches: true,
      proposals: [
        { lineId: 'l2', no: 2, itemCode: 'MATT-B', variantLabel: null, counted: 5, rackText: 'L5.1', rackId: 'r1', unclear: false },
        { lineId: 'l1', no: 1, itemCode: 'MATT-A', variantLabel: null, counted: 8, rackText: null, rackId: null, unclear: true },
      ],
      unmatched: [{ no: 9, itemCode: 'GHOST', counted: 1, rackText: null, reason: 'not_on_sheet' }],
    });
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Upload counted sheet/ }));
    const page = new File(['%PDF-1.4'], 'page1.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Sheet pages'), { target: { files: [page] } });
    fireEvent.click(screen.getByRole('button', { name: /Read 1 page/ }));
    await screen.findByText(/Apply 1 to the sheet/); // the unclear reading starts unticked
    expect(readSheet).toHaveBeenCalledWith('st-1', expect.objectContaining({ mime: 'application/pdf' }));
    expect(screen.getByText(/GHOST/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Apply 1 to the sheet/ }));

    expect((screen.getByLabelText('Counted qty for MATT-B') as HTMLInputElement).value).toBe('5');
    expect((screen.getByLabelText('Counted qty for MATT-A') as HTMLInputElement).value).toBe('6');
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    expect(updateLines).toHaveBeenLastCalledWith(
      { id: 'st-1', lines: [expect.objectContaining({ id: 'l2', countedQty: 5, rackId: 'r1' })] },
      expect.anything(),
    );
  });
});
