// MRP Sofa tab — the cover (皮套) rides visibly with the sofa, and the search
// box narrows a long list. Both owner 2026-09-11.
//
// COVER: a sofa order's ACCESSORY shortage line must be pulled onto the sofa's
// PO (po-grouping.ts), and the operator must SEE it. The page reads those lines
// off `data.skus`; the Sofa tab therefore requests the FULL plan (no category
// filter) so accessories are present — with `?category=SOFA` the engine drops
// them and the pull-in matched nothing (the bug this fixes). These tests render
// the page with an accessory shortage line on the same SO as a sofa module and
// assert the rider row appears under that SO.
//
// SEARCH: a query narrows the rows in view (client-side) by code / description /
// module / SO no / customer, and force-opens the match.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MrpResponse, MrpSku, SofaSet } from '../../vendor/scm/lib/mrp-queries';

const SUPPLIER = { supplierId: 'sup-1', code: '400-H004', name: 'HOOKKA', isMain: true };

const sofaSet = (soDocNo: string, soItemId: string, debtor: string): SofaSet => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  soItemId, soDocNo, lineNo: 0, createdAt: '2026-09-11T00:00:00Z',
  debtorName: debtor, customerState: null, soDate: '2026-09-11',
  deliveryDate: '2026-10-01', processingDate: null, orderByDate: '2026-09-20',
  itemCode: '9028-1A(LHF)', description: '9028 Sofa', variantLabel: 'PC151 / SEAT 26',
  modules: [], colour: 'PC151', qty: 1, orderedQty: 0, shortageQty: 1,
  poNumber: null, poEta: null, poSupplierId: null, poSupplierName: null,
  suppliers: [SUPPLIER],
});

// An ACCESSORY shortage line on SO-COVER-1 — the cover that must ride with it.
const coverSku = (): MrpSku => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  itemCode: 'PILLOW-1', variantKey: '', variantLabel: null,
  description: 'Leather cover', category: 'ACCESSORY',
  qtyNeeded: 2, stock: 0, poOutstanding: 0, shortage: 2,
  mainSupplierCode: '400-H004', mainSupplierName: 'HOOKKA',
  suppliers: [SUPPLIER],
  lines: [{
    soItemId: 'si-cover', soDocNo: 'SO-COVER-1', lineNo: 1, createdAt: null,
    debtorName: 'CUST A', customerState: null, soDate: '2026-09-11',
    deliveryDate: '2026-10-01', processingDate: null, orderByDate: null,
    qty: 2, source: 'shortage', poNumber: null, poEta: null, shortageQty: 2,
    poSupplierId: null, poSupplierName: null,
  }],
});

let mrpData: MrpResponse;

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
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

const base = (over: Partial<MrpResponse>): MrpResponse => ({
  asOf: '2026-09-11T00:00:00Z',
  categories: ['SOFA', 'ACCESSORY'], warehouses: [], skus: [], sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
  ...over,
});

describe('MRP sofa tab — the cover rides visibly with the sofa', () => {
  test('an accessory shortage line on a sofa SO shows as a rider under that SO', () => {
    mrpData = base({ sofaSets: [sofaSet('SO-COVER-1', 'si-sofa', 'CUST A')], skus: [coverSku()] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    // The rider row names the accessory and is tagged as one.
    const riderRow = screen.getAllByRole('row').find(
      (r) => /PILLOW-1/.test(String(r.textContent)) && r.querySelectorAll('tr').length === 0,
    );
    expect(riderRow).toBeTruthy();
    expect(within(riderRow!).getByText('Accessory')).toBeTruthy();
    expect(within(riderRow!).getByText('HOOKKA')).toBeTruthy();

    // The default mode is Combined, so the caption says it rides on the sofa PO.
    expect(screen.getByText(/ride on the sofa PO/i)).toBeTruthy();
  });

  test('the accessory is NOT a standalone top-level SO row on the sofa tab', () => {
    mrpData = base({ sofaSets: [sofaSet('SO-COVER-1', 'si-sofa', 'CUST A')], skus: [coverSku()] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    // Before expanding, only the sofa SO's own L1 row exists; the accessory has
    // no SO card of its own (the sofa tab renders from sofaSets).
    const soCells = screen.getAllByText('SO-COVER-1');
    // Exactly one top-level code cell for the SO (the accessory doesn't add one).
    expect(soCells.length).toBe(1);
  });
});

describe('MRP search — narrows the rows in view', () => {
  test('typing an SO no hides the other orders and force-opens the match', () => {
    mrpData = base({
      sofaSets: [
        sofaSet('SO-COVER-1', 'si-sofa-1', 'ALPHA CUSTOMER'),
        sofaSet('SO-COVER-2', 'si-sofa-2', 'BETA CUSTOMER'),
      ],
      skus: [],
    });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    expect(screen.getAllByText('SO-COVER-1').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SO-COVER-2').length).toBeGreaterThan(0);

    // Force-opening the match repeats its SO no across child module rows, so
    // assert presence with getAllByText and absence with queryByText.
    fireEvent.change(screen.getByPlaceholderText(/customer/i), { target: { value: 'SO-COVER-2' } });
    expect(screen.queryByText('SO-COVER-1')).toBeNull();
    expect(screen.getAllByText('SO-COVER-2').length).toBeGreaterThan(0);
  });

  test('a query matching a customer name finds the order', () => {
    mrpData = base({
      sofaSets: [
        sofaSet('SO-COVER-1', 'si-sofa-1', 'ALPHA CUSTOMER'),
        sofaSet('SO-COVER-2', 'si-sofa-2', 'BETA CUSTOMER'),
      ],
      skus: [],
    });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/customer/i), { target: { value: 'beta' } });
    expect(screen.queryByText('SO-COVER-1')).toBeNull();
    expect(screen.getAllByText('SO-COVER-2').length).toBeGreaterThan(0);
  });

  test('a query matching nothing shows the no-match empty state', () => {
    mrpData = base({ sofaSets: [sofaSet('SO-COVER-1', 'si-sofa-1', 'ALPHA CUSTOMER')], skus: [] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/customer/i), { target: { value: 'zzz-nothing' } });
    expect(screen.getByText(/No rows match/i)).toBeTruthy();
  });
});
