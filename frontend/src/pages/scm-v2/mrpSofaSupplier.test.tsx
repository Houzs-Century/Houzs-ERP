// EVERY ROW THAT NAMES A SKU MUST NAME THAT SKU'S SUPPLIER.
//
// Owner, 2026-08-19: one sales order's three sofa modules — same fabric, same
// seat, same leg, one item code each — rendered as three SHORT rows on the MRP
// Sofa tab with two of them showing "— none —" in the Supplier cell and the
// third offering the dropdown, while production held five identical bindings
// for all three codes (verified byte-for-byte against the SO lines, run
// 32264907247).
//
// The Sofa tab folds each SofaSet into a PER-MODULE MrpSku (sofaSetsToSkus) and
// then groups those under one Sales Order row (groupBySo). This pins the half a
// grouper can break: the supplier the row shows must come from the module the
// row NAMES, never from the parent group or from whichever module sorted first.
// Every grouper used to copy the first child's `suppliers` onto the group; the
// field is gone, and this is the rendered claim it was one careless reader away
// from breaking.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { MrpResponse, SofaSet } from '../../vendor/scm/lib/mrp-queries';

const MODULE_CODES = ['9028-1A(LHF)', '9028-1A(RHF)', '9028-1NA'] as const;

const SUPPLIERS = [
  { supplierId: 'sup-h004', code: '400-H004', name: 'HOOKKA INDUSTRIES', isMain: true },
  { supplierId: 'sup-a004', code: '400-A004', name: 'ALT A', isMain: false },
];

const set = (itemCode: string, soItemId: string, lineNo: number): SofaSet => ({
  warehouseId: 'W1', warehouseCode: 'KL', warehouseName: 'KL WAREHOUSE',
  soItemId, soDocNo: 'SO-T-004', lineNo, createdAt: '2026-08-19T00:00:00Z',
  debtorName: 'A', customerState: null, soDate: '2026-08-19',
  deliveryDate: '2026-09-03', processingDate: '2026-08-19', orderByDate: '2026-08-25',
  itemCode, description: '9028 Sofa', variantLabel: 'PC151-07 / SEAT 26 / LEG DEFAULT',
  modules: [], colour: 'PC151-07', qty: 1, orderedQty: 0, shortageQty: 1,
  poNumber: null, poEta: null, poSupplierId: null, poSupplierName: null,
  suppliers: SUPPLIERS,
});

const mrpData: MrpResponse = {
  asOf: '2026-08-19T00:00:00Z',
  categories: ['SOFA'], warehouses: [], skus: [],
  sofaSets: MODULE_CODES.map((code, i) => set(code, `si-${i}`, i)),
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 0, shortageSkuCount: 0, shortageUnits: 0, sofaSetCount: 3, sofaSetShortageCount: 3 },
};

vi.mock('../../vendor/scm/lib/mrp-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/mrp-queries')>()),
  useMrp: () => ({ data: mrpData, isLoading: false, isError: false, error: null, refetch: () => {} }),
  useCategoryLeadTimes: () => ({ data: { leadTimes: {} }, isLoading: false }),
  useUpdateCategoryLeadTime: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock('../../vendor/scm/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }),
  isAdminLevel: () => true,
}));
vi.mock('../../vendor/scm/lib/suppliers-queries', () => ({
  useCreatePosFromSoItems: () => ({ mutate: () => {}, mutateAsync: async () => ({}), isPending: false }),
}));

import { Mrp } from './Mrp';

describe('MRP sofa tab — every module row names its own supplier', () => {
  test('three bound modules of one SO all show the supplier', () => {
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    /* Leaf rows only — the outer table row that CONTAINS the module table also
       matches on text, and counting it would make the length assertion pass for
       the wrong reason. */
    const textOf = (el: Element): string => String(el.textContent);
    const moduleRows = screen.getAllByRole('row')
      .filter((r) => /9028-/.test(textOf(r)) && r.querySelectorAll('tr').length === 0);
    expect(moduleRows).toHaveLength(3);
    /* The whole shape in one assertion, so a failure prints which module lost
       its supplier rather than a bare "expected null". */
    const supplierShownIn = (row: Element): string => {
      const select = row.querySelector('select');
      if (!select) return '— none —';
      const chosen = Array.from(select.options).find((o) => o.selected);
      return chosen ? String(chosen.textContent) : '(nothing selected)';
    };
    expect(
      moduleRows.map((r) => {
        const code = MODULE_CODES.filter((c) => textOf(r).includes(`${c} ·`)).join('+');
        return `${code}: ${supplierShownIn(r)}`;
      }).sort(),
    ).toEqual(MODULE_CODES.map((c) => `${c}: HOOKKA INDUSTRIES ★ · 400-H004`).sort());
    for (const row of moduleRows) {
      expect(within(row).queryByText('— none —')).toBeNull();
    }
  });
});
