/* The MRP page renders a tab for every category its catalogue holds.
 *
 * THE DROP THIS REPRODUCES. `mfg_product_category` has nine members; the page
 * had four tabs. A sales-order line on a DINING / BEDLINES / DIFFUSER / CARPET
 * product was planned by computeMrp, given a real quantity, and rendered on NO
 * tab — the server dropped it at `?category=<tab>` and the page filtered it out
 * again at `s.category === <tab>`. Nothing warned, because on this screen a
 * missing row and a covered row look identical.
 *
 * Asserted through the RENDERED page rather than the helper alone, because the
 * helper being right is not the claim — the claim is that the operator can
 * reach the row. Same module-seam mock harness as mrpUndated.test.tsx.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse } from '../../vendor/scm/lib/mrp-queries';

const EMPTY_TOTALS = {
  skuCount: 0, shortageSkuCount: 0, shortageUnits: 0,
  sofaSetCount: 0, sofaSetShortageCount: 0,
};

/* The nine members of mfg_product_category, as the server reports them for a
   company whose catalogue holds all of them — sorted, exactly as mrp.ts emits
   `[...categorySet].sort()`. */
const CATALOGUE = [
  'ACCESSORY', 'BEDFRAME', 'BEDLINES', 'CARPET', 'DIFFUSER',
  'DINING', 'MATTRESS', 'SERVICE', 'SOFA',
];

const diningSku = (): MrpResponse['skus'] => [{
  warehouseId: null, warehouseCode: null, warehouseName: null,
  itemCode: 'AN-TABLE TOP', variantKey: 'AN-TABLE TOP', variantLabel: null,
  description: 'Dining table top', category: 'DINING',
  qtyNeeded: 3, stock: 0, poOutstanding: 0, shortage: 3,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [],
  lines: [{
    soItemId: 'si-dining', soDocNo: 'SO-DINING',
    debtorName: 'Beta', customerState: null,
    soDate: '2026-07-01', deliveryDate: '2026-12-01', processingDate: null, orderByDate: null,
    qty: 3, source: 'shortage', poNumber: null, poEta: null, shortageQty: 3,
    poSupplierId: null, poSupplierName: null,
  }],
}];

let mrpData: MrpResponse;
/** What the page last ASKED the server for — a tab that displays one category
 *  while requesting another is this bug with extra steps. */
let lastCategory: string | undefined;

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: (args: { category: string }) => {
    lastCategory = args.category;
    return { data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} };
  },
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
  useRegenerateMrp: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  isAdminLevel: () => true,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useCreatePosFromSoItems: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

const renderPage = () => render(<MemoryRouter><Mrp /></MemoryRouter>);

describe('MRP — a tab for every category the catalogue holds', () => {
  beforeEach(() => {
    mrpData = {
      asOf: '2026-09-10T00:00:00Z',
      categories: CATALOGUE, warehouses: [], skus: diningSku(), sofaSets: [],
      totals: EMPTY_TOTALS,
    };
    lastCategory = undefined;
  });

  test('a DINING order line is reachable — the tab exists and its row renders', () => {
    renderPage();

    const tab = screen.getByRole('tab', { name: 'Dining' });
    fireEvent.click(tab);

    // The page asked the server for the category the tab names…
    expect(lastCategory).toBe('DINING');
    // …and the row the engine planned is on screen.
    expect(screen.getByText('AN-TABLE TOP')).toBeTruthy();
  });

  test('the four original tabs are still there, in their original order', () => {
    renderPage();
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names.slice(0, 4)).toEqual(['Sofa', 'Bedframe', 'Mattress', 'Accessories']);
  });

  test('every non-service catalogue category has a tab, and SERVICE has none', () => {
    renderPage();
    const names = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(names).toEqual([
      'Sofa', 'Bedframe', 'Mattress', 'Accessories',
      'Bedlines', 'Carpet', 'Diffuser', 'Dining',
    ]);
    expect(names).not.toContain('Service');
  });

  test('a response that carries no category list still renders the four originals', () => {
    /* A request in flight, or a backend predating `categories`, must not blank
       the tab bar — the failure mode of a derived list is an empty one. */
    mrpData = { ...mrpData, categories: [] };
    renderPage();
    expect(screen.getAllByRole('tab').map((t) => t.textContent))
      .toEqual(['Sofa', 'Bedframe', 'Mattress', 'Accessories']);
  });
});
