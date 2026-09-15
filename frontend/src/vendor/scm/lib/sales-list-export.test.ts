/* The Sales Order and Delivery Order lists' exports read the WHOLE filtered
 * listing with the list's own parameters (owner 2026-09-15).
 *
 * The network is the one seam: authedFetch is faked and every request it is
 * asked for is recorded, so what is asserted is exactly what the server is
 * asked — the tab, the search, the sort and, on the Sales Order list, the
 * second-level filter rows — and that no file is written from a read the server
 * stopped or a listing that moved under the export.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  answer: (_path: string): unknown => ({}),
  aoa: [] as unknown[][],
  written: [] as string[],
  cells: {} as Record<string, { t?: string; z?: string }>,
}));

vi.mock('./authed-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./authed-fetch')>()),
  authedFetch: vi.fn(async (path: string) => { h.calls.push(path); return h.answer(path); }),
}));
vi.mock('../../../lib/xlsx-runtime', () => ({
  utils: {
    aoa_to_sheet: (aoa: unknown[][]) => {
      h.aoa = aoa;
      const ws: Record<string, unknown> = {};
      aoa.forEach((row, r) => row.forEach((v, c) => { if (typeof v === 'number') ws[`${c}:${r}`] = { t: 'n' }; }));
      h.cells = ws as typeof h.cells;
      return ws;
    },
    encode_cell: ({ r, c }: { r: number; c: number }) => `${c}:${r}`,
    book_new: () => ({}),
    book_append_sheet: () => {},
  },
  writeFileXLSX: (_wb: unknown, name: string) => { h.written.push(name); },
}));

import {
  doListParams,
  fetchAllDoListRows,
  fetchAllSoListRows,
  fetchDoLineExport,
  fetchSoLineExport,
  soListParams,
  writeDoLineExportXlsx,
  writeSoLineExportXlsx,
} from './sales-list-export';
import { SO_LINE_EXPORT_COLUMNS } from './so-line-export-columns';
import { DO_LINE_EXPORT_COLUMNS } from './do-line-export-columns';

const query = (path: string) => new URL(path, 'http://x').searchParams;

beforeEach(() => {
  h.calls = [];
  h.aoa = [];
  h.written = [];
});

describe('the parameters are the list\'s own', () => {
  it('Sales Order: tab upper-cased, search trimmed, sort, and every complete filter row as an f param', () => {
    const usp = soListParams({
      status: 'confirmed', q: '  alice ', sort: 'doc_no:asc',
      filters: [
        { field: 'orderDate', op: 'between', value: '2026-08-01~2026-08-31' },
        { field: 'branding', op: 'contains', value: '' }, // incomplete: the list does not send it either
        { field: 'state', op: 'is', value: 'SELANGOR' },
      ],
    });
    expect(usp.get('status')).toBe('CONFIRMED');
    expect(usp.get('q')).toBe('alice');
    expect(usp.get('sort')).toBe('doc_no:asc');
    expect(usp.getAll('f')).toEqual(['orderDate:between:2026-08-01~2026-08-31', 'state:is:SELANGOR']);
    expect(usp.has('page')).toBe(false);
    expect(soListParams({ status: 'all', filters: [] }).has('status')).toBe(false);
  });

  it('Delivery Order: the bucket name as sent, no paging', () => {
    const usp = doListParams({ status: 'delivered', q: 'bob', sort: 'do_number:desc' });
    expect(Object.fromEntries(usp)).toEqual({ status: 'delivered', q: 'bob', sort: 'do_number:desc' });
  });
});

describe('the line exports', () => {
  it('asks the SO line endpoint with the filter rows and writes the rows under the contract header', async () => {
    const rows = [SO_LINE_EXPORT_COLUMNS.map((c) => (c === 'Unit Price' ? 12.5 : c))];
    h.answer = () => ({ columns: [...SO_LINE_EXPORT_COLUMNS], rows, lineCount: 1, truncated: false });
    const body = await fetchSoLineExport({ status: 'confirmed', filters: [{ field: 'orderDate', op: 'between', value: '2026-08-01~2026-08-31' }] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.startsWith('/mfg-sales-orders/export/lines?')).toBe(true);
    expect(query(h.calls[0]!).getAll('f')).toEqual(['orderDate:between:2026-08-01~2026-08-31']);
    await writeSoLineExportXlsx(body, 'sales-order-lines.xlsx');
    expect(h.aoa[0]).toEqual([...SO_LINE_EXPORT_COLUMNS]);
    expect(h.written).toEqual(['sales-order-lines.xlsx']);
    const priceCell = h.cells[`${SO_LINE_EXPORT_COLUMNS.indexOf('Unit Price')}:1`];
    expect(priceCell?.z).toBe('#,##0.00##');
  });

  it('asks the DO line endpoint and writes its sheet', async () => {
    h.answer = () => ({ columns: [...DO_LINE_EXPORT_COLUMNS], rows: [], lineCount: 0, truncated: false });
    const body = await fetchDoLineExport({ status: 'loaded' });
    expect(h.calls[0]).toBe('/delivery-orders-mfg/export/lines?status=loaded');
    await writeDoLineExportXlsx(body, 'delivery-order-lines.xlsx');
    expect(h.aoa).toEqual([[...DO_LINE_EXPORT_COLUMNS]]);
  });

  it('refuses a read the server had to stop, and a column set it does not expect', async () => {
    h.answer = () => ({ columns: [...SO_LINE_EXPORT_COLUMNS], rows: [], lineCount: 0, truncated: true });
    await expect(fetchSoLineExport({ filters: [] })).rejects.toThrow(/no file was written/);
    h.answer = () => ({ columns: ['Doc No'], rows: [], lineCount: 0, truncated: false });
    await expect(fetchDoLineExport({})).rejects.toThrow(/different set of export columns/);
  });
});

describe('the header exports read every page of the list', () => {
  const pagedSo = (total: number, shift = 0) => (path: string) => {
    if (path.startsWith('/mfg-sales-orders/list-mrp-enrichment')) {
      const docNos = decodeURIComponent(query(path).get('docNos') ?? '').split(',');
      return { enrichment: Object.fromEntries(docNos.map((d) => [d, { sourcePoReady: ['HC-PO-1'], sourcePoAdj: false, stockRemark: 'READY', isMainReady: true, planningState: 'ready' }])) };
    }
    const page = Number(query(path).get('page'));
    const size = Number(query(path).get('pageSize'));
    const start = page * size + (page > 0 ? shift : 0);
    const salesOrders = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ({ doc_no: `SO-${start + i}`, stock_remark: '' }));
    return { salesOrders, total };
  };

  it('pages the Sales Order list with its filters until the total, and heals the MRP columns when asked', async () => {
    h.answer = pagedSo(250);
    const rows = await fetchAllSoListRows<{ doc_no: string; stock_remark?: string }>(
      { status: 'confirmed', filters: [{ field: 'state', op: 'is', value: 'SELANGOR' }] }, true);
    expect(rows).toHaveLength(250);
    expect(new Set(rows.map((r) => r.doc_no)).size).toBe(250);
    const listCalls = h.calls.filter((c) => c.startsWith('/mfg-sales-orders?'));
    expect(listCalls.map((c) => query(c).get('page')).sort()).toEqual(['0', '1', '2']);
    for (const c of listCalls) {
      expect(query(c).get('status')).toBe('CONFIRMED');
      expect(query(c).getAll('f')).toEqual(['state:is:SELANGOR']);
      expect(query(c).get('pageSize')).toBe('100');
    }
    expect(rows[0]!.stock_remark).toBe('READY');
    expect(h.calls.filter((c) => c.includes('list-mrp-enrichment'))).toHaveLength(3);
  });

  it('does not ask for the MRP enrichment when no MRP column is exported', async () => {
    h.answer = pagedSo(5);
    await fetchAllSoListRows({ filters: [] }, false);
    expect(h.calls.filter((c) => c.includes('list-mrp-enrichment'))).toEqual([]);
  });

  it('refuses a listing that moved while its pages were read', async () => {
    h.answer = pagedSo(250, 1); // page 2 starts one row late: one order read by nobody
    await expect(fetchAllSoListRows({ filters: [] }, false)).rejects.toThrow(/changed while the export was being read/);
  });

  it('pages the Delivery Order list with its tab', async () => {
    h.answer = (path: string) => {
      const page = Number(query(path).get('page'));
      return { deliveryOrders: Array.from({ length: page === 0 ? 100 : 20 }, (_, i) => ({ id: `do-${page}-${i}` })), total: 120 };
    };
    const rows = await fetchAllDoListRows({ status: 'delivered' });
    expect(rows).toHaveLength(120);
    expect(h.calls.every((c) => query(c).get('status') === 'delivered')).toBe(true);
  });
});
