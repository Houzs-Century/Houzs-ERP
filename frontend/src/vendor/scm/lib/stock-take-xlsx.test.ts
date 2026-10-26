// @vitest-environment node
// stock-take-xlsx (2990-0014): the Count Sheet as a workbook — the screen's
// columns, numbers in the cells, an uncounted line with no variance, and the
// blind take without System / Variance / Value.
import { describe, expect, it } from 'vitest';
import { read, utils } from 'xlsx';
import type { StockTakeLine } from './stock-queries';
import { AMOUNT_FORMAT } from './report-sheet-xlsx';
import { stockTakeColumns, stockTakeMatrix } from './stock-take-xlsx';

const line = (over: Partial<StockTakeLine>): StockTakeLine => ({
  id: 'l1', stock_take_id: 'st-1', item_code: 'MATT-A', product_name: 'Mattress A', variant_key: '',
  variant_label: null, system_qty: 4, counted_qty: 6, variance: 2, notes: null, created_at: '',
  counted_by: 's-adrian', counted_at: null, rack_id: 'r1', est_unit_cost_sen: 50_000, ...over,
});
const names = { rackOf: (id: string | null) => (id === 'r1' ? 'Rack L5.1' : '—'), staffOf: () => 'Adrian' };
const header = { takeNo: 'HC-STK-2610-005', subtitle: 'SBH · 24/10/2026' };

const grid = async (lines: StockTakeLine[]) => {
  const cols = stockTakeColumns(lines, names);
  const writeXlsxFile = (await import('write-excel-file')).default;
  const blob = await writeXlsxFile(stockTakeMatrix(header, lines, cols), { columns: cols.map((c) => ({ width: c.width })) });
  const wb = read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  return { ws, rows: utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true }) };
};

describe('stock take Excel export', () => {
  it('writes the screen columns with quantities and RM as numbers', async () => {
    const { ws, rows } = await grid([
      line({}),
      line({ id: 'l2', item_code: 'MATT-B', variant_label: 'Size Q', system_qty: 3, counted_qty: null, variance: null, counted_by: null, rack_id: null }),
    ]);
    expect(rows[0]).toEqual(['HC-STK-2610-005']);
    expect(rows[3]).toEqual(['SKU', 'Name', 'Variant', 'System Qty', 'Counted Qty', 'Rack', 'Notes', 'Variance', 'Value (RM)', 'Counted By']);
    expect(rows[4]).toEqual(['MATT-A', 'Mattress A', undefined, 4, 6, 'Rack L5.1', undefined, 2, 1000, 'Adrian']);
    /* Uncounted: no count, no variance, no value, nobody — the row ends at System Qty. */
    expect(rows[5]).toEqual(['MATT-B', 'Mattress A', 'Size Q', 3]);
    expect(ws.I5!.z).toBe(AMOUNT_FORMAT);
  });

  it('leaves out System, Variance and Value when the server withheld the system qty', async () => {
    const { rows } = await grid([line({ system_qty: null, variance: null, est_unit_cost_sen: null })]);
    expect(rows[3]).toEqual(['SKU', 'Name', 'Variant', 'Counted Qty', 'Rack', 'Notes', 'Counted By']);
    expect(rows[4]).toEqual(['MATT-A', 'Mattress A', undefined, 6, 'Rack L5.1', undefined, 'Adrian']);
  });
});
