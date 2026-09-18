/* MRP: a row that still has to be ordered is TINTED, not just marked with a thin
 * bar (owner 2026-09-15: "我的 MRP 界面的颜色好像有一点不一样了 ... 之前是有一点看到
 * 颜色的"). The hand-built table painted `.skuRowShort` with a petrol wash plus
 * the bar; the move onto DataTable (#3696) kept only the bar, so every row read
 * plain white/grey.
 *
 * Rendered with the page's REAL stylesheet: Mrp.module.css is injected with its
 * class names mapped to the hashed names the component uses, and jsdom's
 * computed style of the rendered cells is asserted. */
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import type { MrpResponse, MrpSku } from '../../vendor/scm/lib/mrp-queries';
import styles from './Mrp.module.css';

const sku = (itemCode: string, shortage: number): MrpSku => ({
  warehouseId: null, warehouseCode: null, warehouseName: null,
  itemCode, variantKey: '', variantLabel: null,
  description: `${itemCode} mattress`, category: 'MATTRESS',
  qtyNeeded: 2, stock: 2 - shortage, poOutstanding: 0, shortage,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [],
  lines: [{
    soItemId: `si-${itemCode}`, soDocNo: `SO-${itemCode}`, lineNo: 1, createdAt: null,
    debtorName: 'CUST', customerState: null, soDate: '2026-09-01',
    deliveryDate: '2026-10-01', processingDate: null, orderByDate: null,
    qty: 2, source: shortage > 0 ? 'shortage' : 'stock', poNumber: null, poEta: null,
    shortageQty: shortage, poSupplierId: null, poSupplierName: null,
  }],
});

const mrpData: MrpResponse = {
  asOf: '2026-09-15T00:00:00Z',
  categories: ['MATTRESS'], warehouses: [], sofaSets: [],
  skus: [sku('MT-SHORT', 2), sku('MT-STOCK', 0)],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 2, shortageSkuCount: 1, shortageUnits: 2, sofaSetCount: 0, sofaSetShortageCount: 0 },
};

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

beforeAll(() => {
  // `_rowShort_<hash>` -> every `.name` in the module becomes `._name_<hash>`.
  const hash = String(styles.rowShort).replace(/^_rowShort_/, '');
  const css = readFileSync('src/pages/scm-v2/Mrp.module.css', 'utf8')
    .replace(/\.([a-zA-Z][\w-]*)/g, (_m, name: string) => `._${name}_${hash}`);
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);
});

const dataRowOf = (code: string) => screen.getByText(code).closest('tr[data-vrow]') as HTMLTableRowElement;
const paint = (td: Element) => {
  const cs = getComputedStyle(td);
  return `${cs.backgroundColor} ${cs.boxShadow}`;
};

describe('MRP shortage rows carry their colour on the shared DataTable', () => {
  test('every cell of a shortage row is washed petrol; a covered row is not', () => {
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    const tab = screen.queryByRole('tab', { name: /mattress/i });
    if (tab) fireEvent.click(tab);

    const shortCells = [...dataRowOf('MT-SHORT').cells];
    expect(shortCells.length).toBeGreaterThan(3);
    for (const td of shortCells) expect(paint(td)).toMatch(/rgba\(22,\s*105,\s*95,\s*0\.08\)/);
    // The deep-petrol bar stays on the leading cell.
    expect(getComputedStyle(shortCells[0]!).boxShadow).toMatch(/inset 3px 0 0 #08352e/);

    for (const td of dataRowOf('MT-STOCK').cells) expect(paint(td)).not.toMatch(/rgba\(22,\s*105,\s*95/);
  });

  test('the expanded drill-down under a shortage row is not washed', () => {
    render(<MemoryRouter><Mrp /></MemoryRouter>);
    const tab = screen.queryByRole('tab', { name: /mattress/i });
    if (tab) fireEvent.click(tab);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    const detail = dataRowOf('MT-SHORT').nextElementSibling!;
    expect(detail.hasAttribute('data-vrow')).toBe(false);
    for (const td of (detail as HTMLTableRowElement).cells) expect(paint(td)).not.toMatch(/rgba\(22,\s*105,\s*95,\s*0\.08\)/);
  });
});
