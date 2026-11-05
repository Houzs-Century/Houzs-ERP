// MRP Sofa tab, 2990-0018: the pooled plan may give an SO's own PO to an
// earlier-delivery SO (owner 2026-10-26 keeps that rule). The SO that raised the
// PO says which SO took it, so purchasing re-orders it instead of asking IT.
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MrpResponse, SofaSet } from '../../vendor/scm/lib/mrp-queries';

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

describe('MRP sofa tab: own PO planned for another SO', () => {
  test('the SO that raised the PO names the SO it went to', () => {
    mrpData = base({
      categories: ['SOFA'],
      sofaSets: [{
        ...sofaSet('2990-SO-2608-056', 'si-056', 'Lee Cherng Woei'),
        ownPoSlottedTo: [{ poNumber: '2990-PO-2610-024', soDocNo: '2990-SO-2610-031', deliveryDate: '2026-10-26' }],
      }],
    });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.getByText(/own PO 2990-PO-2610-024 is planned for 2990-SO-2610-031/)).toBeTruthy();
  });

  test('an SO with no own PO elsewhere shows no notice', () => {
    mrpData = base({ categories: ['SOFA'], sofaSets: [sofaSet('2990-SO-2610-031', 'si-031', 'EVON')] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(screen.queryByText(/is planned for/)).toBeNull();
  });
});
