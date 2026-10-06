// Fabric / Colour on a sofa / bedframe INCREASE is a dropdown of the fabric
// master, like SO / PO / GRN (owner 2026-10-06) — it was a free-text box, so a
// typo opened found stock in a variant bucket no order could ever match.

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../../vendor/scm/lib/stock-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/stock-queries')>()),
  useInventoryBuckets: () => ({ data: [], isLoading: false }),
  useInventoryProductBreakdown: () => ({ data: { balances: [] }, isLoading: false }),
  useStockAdjustment: () => ({ isPending: false, mutateAsync: async () => ({ movement: { id: 'mv-1' } }) }),
}));
vi.mock('../../vendor/scm/lib/inventory-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/inventory-queries')>()),
  useWarehouses: () => ({ data: [{ id: 'w1', code: 'WH-A' }], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/mfg-products-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mfg-products-queries')>()),
  useMfgProducts: () => ({ data: [{ id: 1, code: '1025-(SS)', name: '1025 BEDFRAME', category: 'BEDFRAME' }], isLoading: false }),
  useMaintenanceConfig: () => ({
    data: { data: { divanHeights: [], gaps: [], legHeights: [], sofaSizes: [], sofaLegHeights: [] } },
    isLoading: false,
  }),
  useSpecialAddons: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../vendor/scm/lib/fabric-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/fabric-queries')>()),
  useFabricTrackingsLite: () => ({
    data: [
      { id: 'f1', fabric_code: 'PC151-01', supplier_code: 'DC-151-01', fabric_description: 'Grey', series: null, is_active: true },
      { id: 'f2', fabric_code: 'OLD-9', supplier_code: null, fabric_description: 'Retired', series: null, is_active: false },
    ],
    isLoading: false,
  }),
}));

vi.mock('../../vendor/scm/components/NotifyDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/NotifyDialog')>()),
  useNotify: () => async () => undefined,
}));
vi.mock('../../vendor/scm/components/ConfirmDialog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/components/ConfirmDialog')>()),
  useConfirm: () => async () => true,
}));

import { StockAdjustmentNew } from './StockAdjustmentNew';

const draw = () => render(
  <MemoryRouter initialEntries={['/scm/stock-adjustments/new']}>
    <Routes>
      <Route path="/scm/stock-adjustments/new" element={<StockAdjustmentNew />} />
    </Routes>
  </MemoryRouter>,
);

describe('New Stock Adjustment — fabric is picked from the fabric master', () => {
  test('a bedframe increase offers active fabrics by their dual-code label, not a text box', () => {
    draw();
    fireEvent.change(screen.getByLabelText(/^Warehouse \*/) as HTMLSelectElement, { target: { value: 'w1' } });
    fireEvent.change(screen.getByPlaceholderText('Type or pick a SKU code…'), { target: { value: '1025-(SS)' } });
    const qty = document.querySelector('tbody input[aria-label^="Qty for"]') as HTMLInputElement;
    fireEvent.focus(qty);
    fireEvent.change(qty, { target: { value: '1' } });

    const fabric = screen.getByLabelText('Fabric / Colour') as HTMLElement;
    expect(fabric.tagName).toBe('SELECT');
    const labels = Array.from((fabric as HTMLSelectElement).options).map((o) => o.textContent);
    expect(labels).toContain('PC151-01 (DC-151-01) — Grey');
    // A retired fabric is not offered for new stock.
    expect(labels.some((l) => l.startsWith('OLD-9'))).toBe(false);

    fireEvent.change(fabric, { target: { value: 'PC151-01' } });
    expect((screen.getByLabelText('Fabric / Colour') as HTMLSelectElement).value).toBe('PC151-01');
  });
});
