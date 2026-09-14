// MRP "Export lines" — the WIRING half of staff request #28. The row rule is
// pinned as a pure function in mrp-export-lines.test.ts; what is pinned here is
// that the button exports exactly the rows the table is showing: the active tab,
// the page's own search, and DataTable's per-column funnels (client-side and
// persisted, so invisible to the page unless DataTable reports them).
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MrpLine, MrpResponse, MrpSku } from '../../vendor/scm/lib/mrp-queries';

const downloads: Array<{ name: string; content: string }> = [];
vi.mock('../../lib/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/csv')>()),
  downloadCSV: (name: string, content: string) => { downloads.push({ name, content }); },
}));

const line = (soItemId: string, soDocNo: string, debtorName: string, source: MrpLine['source']): MrpLine => ({
  soItemId, soDocNo, lineNo: 1, createdAt: null, debtorName, customerState: null,
  soDate: '2026-09-01', deliveryDate: '2026-10-01', processingDate: null, orderByDate: null,
  qty: 1, source, poNumber: null, poEta: null, shortageQty: source === 'shortage' ? 1 : 0,
  poSupplierId: null, poSupplierName: null,
});

const bedframe = (itemCode: string, wh: string, ln: MrpLine, stock: number): MrpSku => ({
  warehouseId: wh, warehouseCode: wh, warehouseName: wh,
  itemCode, variantKey: 'v', variantLabel: 'Oak', description: `${itemCode} bedframe`,
  category: 'BEDFRAME', qtyNeeded: 1, stock, poOutstanding: 0,
  shortage: ln.source === 'shortage' ? 1 : 0,
  mainSupplierCode: null, mainSupplierName: null, suppliers: [], lines: [ln],
});

const mrpData: MrpResponse = {
  asOf: '2026-09-14T00:00:00Z',
  categories: ['SOFA', 'BEDFRAME'], warehouses: [],
  skus: [
    bedframe('BF-A', 'KL', line('si-1', 'SO-1', 'ALPHA', 'shortage'), 0),
    bedframe('BF-B', 'PG', line('si-2', 'SO-2', 'BETA', 'stock'), 3),
  ],
  sofaSets: [],
  undated: { lines: 0, shortageUnits: 0, sofaSets: 0, sofaShortageUnits: 0, hidden: true },
  totals: { skuCount: 2, shortageSkuCount: 1, shortageUnits: 1, sofaSetCount: 0, sofaSetShortageCount: 0 },
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

const exportedSoNos = (): string[] => {
  const last = downloads.at(-1)!;
  const [header, ...rows] = last.content.split('\r\n');
  const soCol = header!.split(',').indexOf('Sales Order');
  return rows.map((r) => r.split(',')[soCol]!);
};

const openBedframe = () => {
  render(<MemoryRouter><Mrp /></MemoryRouter>);
  fireEvent.click(screen.getByRole('tab', { name: 'Bedframe' }));
};

describe('MRP Export lines', () => {
  beforeEach(() => {
    downloads.length = 0;
    localStorage.clear();
  });

  test('writes one row per SO line on the active tab, as a dated CSV named for the tab', () => {
    openBedframe();
    fireEvent.click(screen.getByRole('button', { name: /Export lines/i }));
    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toMatch(/^mrp-bedframe-lines-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(exportedSoNos().sort()).toEqual(['SO-1', 'SO-2']);
    expect(downloads[0]!.content).toContain('BF-B,BF-B bedframe,Oak,SO-2,BETA');
  });

  test("a DataTable column funnel narrows the export, exactly as it narrows the table", () => {
    localStorage.setItem('dt:filters:mrp', JSON.stringify({ warehouse: ['KL'] }));
    openBedframe();
    fireEvent.click(screen.getByRole('button', { name: /Export lines/i }));
    expect(exportedSoNos()).toEqual(['SO-1']);
  });

  test("the page's search narrows the export", () => {
    openBedframe();
    fireEvent.change(screen.getByPlaceholderText('Code, description, SO no, customer…'), { target: { value: 'BETA' } });
    fireEvent.click(screen.getByRole('button', { name: /Export lines/i }));
    expect(exportedSoNos()).toEqual(['SO-2']);
  });

  test('the existing per-row Export is still there, unchanged', () => {
    openBedframe();
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeTruthy();
  });
});
