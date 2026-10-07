/* BUG-66 (Sim 2026-10-07): a stock adjustment had no document number, could
   not be opened, and could not be edited. It is now a numbered document:
   the list shows one row per HC-SA-... number and opens it, the detail page
   shows every line, and Edit re-opens the form seeded from the saved lines,
   counting what the document already took out as available to it again. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { StockAdjustmentDoc } from '../../vendor/scm/lib/stock-queries';

const DOC: StockAdjustmentDoc = {
  id: 'sa-1',
  adjustment_no: 'HC-SA-2610-001',
  warehouse_id: 'w1',
  notes: 'Water damage',
  created_by: null,
  created_at: '2026-10-07T03:00:00Z',
  updated_at: '2026-10-07T03:00:00Z',
  lines: [
    { id: 'l1', line_no: 1, item_code: 'CH-1', product_name: 'Chair', item_group: null, variants: null, description2: null,
      variant_key: '', batch_no: null, qty: -3, reason_code: 'DAMAGE', notes: 'leg broken' },
    { id: 'l2', line_no: 2, item_code: 'CH-2', product_name: 'Stool', item_group: null, variants: null, description2: null,
      variant_key: '', batch_no: null, qty: 2, reason_code: 'FOUND', notes: null },
  ],
};

const updateCalls: Array<{ notes?: string | null; lines?: Array<{ itemCode: string; qty: number; variantKey?: string | null }> }> = [];
vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useStockAdjustments: () => ({ data: [DOC], isLoading: false, error: null }),
  useStockAdjustmentDoc: () => ({ data: DOC, isLoading: false, isPending: false, error: null }),
  // The bucket the -3 came out of is EMPTY now: nothing open to take from.
  useInventoryBuckets: () => ({ data: [], isLoading: false }),
  useInventoryProductBreakdown: (itemCode: string | null) => ({
    data: { balances: itemCode ? [{ warehouse_id: 'w1', item_code: itemCode, qty: 0 }] : [] },
    isLoading: false,
  }),
  useStockAdjustment: () => ({ isPending: false, mutateAsync: async () => ({ id: 'x', adjustmentNo: 'x' }) }),
  useUpdateStockAdjustment: () => ({
    isPending: false,
    mutateAsync: async (vars: (typeof updateCalls)[number]) => { updateCalls.push(vars); return {}; },
  }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A', name: 'Warehouse A' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: 'CH-1', name: 'Chair', category: 'ACCESSORY' }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: null, isLoading: false }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/fabric-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../hooks/useStaffLookup', () => ({
  useStaffLookup: () => ({ actorNameOf: () => 'Sim' }),
}));
const notify = vi.fn(async () => undefined);
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => notify,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockAdjustments } from './StockAdjustments';
import { StockAdjustmentDetail } from './StockAdjustmentDetail';
import { StockAdjustmentEdit } from './StockAdjustmentNew';

afterEach(() => {
  updateCalls.length = 0;
  notify.mockClear();
  localStorage.clear();
});

const draw = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/scm/stock-adjustments" element={<StockAdjustments />} />
      <Route path="/scm/stock-adjustments/:id" element={<StockAdjustmentDetail />} />
      <Route path="/scm/stock-adjustments/:id/edit" element={<StockAdjustmentEdit />} />
    </Routes>
  </MemoryRouter>,
);

describe('Stock adjustment is a document (BUG-66)', () => {
  test('the list shows the document number and opens it', () => {
    draw('/scm/stock-adjustments');
    const cell = screen.getByText('HC-SA-2610-001');
    fireEvent.click(cell);
    expect(screen.getByRole('heading', { name: 'HC-SA-2610-001' })).toBeTruthy();
  });

  test('the detail page shows every line, with History and Edit', () => {
    draw('/scm/stock-adjustments/sa-1');
    expect(screen.getByText('leg broken')).toBeTruthy();
    expect(screen.getByText('Stool')).toBeTruthy();
    expect(screen.getByText('Water damage')).toBeTruthy();
    expect(screen.getByRole('button', { name: /History/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByRole('heading', { name: 'Edit HC-SA-2610-001' })).toBeTruthy();
  });

  test('edit is seeded from the saved lines, keeps the warehouse fixed, and sends the full new line list', async () => {
    draw('/scm/stock-adjustments/sa-1/edit');
    expect((screen.getByLabelText(/^Warehouse \*/) as HTMLSelectElement).disabled).toBe(true);
    const qty = document.querySelector('tbody input[aria-label="Qty for CH-1"]') as HTMLInputElement;
    expect(qty.value).toBe('-3');

    // The lot the -3 came from is empty now, yet the line can still take from
    // it: the 3 this document already took out are offered back.
    const takeFrom = screen.getByLabelText(/Take from for CH-1/) as HTMLSelectElement;
    expect(within(takeFrom).getByText(/3 PCS/)).toBeTruthy();
    expect(takeFrom.value).toBe(JSON.stringify(['', null]));

    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    await screen.findByRole('dialog');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.lines!.map((l) => [l.itemCode, l.qty])).toEqual([['CH-1', -2], ['CH-2', 2]]);
    expect(within(screen.getByRole('dialog')).getByText('HC-SA-2610-001 updated')).toBeTruthy();
  });
});
