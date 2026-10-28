// MRP Sofa tab — a Sofa Accessory (FABRIC_ACCESSORY) parks under its own SO,
// next to the sofa, instead of in Others. Owner 2026-09-14: 「sofa accessory 就
// park under sofa 在 MRP 的地方 然后 under same SO 的 这样就可以开一样 PO 了」.
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

const pillowSku = (lines: Array<{ so: string; id: string }>): MrpSku => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  itemCode: 'SQUARE PILLOW', variantKey: 'fabriccode=cove-03', variantLabel: 'COVE-03',
  description: 'AMN-SQUARE PILLOW', category: 'FABRIC_ACCESSORY',
  qtyNeeded: lines.length, stock: 0, poOutstanding: 0, shortage: lines.length,
  mainSupplierCode: '400-H004', mainSupplierName: 'HOOKKA', suppliers: [SUPPLIER],
  lines: lines.map(({ so, id }) => ({
    soItemId: id, soDocNo: so, lineNo: 5, createdAt: null, debtorName: 'CUST A', customerState: null,
    soDate: '2026-09-11', deliveryDate: '2026-10-01', processingDate: null, orderByDate: null,
    qty: 1, source: 'shortage' as const, poNumber: null, poEta: null, shortageQty: 1, poSupplierId: null, poSupplierName: null,
  })),
});

describe('MRP sofa tab — Sofa Accessory under its own SO', () => {
  test('the pillow sits inside the sofa order row, not as a second row for that SO', () => {
    mrpData = base({
      categories: ['SOFA', 'FABRIC_ACCESSORY'],
      sofaSets: [sofaSet('SO-P-1', 'si-sofa', 'CUST A')],
      skus: [pillowSku([{ so: 'SO-P-1', id: 'si-pillow' }])],
    });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    expect(screen.getAllByText('SO-P-1').length).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getAllByText(/SQUARE PILLOW · COVE-03/).length).toBeGreaterThan(0);
  });

  test('a pillow-only order still gets its own row on the Sofa tab', () => {
    mrpData = base({
      categories: ['SOFA', 'FABRIC_ACCESSORY'],
      sofaSets: [sofaSet('SO-P-1', 'si-sofa', 'CUST A')],
      skus: [pillowSku([{ so: 'SO-P-2', id: 'si-pillow-2' }])],
    });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    expect(screen.getAllByText('SO-P-1').length).toBe(1);
    expect(screen.getAllByText('SO-P-2').length).toBe(1);
  });
});
