/* Stock Take round 1 (owner 2026-10-06), as the detail page shows it:
   - RM gain / loss: a variance valued at the server's per-line cost estimate,
     in the summary and per line;
   - several assignees, named on the header and editable while OPEN;
   - Post is not gated on being an assignee (assignee is a record);
   - Add line for stock the sheet does not list (HC-0140: saved with Save Counts);
   - the counted box is a digits-only text box (no spinner / wheel nudges). */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const updateHeader = vi.fn();
const addLine = vi.fn(() => Promise.resolve({}));
const delLine = vi.fn(() => Promise.resolve({}));
const saveLines = vi.fn(() => Promise.resolve({}));
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>();
  const idle = { isPending: false, mutate: vi.fn() };
  return {
    ...real,
    useStockTakeDetail: () => DETAIL,
    useUpdateStockTakeLines: () => ({ isPending: false, mutateAsync: saveLines }),
    usePostStockTake: () => idle,
    useCancelStockTake: () => idle,
    useReverseStockTake: () => idle,
    useDeleteStockTake: () => idle,
    useUpdateStockTakeHeader: () => ({ isPending: false, mutate: updateHeader }),
    useAddStockTakeLine: () => ({ isPending: false, mutateAsync: addLine }),
    useDeleteStockTakeLine: () => ({ isPending: false, mutateAsync: delLine }),
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

describe('Stock Take detail — round 1', () => {
  test('RM gain / loss: +2 x RM500 and -2 x RM200; an uncosted line is named, not valued at 0', () => {
    draw();
    expect(screen.getByText('+RM 1,000.00', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('−RM 400.00', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText('+RM 600.00', { selector: 'div' })).toBeTruthy();
    expect(screen.getByText(/1 line uncosted/)).toBeTruthy();
  });

  test('every assignee is named, and Post is open to a non-assignee', () => {
    draw();
    expect(screen.getByText('Adrian, Khalid')).toBeTruthy();
    const postBtn = screen.getByRole('button', { name: /^Post$/ }) as HTMLButtonElement;
    expect(postBtn.disabled).toBe(false);
  });

  test('Edit lets the header assignees change while OPEN', () => {
    draw();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    fireEvent.change(screen.getByLabelText('Add assignee'), { target: { value: 's-ain' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(updateHeader).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'st-1', assigneeStaffIds: ['s-adrian', 's-khalid', 's-ain'] }),
      expect.anything(),
    );
  });

  /* HC-0140: Add line saved at once and reloaded the sheet, so with a count
     typed it refused ("Save your counts first"). Now it only adds a row on
     screen; Save Counts sends counts, then deletes, then new lines. */
  test('Add line waits on screen next to unsaved counts; Save Counts sends it', async () => {
    addLine.mockClear(); saveLines.mockClear();
    draw();
    expect(screen.getByText('Added')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Counted qty for MATT-A'), { target: { value: '7' } });
    fireEvent.change(screen.getByPlaceholderText('Type or pick a SKU code…'), { target: { value: 'PILLOW' } });
    fireEvent.change(screen.getByLabelText('Counted qty for the new line'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Add line/ }));
    expect(addLine).not.toHaveBeenCalled();
    expect(screen.getByText(/Added, not saved yet/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Post$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    await waitFor(() => expect(addLine).toHaveBeenCalledWith({ id: 'st-1', itemCode: 'PILLOW', variantKey: '', countedQty: 3 }));
    expect(saveLines).toHaveBeenCalledWith(expect.objectContaining({ id: 'st-1', lines: [expect.objectContaining({ id: 'l1', countedQty: 7 })] }));
    await waitFor(() => expect(screen.queryByText(/Added, not saved yet/)).toBeNull());
  });

  test('a delete button on each line: an unsaved add goes at once, a saved sheet or added line on Save Counts', async () => {
    addLine.mockClear(); delLine.mockClear();
    draw();
    fireEvent.change(screen.getByPlaceholderText('Type or pick a SKU code…'), { target: { value: 'PILLOW' } });
    fireEvent.change(screen.getByLabelText('Counted qty for the new line'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: /Add line/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove added line PILLOW' }));
    expect(screen.queryByText(/Added, not saved yet/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Delete line MATT-A' }));
    expect(screen.queryByLabelText('Counted qty for MATT-A')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Counted qty for MATT-A')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete line MATT-A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete line PILLOW' }));
    expect(screen.getByText(/2 lines deleted on Save Counts/)).toBeTruthy();
    expect(screen.queryByText('Added')).toBeNull();
    expect(delLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Save Counts/ }));
    await waitFor(() => expect(delLine).toHaveBeenCalledWith({ id: 'st-1', lineId: 'l3' }));
    expect(delLine).toHaveBeenCalledWith({ id: 'st-1', lineId: 'l1' });
    expect(addLine).not.toHaveBeenCalled();
  });

  test('the counted box takes digits only and has no spinner', () => {
    draw();
    const box = screen.getByLabelText('Counted qty for MATT-A') as HTMLInputElement;
    expect(box.type).toBe('text');
    fireEvent.change(box, { target: { value: '1a2' } });
    expect(box.value).toBe('12');
  });
});
