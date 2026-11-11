// MRP Sofa tab — "One supplier per sofa set" covers the sofa MODULES only.
// HC-0203 (Sim 2026-11-02): HC-SO-2610-342's set is Hookka, but STOOL 1 is made
// by Dorsettloft only, and Proceed PO refused the whole order. A Sofa Accessory
// is not in the dye lot, so it may go on its own supplier's PO.
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse, MrpSku, SofaSet } from '../../vendor/scm/lib/mrp-queries';

const HOOKKA = { supplierId: 'sup-h004', code: '400-H004', name: 'HOOKKA INDUSTRIES', isMain: true };
const DORSETT = { supplierId: 'sup-d004', code: '400-D004', name: 'DORSETTLOFT SOFA', isMain: false };

const sofaSet = (itemCode: string, soItemId: string, lineNo: number, suppliers: SofaSet['suppliers']): SofaSet => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  soItemId, soDocNo: 'SO-T-342', lineNo, createdAt: '2026-10-26T00:00:00Z',
  debtorName: 'MR HAW', customerState: null, soDate: '2026-10-26',
  deliveryDate: '2026-11-23', processingDate: '2026-10-30', orderByDate: '2026-11-10',
  itemCode, description: '9058 Sofa', variantLabel: 'HR805-90 / SEAT 30',
  modules: [], colour: 'HR805-90', qty: 1, orderedQty: 0, shortageQty: 1,
  poNumber: null, poEta: null, poSupplierId: null, poSupplierName: null,
  suppliers,
});

const stoolSku: MrpSku = {
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  itemCode: 'STOOL 1', variantKey: 'fabriccode=hr805-30', variantLabel: 'HR805-30',
  description: 'STOOL 1', category: 'FABRIC_ACCESSORY',
  qtyNeeded: 4, stock: 0, poOutstanding: 0, shortage: 4,
  mainSupplierCode: '400-D004', mainSupplierName: 'DORSETTLOFT SOFA', suppliers: [{ ...DORSETT, isMain: true }],
  lines: [{
    soItemId: 'si-stool', soDocNo: 'SO-T-342', lineNo: 6, createdAt: null, debtorName: 'MR HAW', customerState: null,
    soDate: '2026-10-26', deliveryDate: '2026-11-23', processingDate: '2026-10-30', orderByDate: null,
    qty: 4, source: 'shortage', poNumber: null, poEta: null, shortageQty: 4, poSupplierId: null, poSupplierName: null,
  }],
};

let mrpData: MrpResponse;
const mutate = vi.fn();

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
  useCreatePosFromSoItems: () => ({ mutate, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

const base = (over: Partial<MrpResponse>): MrpResponse => ({
  asOf: '2026-10-26T00:00:00Z',
  categories: ['SOFA', 'FABRIC_ACCESSORY'], warehouses: [], skus: [], sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 0, sofaSetShortageCount: 0 },
  ...over,
});

const proceed = () => {
  render(<MemoryRouter><Mrp /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /^Proceed PO/ }));
};

beforeEach(() => mutate.mockReset());

describe('MRP sofa tab — one supplier per sofa set, modules only', () => {
  test('a stool on its own supplier does not block the order; both suppliers are sent', () => {
    mrpData = base({
      sofaSets: [
        sofaSet('9058-1A(LHF)', 'si-1a', 0, [HOOKKA, DORSETT]),
        sofaSet('9058-CNR', 'si-cnr', 1, [HOOKKA, DORSETT]),
      ],
      skus: [stoolSku],
    });
    proceed();
    expect(screen.queryByText('One supplier per sofa set')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const picks = mutate.mock.calls[0]![0].picks as Array<{ soItemId: string; supplierId: string }>;
    expect(Object.fromEntries(picks.map((p) => [p.soItemId, p.supplierId]))).toEqual({
      'si-1a': 'sup-h004', 'si-cnr': 'sup-h004', 'si-stool': 'sup-d004',
    });
  });

  test('two modules of one sofa model on different suppliers are still refused', () => {
    mrpData = base({
      sofaSets: [
        sofaSet('9058-1A(LHF)', 'si-1a', 0, [HOOKKA, DORSETT]),
        sofaSet('9058-CNR', 'si-cnr', 1, [{ ...DORSETT, isMain: true }]),
      ],
    });
    proceed();
    expect(screen.getByText('One supplier per sofa model')).toBeTruthy();
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe('MRP sofa tab — two models on one order may use two suppliers after a confirm (HC-SO-2610-104)', () => {
  const twoModels = () => base({
    sofaSets: [
      sofaSet('8030-1A(LHF)', 'si-8030', 0, [HOOKKA, DORSETT]),
      sofaSet('8069-1A(LHF)', 'si-8069', 1, [{ ...DORSETT, isMain: true }]),
    ],
  });

  test('the popup names each model and its supplier, and Cancel sends nothing', () => {
    mrpData = twoModels();
    proceed();
    expect(screen.getByText('Use 2 suppliers?')).toBeTruthy();
    expect(screen.getByText(/8030 from HOOKKA INDUSTRIES, 8069 from DORSETTLOFT SOFA/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Use 2 suppliers?')).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
  });

  test('Yes leads to the usual Proceed PO step, which sends the confirm flag with each model on its own supplier', () => {
    mrpData = twoModels();
    proceed();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, use 2 suppliers' }));
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0]![0] as { allowSofaSupplierSplit: boolean; picks: Array<{ soItemId: string; supplierId: string }> };
    expect(body.allowSofaSupplierSplit).toBe(true);
    expect(Object.fromEntries(body.picks.map((p) => [p.soItemId, p.supplierId]))).toEqual({
      'si-8030': 'sup-h004', 'si-8069': 'sup-d004',
    });
  });

  test('one supplier for the whole order goes straight to Proceed PO without the flag', () => {
    mrpData = base({
      sofaSets: [
        sofaSet('8030-1A(LHF)', 'si-8030', 0, [HOOKKA]),
        sofaSet('8069-1A(LHF)', 'si-8069', 1, [HOOKKA]),
      ],
    });
    proceed();
    expect(screen.queryByText('Use 2 suppliers?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((mutate.mock.calls[0]![0] as { allowSofaSupplierSplit: boolean }).allowSofaSupplierSplit).toBe(false);
  });
});
