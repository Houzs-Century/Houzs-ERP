// MRP date columns (owner 2026-09-17) — Processing / SO / Delivery Date are
// offered in the Columns drawer, default-hidden, and render the SO row's
// earliest date on that basis once enabled.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse, SofaSet } from '../../vendor/scm/lib/mrp-queries';

const SUPPLIER = { supplierId: 'sup-1', code: '400-H004', name: 'HOOKKA', isMain: true };

const sofaSet = (): SofaSet => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  soItemId: 'si-1', soDocNo: 'HC-SO-9001', lineNo: 0, createdAt: '2026-09-11T00:00:00Z',
  debtorName: 'CUST A', customerState: null,
  soDate: '2026-09-11', deliveryDate: '2026-10-01', processingDate: null, orderByDate: '2026-09-20',
  itemCode: '9028-1A(LHF)', description: '9028 Sofa', variantLabel: 'PC151',
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
  categories: ['SOFA'], warehouses: [], skus: [], sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
  ...over,
});

describe('MRP date columns — selectable from the Columns drawer', () => {
  // Column visibility is persisted per table (dt:hidden:mrp); start each test clean.
  beforeEach(() => { try { localStorage.clear(); } catch { /* jsdom */ } });

  test('the three dates are offered in the picker and hidden by default', () => {
    mrpData = base({ sofaSets: [sofaSet()] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);

    // Default view carries no date column, so the SO row's delivery date is absent.
    expect(screen.queryByText('2026/10/01')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const drawer = screen.getByRole('dialog', { name: 'Columns' });
    expect(within(drawer).getByRole('button', { name: 'Processing Date' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'SO Date' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Delivery Date' })).toBeTruthy();
  });

  test('enabling Delivery Date renders the group\'s earliest delivery date', () => {
    mrpData = base({ sofaSets: [sofaSet()] });
    render(<MemoryRouter><Mrp /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /columns/i }));
    const drawer = screen.getByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Delivery Date' }));

    // The column now renders in the table (value shows outside the drawer).
    expect(screen.getAllByText('2026/10/01').length).toBeGreaterThan(0);
  });
});
