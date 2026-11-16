// @vitest-environment node
// (No DOM here — the pure matrix, plus a write-excel-file round-trip read back
// with SheetJS. The node env gives a Blob with .arrayBuffer(), which jsdom's lacks.)
/* The Excel a Finance report exports reads like the screen (owner 2026-09-19:
   excel 那边也要优化): title and period on top, the same columns, a block title
   bold, a category bold, a row indented by its depth, a total shaded, a net
   line shaded darker with a rule above; amounts are NUMBERS with the
   bracketed-negative format, a % a number with the % format, a dash a dash. */
import { describe, expect, it } from 'vitest';
import { read, utils } from 'xlsx';
import type { ReportSheet } from './report-sheet';
import { AMOUNT_FORMAT, PCT_FORMAT, columnWidths, headRowsOf, rowCells, sheetMatrix, sheetName } from './report-sheet-xlsx';

const sheet: ReportSheet = {
  title: 'P&L',
  subtitle: '2026/09/01 – 2026/09/19 · % of sales · on the saved layout',
  meta: [{ label: 'Period', value: '2026/09/01 – 2026/09/19' }],
  tables: [{
    columns: [{ label: 'Amount', kind: 'amount' }, { label: '% of sales', kind: 'pct' }],
    rows: [
      { kind: 'block', depth: 0, label: 'Expenses', cells: [] },
      { kind: 'category', depth: 1, label: 'General expense', cells: [173_358_06, 28.7] },
      { kind: 'row', depth: 2, label: '900-S100 · STAFF SALARIES & OVERTIME', cells: [1_067_642, 1.8] },
      { kind: 'row', depth: 2, label: '900-A014 · ADVERT - SHOWROOM', cells: [-1_500, null] },
      { kind: 'unassigned', depth: 1, label: 'Unassigned', cells: [100, 0] },
      { kind: 'total', depth: 0, label: 'Total expenses', cells: [173_358_06, 28.7] },
      { kind: 'net', depth: 0, label: 'NET PROFIT', cells: [-41_500, -6.9] },
    ],
  }],
  notes: ['Expenses as booked.'],
};

describe('sheetMatrix', () => {
  it('lays the title, the subtitle, a blank, the header, then every row in the screen\'s dress', () => {
    const m = sheetMatrix(sheet);
    expect(m[0]).toEqual([{ value: 'P&L', type: String, fontWeight: 'bold', fontSize: 14, span: 3 }]);
    expect(m[1]![0]).toMatchObject({ value: sheet.subtitle, span: 3 });
    expect(m[2]).toEqual([]);
    expect(m[3]!.map((c) => c?.value)).toEqual(['', 'Amount', '% of sales']);
    expect(m[3]![1]).toMatchObject({ fontWeight: 'bold', align: 'right', bottomBorderStyle: 'thin' });
    /* A block title spans the row, bold; nothing to add up. */
    expect(m[4]).toEqual([{ value: 'Expenses', type: String, indent: 0, fontWeight: 'bold', fontSize: 11, span: 3 }]);
    /* A category is bold and indented one, its figures on its Total row below its rows
       (owner 2026-11-05: the file as the screen); an account row two. */
    expect(m[5]![0]).toMatchObject({ value: 'General expense', indent: 1, fontWeight: 'bold' });
    expect(m[5]!.slice(1).every((c) => c == null || c.value == null)).toBe(true);
    expect(m[8]![0]).toMatchObject({ value: 'Total General expense', indent: 1 });
    expect(m[8]![1]).toMatchObject({ value: 173_358.06, type: Number, format: AMOUNT_FORMAT, align: 'right', fontWeight: 'bold' });
    expect(m[8]![2]).toMatchObject({ value: 0.287, type: Number, format: PCT_FORMAT });
    expect(m[6]![0]).toMatchObject({ value: '900-S100 · STAFF SALARIES & OVERTIME', indent: 2 });
    expect(m[6]![0]).not.toHaveProperty('fontWeight');
    /* A negative stays a number — the format brackets it; nothing prints a dash. */
    expect(m[7]![1]).toMatchObject({ value: -15, type: Number, format: AMOUNT_FORMAT });
    expect(m[7]![2]).toMatchObject({ value: '-', type: String, align: 'right' });
    expect(m[9]![0]).toMatchObject({ value: 'Unassigned', fontStyle: 'italic' });
    /* A total is shaded with a rule above; a net line darker with a heavier rule. */
    expect(m[10]![0]).toMatchObject({ value: 'Total expenses', fontWeight: 'bold', backgroundColor: '#eceeea', topBorderStyle: 'thin' });
    expect(m[10]![1]).toMatchObject({ backgroundColor: '#eceeea' });
    expect(m[11]![0]).toMatchObject({ value: 'NET PROFIT', fontWeight: 'bold', backgroundColor: '#e3e6e0', topBorderStyle: 'medium' });
    expect(m[11]![1]).toMatchObject({ value: -415 });
    /* The notes at the foot. */
    expect(m[12]).toEqual([]);
    expect(m[13]![0]).toMatchObject({ value: 'Expenses as booked.', span: 3 });
  });

  it('sizes the columns — the name wide, an amount, a % narrow — and names the sheet within Excel\'s rules', () => {
    expect(columnWidths(sheet)).toEqual([{ width: 46 }, { width: 14 }, { width: 9 }]);
    expect(sheetName('Cash Flow (every bank and cash account)')).toBe('Cash Flow (every bank and cash');
    expect(sheetName('P&L / BS: 2026?')).toBe('P&L BS 2026');
    expect(rowCells({ kind: 'row', depth: 1, label: 'x', cells: [null] }, [{ label: 'T', kind: 'text' }])[1]).toMatchObject({ value: '-' });
  });

  it('writes a workbook Excel reads back — the values in their cells, the amounts as numbers', async () => {
    const writeXlsxFile = (await import('write-excel-file')).default;
    const blob = await writeXlsxFile(sheetMatrix(sheet), { sheet: sheetName(sheet.title), columns: columnWidths(sheet), stickyRowsCount: 4, stickyColumnsCount: 1 });
    const wb = read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellNF: true });
    expect(wb.SheetNames).toEqual(['P&L']);
    const ws = wb.Sheets['P&L']!;
    const grid = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
    expect(grid[0]![0]).toBe('P&L');
    /* An empty header cell reads back as nothing at all. */
    expect(grid[3]!.slice(1)).toEqual(['Amount', '% of sales']);
    expect(grid[5]).toEqual(['General expense']);
    expect(grid[8]).toEqual(['Total General expense', 173_358.06, 0.287]);
    expect(grid[7]).toEqual(['900-A014 · ADVERT - SHOWROOM', -15, '-']);
    expect(grid[11]).toEqual(['NET PROFIT', -415, -0.069]);
    expect(ws.B9!.z).toBe(AMOUNT_FORMAT);
    expect(ws.C9!.z).toBe(PCT_FORMAT);
  });
});

describe('columns under a heading — the Cash Flow\'s Settlement | Deposit (owner 2026-11-09)', () => {
  const split: ReportSheet = {
    title: 'Cash Flow',
    subtitle: 'Settlement / Deposit',
    meta: [],
    tables: [{
      columns: [
        { label: 'Total', kind: 'amount' }, { label: '%', kind: 'pct', beside: true, edge: true },
        { label: 'Settlement', kind: 'amount', group: 'Oct 2026' }, { label: 'Deposit', kind: 'amount', group: 'Oct 2026' },
      ],
      rows: [
        { kind: 'row', depth: 1, label: '300-0000', cells: [90_000, 100, 50_000, 40_000] },
        { kind: 'row', depth: 1, label: 'TAXATION', cells: [5_000, 2.5, 5_000, null], spans: { 2: 2 } },
      ],
    }],
  };

  it('heads with two rows — the month over its two columns, the rest standing two rows tall — and merges a cell across', () => {
    const m = sheetMatrix(split);
    expect(m[3]!.map((c) => c && [c.value, c.span, c.rowSpan])).toEqual([['', undefined, 2], ['Total', undefined, 2], ['%', undefined, 2], ['Oct 2026', 2, undefined], null]);
    expect(m[3]![3]).toMatchObject({ align: 'center' });
    expect(m[4]!.map((c) => c?.value ?? null)).toEqual([null, null, null, 'Settlement', 'Deposit']);
    expect(m[6]![3]).toMatchObject({ value: 50, span: 2, align: 'center' });
    expect(m[6]![4]).toBeNull();
    expect(headRowsOf(split)).toBe(2);
    expect(headRowsOf(sheet)).toBe(1);
  });

  it('writes a workbook Excel reads back with the heading merged over its columns', async () => {
    const writeXlsxFile = (await import('write-excel-file')).default;
    const blob = await writeXlsxFile(sheetMatrix(split), { sheet: sheetName(split.title), columns: columnWidths(split), stickyRowsCount: 5, stickyColumnsCount: 1 });
    const wb = read(new Uint8Array(await blob.arrayBuffer()), { type: 'array' });
    const ws = wb.Sheets['Cash Flow']!;
    const merges = (ws['!merges'] ?? []).map((r) => utils.encode_range(r));
    expect(merges).toEqual(expect.arrayContaining(['A4:A5', 'B4:B5', 'D4:E4', 'D7:E7']));
    const grid = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true });
    expect(grid[3]!.slice(1, 4)).toEqual(['Total', '%', 'Oct 2026']);
    expect(grid[4]!.slice(3)).toEqual(['Settlement', 'Deposit']);
    expect(grid[6]).toEqual(['TAXATION', 50, 0.025, 50]);
  });
});

/* Several tables on one sheet, each a section (owner 2026-11-13, the Event Commission's
   export: 「排一排做好看一点」): its title on a row above its header, the name column
   headed, a text column flush left, a wide one as wide as asked. */
describe('sections — a title, a headed name column, text read left to right', () => {
  const sections: ReportSheet = {
    title: 'Event commission', subtitle: 'October 2026', meta: [],
    tables: [
      { title: 'Summary', columns: [{ label: 'Orders', kind: 'text' }, { label: 'Commission', kind: 'amount' }],
        rows: [{ kind: 'row', depth: 0, label: 'Orders opened in the range', cells: ['2 orders', 140_00] }] },
      { title: 'Orders opened in the range', labelHeader: 'Order',
        columns: [{ label: 'Fair', kind: 'text', align: 'left', width: 40 }, { label: 'Commission', kind: 'amount' }],
        rows: [{ kind: 'row', depth: 0, label: 'HC-SO-2610-001', cells: ['KL [AKEMI] BIGHOME @ MID VALLEY', 140_00] }, { kind: 'row', depth: 0, label: 'HC-SO-2610-002', cells: [null, 0] }] },
    ],
  };

  it('puts each title on its own row over its header, heads the name column, and keeps a left column left', () => {
    const m = sheetMatrix(sections);
    expect(m[3]).toEqual([{ value: 'Summary', type: String, fontWeight: 'bold', fontSize: 12, span: 3 }]);
    expect(m[4]!.map((c) => c?.value)).toEqual(['', 'Orders', 'Commission']);
    expect(m[7]![0]).toMatchObject({ value: 'Orders opened in the range', fontWeight: 'bold' });
    expect(m[8]!.map((c) => c?.value)).toEqual(['Order', 'Fair', 'Commission']);
    expect(m[8]![1]).toMatchObject({ align: 'left' });
    expect(m[9]![1]).toMatchObject({ value: 'KL [AKEMI] BIGHOME @ MID VALLEY', align: 'left' });
    expect(m[10]![1]).toMatchObject({ value: '-', align: 'left' });
    expect(m[10]![2]).toMatchObject({ value: 0, align: 'right' });
  });

  it('makes a column as wide as any table sharing it asks, never narrower', () => {
    expect(columnWidths(sections)).toEqual([{ width: 46 }, { width: 40 }, { width: 14 }]);
    expect(columnWidths({ ...sections, tables: [{ ...sections.tables[1]!, columns: [{ label: 'Rate', kind: 'text', width: 6 }, { label: 'Commission', kind: 'amount' }] }] }))
      .toEqual([{ width: 46 }, { width: 14 }, { width: 14 }]);
  });
});
