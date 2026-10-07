/* Stock Transfer / Stock Adjustment line tables (owner 2026-10-06):
   - the SO column widths in SalesOrderDetail.module.css are keyed by POSITION
     (SO col 2 = Qty, 56px); Transfer's col 2 is the variant bucket and
     Adjustment's is the product name, both cut to 56px. These tables opt out
     with `tableOwnWidths`.
   - `.actionsCell` is display:inline-flex; put on a <td> it stops being a table
     cell and its bottom rule breaks off from the row. It must wrap the buttons
     inside a plain <td>, as every other line table does.
   - two buckets often differ only at the END of their label, which a closed
     select cuts off, so the picked bucket is also printed in full below it. */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import styles from './SalesOrderDetail.module.css';

const LONG = 'fabriccode=pc151-01|gap=12"|divanheight=10"|special=hb fully covered instead of divan';

vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useInventoryBuckets: (itemCode: string | null, warehouseId: string | null) => ({
    data: itemCode && warehouseId ? [
      { warehouse_id: warehouseId, variant_key: 'fabriccode=pc151-01|gap=12"|divanheight=10"', batch_no: null, product_name: 'Bed', qty: 1 },
      { warehouse_id: warehouseId, variant_key: LONG, batch_no: null, product_name: 'Bed', qty: 1 },
    ] : [],
    isLoading: false,
  }),
  useInventoryProductBreakdown: () => ({ data: { balances: [] }, isLoading: false }),
  useCreateStockTransfer: () => ({ isPending: false, mutate: () => undefined }),
  useStockAdjustment: () => ({ isPending: false, mutate: () => undefined, mutateAsync: async () => ({}) }),
  useUpdateStockAdjustment: () => ({ isPending: false, mutateAsync: async () => ({}) }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }, { id: 'w2', code: 'WH-B' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: '1025-(SS)', name: '1025 BEDFRAME', category: 'ACCESSORY' }], isLoading: false }),
  useMaintenanceConfig: () => ({ data: null, isLoading: false }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
}));

vi.mock('../../vendor/scm/lib/fabric-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => async () => undefined,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockTransferNew } from './StockTransferNew';
import { StockAdjustmentNew } from './StockAdjustmentNew';

const draw = (el: React.ReactElement) => render(
  <MemoryRouter initialEntries={['/x']}><Routes><Route path="/x" element={el} /></Routes></MemoryRouter>,
);

const assertLayout = () => {
  const table = document.querySelector('table')!;
  expect(table.classList.contains(styles.tableOwnWidths!)).toBe(true);
  // No <td> carries the inline-flex actions class itself.
  expect(document.querySelectorAll(`td.${styles.actionsCell}`)).toHaveLength(0);
  expect(document.querySelectorAll(`td > .${styles.actionsCell}`).length).toBeGreaterThan(0);
};

describe('stock line tables', () => {
  test('Stock Transfer: own widths, actions inside the cell, picked bucket shown in full', () => {
    draw(<StockTransferNew />);
    assertLayout();
    const [from] = screen.getAllByRole('combobox') as HTMLSelectElement[];
    fireEvent.change(from!, { target: { value: 'w1' } });
    fireEvent.change(screen.getByPlaceholderText('Type code…'), { target: { value: '1025-(SS)' } });
    const bucket = Array.from(document.querySelectorAll('tbody select'))[0] as HTMLSelectElement;
    fireEvent.change(bucket, { target: { value: LONG } });
    expect(screen.getByText('fabriccode pc151-01 · gap 12" · divanheight 10" · special hb fully covered instead of divan'))
      .toBeTruthy();
  });

  test('Stock Adjustment: own widths, actions inside the cell', () => {
    draw(<StockAdjustmentNew />);
    assertLayout();
  });
});
