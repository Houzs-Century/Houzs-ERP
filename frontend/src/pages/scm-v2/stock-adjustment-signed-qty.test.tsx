// The sign of Qty IS the direction of a stock adjustment (owner 2026-09-18):
// a POSITIVE qty increases stock, a NEGATIVE qty decreases it, and 0 is invalid.
// There is no Increase/Decrease toggle. These tests pin that mapping end to end
// — what the form actually POSTs to /inventory/adjustments for each sign — plus
// the two write-contract gates that must survive the redesign: an INCREASE
// sends no bucket, a DECREASE must pick an existing lot and sends its
// (variant_key) so the right stock is reduced.

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';

type AdjustCall = {
  warehouseId: string;
  itemCode: string;
  qtyDelta: number;
  reasonCode: string;
  itemGroup?: string;
  variants?: Record<string, unknown>;
  batchNo?: string;
  variantKey?: string;
};
const adjustCalls: AdjustCall[] = [];

vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  // A single open lot: plain (no variant, no batch), 50 on hand.
  useInventoryBuckets: (itemCode: string | null, warehouseId: string | null) => ({
    data: itemCode && warehouseId ? [{ warehouse_id: warehouseId, variant_key: '', batch_no: null, product_name: 'Chair', qty: 50 }] : [],
    isLoading: false,
  }),
  // Current balance 12 at w1 so a decrease of 4 stays positive (no below-zero path).
  useInventoryProductBreakdown: (itemCode: string | null) => ({
    data: { balances: itemCode ? [{ warehouse_id: 'w1', item_code: itemCode, qty: 12 }] : [] },
    isLoading: false,
  }),
  useStockAdjustment: () => ({
    isPending: false,
    mutateAsync: async (vars: AdjustCall) => {
      adjustCalls.push(vars);
      return { movement: { id: `mv-${adjustCalls.length}` } };
    },
  }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: 'CH-1', name: 'Chair', category: 'ACCESSORY' }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: null, isLoading: false }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
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

import { StockAdjustmentNew } from './StockAdjustmentNew';

afterEach(() => {
  adjustCalls.length = 0;
  notify.mockClear();
});

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/stock-adjustments/new']}>
    <Routes>
      <Route path="/scm/stock-adjustments/new" element={<StockAdjustmentNew />} />
      <Route path="/scm/stock-adjustments" element={<div>adjustments list page</div>} />
    </Routes>
  </MemoryRouter>,
);

const setWarehouse = () =>
  fireEvent.change(screen.getByLabelText(/^Warehouse \*/) as HTMLSelectElement, { target: { value: 'w1' } });
const pickSku = () =>
  fireEvent.change(screen.getByPlaceholderText('Type or pick a SKU code…'), { target: { value: 'CH-1' } });
const qtyInputs = () => Array.from(document.querySelectorAll('tbody input[type="number"]')) as HTMLInputElement[];
const setQty = (value: string, i = 0) => fireEvent.change(qtyInputs()[i]!, { target: { value } });
const reasonSelects = () => screen.getAllByLabelText(/Reason for/) as HTMLSelectElement[];
const setReason = (i = 0) => fireEvent.change(reasonSelects()[i]!, { target: { value: 'FOUND' } });
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save Adjustment/ }));

describe('New Stock Adjustment — signed qty encodes the direction', () => {
  test('a POSITIVE qty posts an INCREASE: qtyDelta > 0, no bucket / variant fields', async () => {
    draw();
    setWarehouse();
    pickSku();
    setQty('3');
    setReason();
    save();
    await screen.findByRole('dialog');

    expect(adjustCalls).toHaveLength(1);
    expect(adjustCalls[0]!.qtyDelta).toBe(3);
    // Increase of an ACCESSORY: no variant group, and no bucket is picked.
    expect(adjustCalls[0]!.variantKey).toBeUndefined();
    expect(adjustCalls[0]!.variants).toBeUndefined();
    expect(adjustCalls[0]!.itemGroup).toBeUndefined();
  });

  test('a NEGATIVE qty is blocked until a lot is picked, then posts a DECREASE: qtyDelta < 0', async () => {
    draw();
    setWarehouse();
    pickSku();
    setQty('-4');
    setReason();

    // With an open lot present, a decrease must say which lot — Save is blocked.
    expect((screen.getByRole('button', { name: /Save Adjustment/ }) as HTMLButtonElement).disabled).toBe(true);

    // Pick the (plain) lot, then Save posts the negative delta.
    fireEvent.change(screen.getByLabelText(/Take from for/) as HTMLSelectElement, { target: { value: JSON.stringify(['', null]) } });
    save();
    await screen.findByRole('dialog');

    expect(adjustCalls).toHaveLength(1);
    expect(adjustCalls[0]!.qtyDelta).toBe(-4);
    // The plain lot's variant_key is '' → sent as undefined (backend reads '').
    expect(adjustCalls[0]!.variantKey).toBeUndefined();
  });

  test('qty 0 is invalid — Save stays disabled and nothing is posted', () => {
    draw();
    setWarehouse();
    pickSku();
    setQty('0');
    setReason();
    expect((screen.getByRole('button', { name: /Save Adjustment/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(adjustCalls).toHaveLength(0);
  });

  test('mixed lines: a +3 increase and a −2 decrease post one row each, signs intact', async () => {
    draw();
    setWarehouse();
    // Line 1 — increase +3.
    pickSku();
    setQty('3', 0);
    setReason(0);
    // Line 2 — add, decrease −2, pick the lot.
    fireEvent.click(screen.getAllByRole('button', { name: /Add line/i })[0]!);
    fireEvent.change(screen.getAllByPlaceholderText('Type or pick a SKU code…')[1]!, { target: { value: 'CH-1' } });
    setQty('-2', 1);
    setReason(1);
    // Only the decrease line (line 2) shows a "Take from" picker; the +3
    // increase line has none, so this is the single one on screen.
    fireEvent.change(screen.getByLabelText(/Take from for/) as HTMLSelectElement, { target: { value: JSON.stringify(['', null]) } });

    save();
    await screen.findByRole('dialog');

    expect(adjustCalls.map((c) => c.qtyDelta)).toEqual([3, -2]);
    // Confirm the dialog reports both saved.
    expect(within(screen.getByRole('dialog')).getByText(/2 stock adjustments saved/)).toBeTruthy();
  });
});
