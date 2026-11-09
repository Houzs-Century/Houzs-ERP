// B6 (Conts #790): Proceed PO sends the computedAt of the plan on screen, and a
// stale-plan refusal or a successful create recalculates the plan so the lines
// just ordered stop reading as short.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpResponse, MrpSku } from '../../vendor/scm/lib/mrp-queries';

const SUPPLIER = { supplierId: 'sup-1', code: '400-M001', name: 'MATTRESS CO', isMain: true };

const sku: MrpSku = {
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  itemCode: 'MAT-Q', variantKey: '', variantLabel: '', description: 'Queen mattress', category: 'MATTRESS',
  qtyNeeded: 2, stock: 0, poOutstanding: 0, shortage: 2,
  mainSupplierCode: '400-M001', mainSupplierName: 'MATTRESS CO', suppliers: [SUPPLIER],
  lines: [{
    soItemId: 'si-1', soDocNo: 'SO-T-001', lineNo: 1, createdAt: null, debtorName: 'CUST A', customerState: null,
    soDate: '2026-11-01', deliveryDate: '2026-12-01', processingDate: '2026-11-05', orderByDate: null,
    qty: 2, source: 'shortage', poNumber: null, poEta: null, shortageQty: 2, poSupplierId: null, poSupplierName: null,
  }],
};

let mrpData: MrpResponse;
const createMutate = vi.fn();
const regenerateMutate = vi.fn();
const refetch = vi.fn();

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch }),
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
  useRegenerateMrp: () => ({ mutate: regenerateMutate, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  isAdminLevel: () => true,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useCreatePosFromSoItems: () => ({ mutate: createMutate, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

const PLAN_AT = '2026-11-09T02:00:00.000Z';
const base = (stored: boolean): MrpResponse => ({
  asOf: PLAN_AT, computedAt: PLAN_AT, stored,
  categories: ['MATTRESS'], warehouses: [], skus: [sku], sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 1, shortageSkuCount: 1, shortageUnits: 2, sofaSetCount: 0, sofaSetShortageCount: 0 },
} as MrpResponse);

const proceedAndConfirm = () => {
  render(<MemoryRouter><Mrp /></MemoryRouter>);
  const tab = screen.queryByRole('tab', { name: /Mattress/i }) ?? screen.queryByRole('button', { name: /^Mattress/i });
  if (tab) fireEvent.click(tab);
  fireEvent.click(screen.getByRole('button', { name: /^Proceed PO/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(createMutate).toHaveBeenCalledTimes(1);
  return createMutate.mock.calls[0]! as [Record<string, unknown>, {
    onSuccess: (res: unknown) => void; onError: (err: unknown) => void;
  }];
};

const staleError = () => Object.assign(new Error('Some of these lines changed.'), {
  status: 409,
  body: JSON.stringify({ error: 'mrp_plan_stale', soItemIds: ['si-1'] }),
});

beforeEach(() => { createMutate.mockReset(); regenerateMutate.mockReset(); refetch.mockReset(); });

describe('MRP Proceed PO and a stale plan', () => {
  test('sends the computedAt of the plan on screen', () => {
    mrpData = base(true);
    const [body] = proceedAndConfirm();
    expect(body.planAsOf).toBe(PLAN_AT);
    expect(body.fromMrp).toBe(true);
  });

  test('a stale refusal recalculates a stored plan and says so plainly', () => {
    mrpData = base(true);
    const [, handlers] = proceedAndConfirm();
    act(() => handlers.onError(staleError()));
    expect(regenerateMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Already ordered')).toBeTruthy();
  });

  test('a successful create recalculates a stored plan', () => {
    mrpData = base(true);
    const [, handlers] = proceedAndConfirm();
    act(() => handlers.onSuccess({ total: 1, created: [{ id: 'po-1', poNumber: 'HC-PO-2611-001', supplierId: 'sup-1', lineCount: 1 }] }));
    expect(regenerateMutate).toHaveBeenCalledTimes(1);
  });

  test('a live (not stored) plan is only re-read, never written as a snapshot', () => {
    mrpData = base(false);
    const [, handlers] = proceedAndConfirm();
    act(() => handlers.onError(staleError()));
    expect(regenerateMutate).not.toHaveBeenCalled();
    expect(refetch).toHaveBeenCalled();
  });
});
