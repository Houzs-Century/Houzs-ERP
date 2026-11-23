/* Event Commission's Excel and PDF (owner 2026-11-16: 导出的效果不满意 — 排版不好看,
   缺资料或栏位, 要按销售员分开; 「就是多个选项让我选，可以total，可以单独」; 「通常根据我
   tab的header就行了」): the report split by salesperson with nothing left over, each
   table with the columns and rows it shows, a total at its foot; for everyone, for one
   salesperson, or for each in turn. */

import { describe, expect, test, vi } from 'vitest';
import type { Column } from '../../components/DataTable';
import type { EventCommission } from '../../vendor/scm/lib/event-queries';
import { bySalespersonOf, cardsOf, earningOnly, forSalesperson, salespeopleOf, sum } from './eventCommissionModel';
import { LEFT_OUT_NOTE, SUMMARY_NOTE, ecFileBase, ecSections, ecSheets, type EcInput, type EcRows, type EcSheet, type EcTableKey, type ShownTables } from './eventCommissionExport';
import { downloadEcXlsx, ecCell, ecColumnWidths, ecSheetData, ecSheetNames } from './eventCommissionXlsx';
import { ecPrintedBlock, generateEcPdf } from './eventCommissionPdf';

/* The writers run for real; only the hand-over to the browser is caught. */
const handed = vi.hoisted(() => ({ xlsx: vi.fn(async (..._a: unknown[]) => undefined), pdfs: [] as Array<{ pages: number; wide: boolean; name: string; action: string }> }));
vi.mock('write-excel-file', () => ({ default: (...a: unknown[]) => handed.xlsx(...a) }));
vi.mock('../../vendor/scm/lib/pdf-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../vendor/scm/lib/pdf-common')>()),
  deliverPdf: (doc: { getNumberOfPages: () => number; internal: { pageSize: { getWidth: () => number; getHeight: () => number } } }, name: string, action: string) => {
    handed.pdfs.push({ pages: doc.getNumberOfPages(), wide: doc.internal.pageSize.getWidth() > doc.internal.pageSize.getHeight(), name, action });
  },
}));

const AKEMI = { id: 363, name: 'Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', brand: 'AKEMI', organizer: 'BIGHOME', venue: 'MID VALLEY', state: 'Kuala Lumpur', startDate: '2026-10-02', endDate: '2026-10-05', ratePct: 14, totalSalesRm: 9999, estimateRm: 1399.86 };
const ZAN = { fairId: 345, fairName: 'Johor [ZANOTTI] MLE @ MVEC SOUTHKEY', brand: 'ZANOTTI', organizer: 'MLE', venue: 'MVEC SOUTHKEY', state: 'Johor', customer: 'Lim', ratePct: 13 };
const so = (docNo: string, salesperson: string, goods: number, commission: number, reachedOn: string | null) => ({
  docNo, soDate: '2026-10-03', salesperson, customer: `Customer ${docNo.slice(-3)}`, ref: `R${docNo.slice(-3)}`, status: 'CONFIRMED',
  goodsSen: goods, totalSen: goods, paidSen: reachedOn ? goods : 0, paidPct: reachedOn ? 100 : 0, reachedOn, commissionSen: commission, changes: [],
});
const MARK = { id: 'm1', kind: 'exclude' as const, month: null, reason: 'duplicate', markedBy: 'Siti', markedAt: '2026-10-20T03:00:00Z' };

/* Three salespeople; every table that adds to the total, and two that do not. */
const R: EventCommission = {
  basis: 'fair', from: '2026-10-01', to: '2026-10-31',
  fairs: [
    { ...AKEMI, payableSen: 420_00, goodsSen: 3_500_00, estimateSen: 490_00, sos: [so('HC-SO-2610-001', 'Ethan', 1_000_00, 140_00, '2026-10-03'), so('HC-SO-2610-002', 'Mayson', 500_00, 0, null), so('HC-SO-2610-003', 'Ethan', 2_000_00, 280_00, '2026-10-04')] },
    { id: 345, name: ZAN.fairName, brand: 'ZANOTTI', startDate: '2026-10-18', endDate: '2026-10-20', ratePct: 13, totalSalesRm: null, estimateRm: null, payableSen: 557_44, goodsSen: 4_288_00, estimateSen: 557_44, sos: [so('HC-SO-2610-010', 'Mayson', 4_288_00, 557_44, '2026-10-19')] },
    { id: 400, name: 'Penang [AKEMI] X @ Y', brand: 'AKEMI', startDate: '2026-10-25', endDate: '2026-10-27', ratePct: 14, totalSalesRm: null, estimateRm: null, payableSen: 0, sos: [] },
  ],
  adjustments: [
    { date: '2026-10-10', kind: 'reached', docNo: 'HC-SO-2609-050', fairId: 345, fairName: ZAN.fairName, salesperson: 'Jason', goodsSen: 1_100_00, commissionSen: 143_00, beforeReach: false },
    { date: '2026-10-12', kind: 'cancelled', docNo: 'HC-SO-2609-051', fairId: 345, fairName: ZAN.fairName, salesperson: 'Jason', goodsSen: 1_000_00, commissionSen: -130_00, beforeReach: false },
    { date: '2026-10-14', kind: 'upsale', docNo: 'HC-SO-2609-060', fairId: 345, fairName: ZAN.fairName, salesperson: 'Mayson', goodsSen: 100_00, commissionSen: 13_00, beforeReach: false },
  ],
  earlierOrders: [
    { ...ZAN, docNo: 'HC-SO-2609-050', salesperson: 'Jason', events: [{ date: '2026-10-10', kind: 'reached', beforeReach: false }], lastDate: '2026-10-10', originalSen: 1_100_00, latestSen: 1_100_00, amendedSen: 0, commissionSen: 143_00, fromHistory: false },
    { ...ZAN, docNo: 'HC-SO-2609-051', salesperson: 'Jason', events: [{ date: '2026-10-12', kind: 'cancelled', beforeReach: false }], lastDate: '2026-10-12', originalSen: 1_000_00, latestSen: 1_000_00, amendedSen: 0, commissionSen: -130_00, fromHistory: false },
  ],
  changedOrders: [
    { ...ZAN, docNo: 'HC-SO-2610-001', fairId: 363, fairName: AKEMI.name, brand: 'AKEMI', salesperson: 'Ethan', ratePct: 14, part: 'range', lastChange: '2026-10-15', originalSen: 850_00, latestSen: 1_000_00, amendedSen: 150_00, reachedOn: '2026-10-03', effectSen: 21_00, fromHistory: false },
    { ...ZAN, docNo: 'HC-SO-2609-060', salesperson: 'Mayson', part: 'earlier', lastChange: '2026-10-14', originalSen: 900_00, latestSen: 1_000_00, amendedSen: 100_00, reachedOn: '2026-09-20', effectSen: 13_00, fromHistory: false },
  ],
  monthAdjustments: [
    { month: '2026-09', docNo: 'HC-SO-2609-213', fairId: 345, fairName: ZAN.fairName, brand: 'ZANOTTI', salesperson: 'Ethan', customer: 'Tan', wasSen: 0, nowSen: 557_44, adjustmentSen: 557_44, goodsSen: 4_288_00, ratePct: 13 },
  ],
  manualLines: [
    { ...ZAN, docNo: 'HC-SO-2609-070', salesperson: 'Mayson', line: { id: 'l1', month: '2026-10', reason: 'missed', addedBy: 'Siti', addedAt: '2026-10-21T03:00:00Z' }, goodsSen: 100_00, commissionSen: 13_00 },
  ],
  marked: [{ ...ZAN, docNo: 'HC-SO-2609-080', salesperson: 'Jason', mark: MARK, commissionSen: 50_00 }],
  totals: { payableSen: 977_44, adjustmentsSen: 26_00, monthAdjustmentsSen: 557_44, deferredInSen: 0, manualSen: 13_00, totalSen: 1_573_88 },
};

/* Columns as a page table defines them: a key, a header, the value it exports. */
const col = <T,>(key: string, label: string, value: (row: T) => string | number | null, exportFormat?: 'money' | 'date' | 'number'): Column<T> =>
  ({ key, label, render: () => null, getValue: value, ...(exportFormat ? { exportFormat } : {}) });
const shownAll = (over: Partial<ShownTables> = {}): ShownTables => {
  const t = <K extends EcTableKey>(columns: Array<Column<EcRows[K]>>) => ({ columns, rowKeys: null, filters: null });
  return {
    fairs: t<'fairs'>([col('fair', 'Fair', (f) => f.name), col('rate', 'Rate', (f) => (f.ratePct == null ? null : `${f.ratePct}%`)), col('goods', 'Total sales', (f) => (f.goodsSen ?? 0) / 100, 'money'), col('orders', 'Orders', (f) => f.sos.length, 'number'), col('commission', 'Commission', (f) => f.payableSen / 100, 'money')]),
    fairOrders: t<'fairOrders'>([col('order', 'Order', (o) => o.docNo), col('fair', 'Fair', (o) => o.fair.name), col('salesperson', 'Salesperson', (o) => o.salesperson), col('soDate', 'SO date', (o) => o.soDate, 'date'), col('goods', 'Goods', (o) => o.goodsSen / 100, 'money'), col('commission', 'Commission', (o) => o.commissionSen / 100, 'money')]),
    orders: t<'orders'>([col('order', 'Order', (o) => o.docNo), col('commission', 'Commission', (o) => o.commissionSen / 100, 'money')]),
    earlier: t<'earlier'>([col('order', 'Order', (o) => o.docNo), col('salesperson', 'Salesperson', (o) => o.salesperson), col('commission', 'Commission', (o) => o.commissionSen / 100, 'money')]),
    monthAdj: t<'monthAdj'>([col('order', 'Order', (a) => a.docNo), col('adjustment', 'Adjustment', (a) => a.adjustmentSen / 100, 'money')]),
    movedIn: t<'movedIn'>([col('order', 'Order', (d) => d.docNo)]),
    manual: t<'manual'>([col('order', 'Order', (m) => m.docNo), col('commission', 'Commission', (m) => m.commissionSen / 100, 'money')]),
    changesEarlier: t<'changesEarlier'>([col('order', 'Order', (o) => o.docNo), col('effect', 'Commission effect', (o) => o.effectSen / 100, 'money')]),
    changesInRange: t<'changesInRange'>([col('order', 'Order', (o) => o.docNo), col('effect', 'Commission effect', (o) => o.effectSen / 100, 'money')]),
    below: t<'below'>([col('order', 'Order', (o) => o.docNo), col('owed', 'Owed for 30%', (o) => o.neededSen / 100, 'money')]),
    marked: t<'marked'>([col('order', 'Order', (m) => m.docNo), col('commission', 'Not paid here', (m) => m.commissionSen / 100, 'money')]),
    ...over,
  };
};
/* Every line, as the file was before lines at 0.00 could be left out; the tests below on what it leaves out set it. */
const input = (who: EcInput['who'], over: Partial<ShownTables> = {}, more: Partial<EcInput> = {}): EcInput =>
  ({ report: R, period: 'October 2026', brand: '', shown: shownAll(over), who, part: 'full', leaveOutZero: false, ...more });

describe('the report split by salesperson', () => {
  test('everyone with a line, A to Z; one salesperson\'s report is the report over their lines, a fair worked on their orders alone', () => {
    expect(salespeopleOf(R)).toEqual(['Ethan', 'Jason', 'Mayson']);
    const ethan = forSalesperson(R, 'Ethan');
    expect(ethan.fairs.map((f) => [f.id, f.sos.map((s) => s.docNo), f.goodsSen, f.estimateSen, f.payableSen, f.totalSalesRm])).toEqual([
      [363, ['HC-SO-2610-001', 'HC-SO-2610-003'], 3_000_00, 420_00, 420_00, null],
    ]);
    expect(ethan.monthAdjustments!.map((a) => a.docNo)).toEqual(['HC-SO-2609-213']);
    expect(ethan.totals.totalSen).toBe(977_44);
    expect(forSalesperson(R, 'Jason').marked!.map((m) => m.docNo)).toEqual(['HC-SO-2609-080']);
  });

  test('the salespeople\'s cards add up to the report\'s, card by card, and to its total', () => {
    const people = bySalespersonOf(R);
    expect(people.map((p) => [p.name, p.orders, p.totalSen])).toEqual([['Ethan', 3, 977_44], ['Jason', 2, 13_00], ['Mayson', 4, 583_44]]);
    for (const c of cardsOf(R)) expect(sum(people, (p) => p.cards[c.key] ?? 0)).toBe(c.sen);
    expect(sum(people, (p) => p.totalSen)).toBe(R.totals.totalSen);
    for (const name of salespeopleOf(R)) expect(forSalesperson(R, name).totals.totalSen).toBe(sum(cardsOf(forSalesperson(R, name)), (c) => c.sen));
  });

  test('a line with no salesperson sits apart, last', () => {
    const r = { ...R, manualLines: [{ ...R.manualLines![0]!, salesperson: null }] };
    expect(salespeopleOf(r).at(-1)).toBe('(no salesperson)');
    expect(forSalesperson(r, '(no salesperson)').totals.totalSen).toBe(13_00);
  });
});

describe('the Excel', () => {
  test('everyone: the summary with a line per salesperson, then a sheet per table that has rows, in the page\'s order', () => {
    const sheets = ecSheets(input({ kind: 'all' }));
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Fairs', 'Fair orders', 'Earlier fairs', 'Closed months', 'Added by Finance', 'Upsales-drops earlier', 'Upsales-drops in range', 'Below 30%', 'Marked']);
    const [summary, people] = sheets[0]!.blocks;
    /* Each tab's total over its lines that earn, a line per brand with the rate under it,
       the first one's "of which" lines, the total of goods and of commission. */
    expect(summary!.columns.map((c) => c.label)).toEqual(['', 'Orders', 'Goods', 'Rate', 'Commission']);
    expect(summary!.rows.map((r) => [r.kind, ...r.cells])).toEqual([
      ['subtotal', 'Fairs starting in the range', 3, 7288, null, 977.44],
      ['inner', 'ZANOTTI', 1, 4288, '13%', 557.44],
      ['inner', 'AKEMI', 2, 3000, '14%', 420],
      ['memo', 'of which upsales / drop sales', 1, 150, null, 21],
      ['memo', 'of which late bills', 0, null, null, 0],
      ['subtotal', 'Earlier fairs', 2, 100, null, 13],
      ['inner', 'ZANOTTI', 2, 100, '13%', 13],
      ['subtotal', 'Closed months — adjustments', 1, 4288, null, 557.44],
      ['inner', 'ZANOTTI', 1, 4288, '13%', 557.44],
      ['subtotal', 'Added by Finance', 1, 100, null, 13],
      ['inner', 'ZANOTTI', 1, 100, '13%', 13],
      ['subtotal', 'Upsales / Drop sales — earlier fairs', 1, 100, null, 13],
      ['inner', 'ZANOTTI', 1, 100, '13%', 13],
      ['total', 'Total', null, 11876, null, 1573.88],
    ]);
    expect(summary!.note).toBe(SUMMARY_NOTE);
    expect(people!.columns.map((c) => c.label)).toEqual([
      'Salesperson', 'Orders', 'Fairs starting in the range', 'Earlier fairs', 'Closed months — adjustments', 'Added by Finance', 'Upsales / Drop sales — earlier fairs', 'Total',
    ]);
    /* The orders that earn: Mayson's order under 30% is not one of his. */
    expect(people!.rows.map((r) => r.cells)).toEqual([
      ['Ethan', 3, 420, null, 557.44, null, null, 977.44],
      ['Jason', 2, null, 13, null, null, null, 13],
      ['Mayson', 3, 557.44, null, null, 13, 13, 583.44],
      ['Total · 3 salespeople', 8, 977.44, 13, 557.44, 13, 13, 1573.88],
    ]);
    /* A table's own title and what it is are the sheet's two lines; its header is the third row. */
    const fairs = sheets[1]!;
    expect([fairs.title, fairs.subtitle]).toEqual(['Fairs starting in the range', 'October 2026 · By fair · All brands · Everyone']);
    expect(fairs.blocks[0]!.rows.map((r) => r.cells)).toEqual([
      ['Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', '14%', 3500, 3, 420],
      ['Johor [ZANOTTI] MLE @ MVEC SOUTHKEY', '13%', 4288, 1, 557.44],
      ['Total · 2 fairs', null, 7788, 4, 977.44],
    ]);
    expect(sheets.find((s) => s.name === 'Below 30%')!.subtitle).toBe('October 2026 · By fair · All brands · Everyone · not in the total: earns once 30% is paid');
  });

  test('each table gives the columns it shows, in their order, and its rows as its column filters and sort leave them, the filter said', () => {
    const sheets = ecSheets(input({ kind: 'all' }, {
      fairOrders: {
        columns: [col('commission', 'Commission', (o) => o.commissionSen / 100, 'money'), col('order', 'Order', (o) => o.docNo)],
        rowKeys: null, filters: null,
      },
      earlier: { ...shownAll().earlier, rowKeys: ['HC-SO-2609-051'], filters: 'Salesperson: Jason' },
      monthAdj: { ...shownAll().monthAdj, rowKeys: [] },
      changesEarlier: { ...shownAll().changesEarlier, rowKeys: ['HC-SO-2609-060'] },
    }));
    const orders = sheets.find((s) => s.name === 'Fair orders')!.blocks[0]!;
    expect(orders.columns.map((c) => c.label)).toEqual(['Commission', 'Order']);
    expect(orders.rows.at(-1)!.cells).toEqual([977.44, 'Total · 4 orders']);
    const earlier = sheets.find((s) => s.name === 'Earlier fairs')!;
    expect(earlier.blocks[0]!.rows.map((r) => r.cells[0])).toEqual(['HC-SO-2609-051', 'Total · 1 order']);
    expect(earlier.subtitle).toContain('Filter: Salesperson: Jason');
    /* Every row filtered away: no sheet. */
    expect(sheets.some((s) => s.name === 'Closed months')).toBe(false);
  });

  test('one salesperson: their summary, their total, their lines only — a fair worked on their orders', () => {
    const sheets = ecSheets(input({ kind: 'one', name: 'Ethan' }));
    expect(sheets[0]!.title).toBe('Event commission — Ethan');
    expect(sheets[0]!.subtitle).toBe('October 2026 · By fair · All brands · Salesperson: Ethan');
    expect(sheets[0]!.blocks).toHaveLength(1);
    expect(sheets[0]!.blocks[0]!.rows.at(-1)!.cells).toEqual(['Total', null, 7288, null, 977.44]);
    expect(sheets.map((s) => s.name)).toEqual(['Summary', 'Fairs', 'Fair orders', 'Closed months', 'Upsales-drops in range']);
    expect(sheets[1]!.blocks[0]!.rows.map((r) => r.cells)).toEqual([
      ['Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', '14%', 3000, 2, 420],
      ['Total · 1 fair', null, 3000, 2, 420],
    ]);
  });

  test('each salesperson: every table\'s rows by salesperson, a subtotal after each, the total at the foot', () => {
    const sheets = ecSheets(input({ kind: 'each' }));
    expect(sheets[0]!.blocks.map((b) => b.title)).toEqual(['Summary', 'By salesperson']);
    const orders = sheets.find((s) => s.name === 'Fair orders')!.blocks[0]!;
    expect(orders.rows.map((r) => [r.kind, r.cells[0], r.cells.at(-1)])).toEqual([
      ['group', 'Ethan', null],
      ['row', 'HC-SO-2610-001', 140],
      ['row', 'HC-SO-2610-003', 280],
      ['subtotal', 'Subtotal · Ethan', 420],
      ['group', 'Mayson', null],
      ['row', 'HC-SO-2610-002', 0],
      ['row', 'HC-SO-2610-010', 557.44],
      ['subtotal', 'Subtotal · Mayson', 557.44],
      ['total', 'Total · 4 orders', 977.44],
    ]);
    expect(sheets[0]!.subtitle).toBe('October 2026 · By fair · All brands · By salesperson');
  });

  test('the workbook: money a number in the bracketed format, a day a date, the header bold over a rule, the total shaded; tab names Excel takes', () => {
    const [summary, fairs, orders] = ecSheets(input({ kind: 'all' }));
    const data = ecSheetData(orders!);
    expect(data[0]![0]).toMatchObject({ value: 'Fairs starting in the range — their orders', fontWeight: 'bold' });
    expect(data[2]!.map((c) => (c as { value: string }).value)).toEqual(['Order', 'Fair', 'Salesperson', 'SO date', 'Goods', 'Commission']);
    expect(data[2]![0]).toMatchObject({ fontWeight: 'bold', bottomBorderStyle: 'thin' });
    expect(data[3]![3]).toMatchObject({ type: Number, value: 46298, format: 'yyyy/mm/dd' });
    expect(data[3]![4]).toMatchObject({ type: Number, value: 1000, format: '#,##0.00;(#,##0.00)' });
    expect(data.at(-1)![0]).toMatchObject({ value: 'Total · 4 orders', fontWeight: 'bold', topBorderStyle: 'thin' });
    expect(ecCell({ label: 'x', format: 'money', align: 'right', sums: true }, -130, {})).toMatchObject({ type: Number, value: -130 });
    /* Each column as wide as what is in it: the fair's name, "14%", the figures with room for brackets. */
    expect(ecColumnWidths(fairs!).map((c) => c.width)).toEqual([43, 8, 13, 8, 12]);
    expect(ecSheetData(summary!).some((row) => row.some((c) => (c as { value?: string } | null)?.value === 'By salesperson'))).toBe(true);
    expect(ecSheetNames([{ ...fairs!, name: 'Upsales / Drop sales — fairs starting in the range' }, { ...fairs!, name: 'Upsales / Drop sales — fairs starting in the range' }]))
      .toEqual(['Upsales Drop sales — fairs star', 'Upsales Drop sales — fairs (2)']);
  });
});

describe('the PDF', () => {
  test('everyone: the summary, the line per salesperson and every table, on one run of pages', () => {
    const sections = ecSections(input({ kind: 'all' }));
    expect(sections).toHaveLength(1);
    expect(sections[0]!.blocks.map((b) => b.title)).toEqual([
      'Summary', 'By salesperson', 'Fairs starting in the range', 'Fairs starting in the range — their orders', 'Earlier fairs — reached 30% or cancelled in the range',
      'Closed months — adjustments', 'Added by Finance', 'Upsales / Drop sales — earlier fairs', 'Upsales / Drop sales — fairs starting in the range', 'Below 30% paid', 'Marked — not paid here',
    ]);
    expect(sections[0]!.blocks.find((b) => b.title === 'Marked — not paid here')!.note).toBe('not in the total');
  });

  test('each salesperson: the summary first, then each from a new page under their name', () => {
    const sections = ecSections(input({ kind: 'each' }));
    expect(sections.map((s) => [s.heading, s.newPage])).toEqual([[null, false], ['Ethan', true], ['Jason', true], ['Mayson', true]]);
    expect(sections[2]!.blocks.map((b) => b.title)).toEqual(['Summary', 'Earlier fairs — reached 30% or cancelled in the range', 'Marked — not paid here']);
  });

  test('a block as printed: money bracketed, a salesperson\'s name across the row, a line\'s empty cell a dash', () => {
    const block = ecSheets(input({ kind: 'each' })).find((s) => s.name === 'Earlier fairs')!.blocks[0]!;
    const p = ecPrintedBlock(block);
    /* Under a salesperson's name, no Salesperson column. */
    expect(p.head).toEqual(['Order', 'Commission']);
    expect(p.body).toEqual([
      [{ content: 'Jason', colSpan: 2 }],
      ['HC-SO-2609-050', '143.00'],
      ['HC-SO-2609-051', '(130.00)'],
      ['Subtotal · Jason', '13.00'],
      ['Total · 2 orders', '13.00'],
    ]);
    expect(p.right).toEqual([false, true]);
    expect(ecPrintedBlock({ title: '', note: null, columns: [{ label: 'Ref', format: 'text', align: 'left', sums: false }], rows: [{ kind: 'row', cells: [null] }] }).body).toEqual([['–']]);
    /* A table whose first column is a date (Upsales / Drop sales: Last change) carries its foot label there: it prints, not a dash. */
    const changes = ecPrintedBlock({
      title: '', note: null,
      columns: [{ label: 'Last change', format: 'date', align: 'left', sums: false }, { label: 'Commission effect', format: 'money', align: 'right', sums: true }],
      rows: [{ kind: 'row', cells: ['2026-10-02', 84] }, { kind: 'total', cells: ['Total · 1 order', 84] }],
    });
    expect(changes.body).toEqual([['2026/10/02', '84.00'], ['Total · 1 order', '84.00']]);
  });
});

/* Owner 2026-11-19: 「这个commission export 出来的可以exclude 那些不算的吗？」 →
   「导出的别放先」, and 「哪怕是这样我应该也要有个地方可以看到吧」 (the page lists them). The
   report above with every kind of line at 0.00 added: an order under 30% of a salesperson
   with nothing else, an earlier order Finance did not count, a price change it left out. */
const LEFT = { id: 'c1', kind: 'exclude_change' as const, month: '2026-10', reason: 'typing fix', markedBy: 'Siti', markedAt: '2026-10-22T03:00:00Z' };
const R0: EventCommission = {
  ...R,
  fairs: [{ ...R.fairs[0]!, sos: [...R.fairs[0]!.sos, so('HC-SO-2610-004', 'Nadia', 800_00, 0, null)] }, ...R.fairs.slice(1)],
  earlierOrders: [...R.earlierOrders!, {
    ...ZAN, docNo: 'HC-SO-2609-095', salesperson: 'Jason', mark: MARK, events: [{ date: '2026-10-11', kind: 'reached', beforeReach: false }],
    lastDate: '2026-10-11', originalSen: 2_000_00, latestSen: 2_000_00, amendedSen: 0, commissionSen: 0, fromHistory: false,
  }],
  changedOrders: [...R.changedOrders!, {
    ...ZAN, docNo: 'HC-SO-2609-090', salesperson: 'Jason', changeMark: LEFT, part: 'earlier', lastChange: '2026-10-16',
    originalSen: 1_000_00, latestSen: 1_500_00, amendedSen: 500_00, uncountedGoodsSen: 500_00, reachedOn: '2026-09-20', effectSen: 0, fromHistory: false,
  }],
  marked: [...R.marked!, { ...ZAN, docNo: 'HC-SO-2609-095', salesperson: 'Jason', mark: MARK, commissionSen: 260_00 }, { ...ZAN, docNo: 'HC-SO-2609-090', salesperson: 'Jason', mark: LEFT, commissionSen: 65_00 }],
};
/** A table's money at its foot, by its column's header. */
const footOf = (sheet: EcSheet, label: string): unknown => {
  const b = sheet.blocks[0]!;
  return b.rows.at(-1)!.cells[b.columns.findIndex((c) => c.label === label)];
};
const sheetOf = (sheets: EcSheet[], name: string): EcSheet => sheets.find((x) => x.name === name)!;

describe('lines at 0.00 left out of the file', () => {
  test('every table holds its lines that earn, says how many it left out, and its money is the same; the lists not in the total are not in it', () => {
    const every = ecSheets(input({ kind: 'all' }, {}, { report: R0 }));
    const sheets = ecSheets(input({ kind: 'all' }, {}, { report: R0, leaveOutZero: true }));
    expect(every.map((x) => x.name)).toContain('Marked');
    expect(sheets.map((x) => x.name)).toEqual(['Summary', 'Fairs', 'Fair orders', 'Earlier fairs', 'Closed months', 'Added by Finance', 'Upsales-drops earlier', 'Upsales-drops in range']);
    const orders = sheetOf(sheets, 'Fair orders');
    expect(orders.blocks[0]!.rows.map((r) => r.cells[0])).toEqual(['HC-SO-2610-001', 'HC-SO-2610-003', 'HC-SO-2610-010', 'Total · 3 orders']);
    expect(orders.subtitle).toBe('October 2026 · By fair · All brands · Everyone · 2 of 5 rows at 0.00 left out');
    expect(sheetOf(sheets, 'Earlier fairs').blocks[0]!.rows.map((r) => r.cells[0])).toEqual(['HC-SO-2609-050', 'HC-SO-2609-051', 'Total · 2 orders']);
    expect(sheetOf(sheets, 'Earlier fairs').subtitle).toContain('1 of 3 rows at 0.00 left out');
    /* The price change Finance left out: its row is not in the file. */
    expect(sheetOf(sheets, 'Upsales-drops earlier').blocks[0]!.rows.map((r) => r.cells[0])).toEqual(['HC-SO-2609-060', 'Total · 1 order']);
    expect(sheetOf(sheets, 'Upsales-drops earlier').subtitle).toContain('1 of 2 rows at 0.00 left out');
    expect(sheetOf(sheets, 'Closed months').subtitle).not.toContain('left out');
    /* A fair is worked on its orders that earn. */
    expect(sheetOf(sheets, 'Fairs').blocks[0]!.rows[0]!.cells).toEqual(['Kuala Lumpur [AKEMI] BIGHOME @ MID VALLEY', '14%', 3000, 2, 420]);
    for (const [name, label] of [['Fairs', 'Commission'], ['Fair orders', 'Commission'], ['Earlier fairs', 'Commission'], ['Closed months', 'Adjustment'], ['Added by Finance', 'Commission'], ['Upsales-drops earlier', 'Commission effect'], ['Upsales-drops in range', 'Commission effect']] as const) {
      expect(footOf(sheetOf(sheets, name), label)).toBe(footOf(sheetOf(every, name), label));
    }
    /* The summary is the same either way: it counts the lines that earn; it says what the file left out. */
    expect(sheets[0]!.blocks[0]!.rows).toEqual(every[0]!.blocks[0]!.rows);
    expect(sheets[0]!.blocks[0]!.rows).toEqual(ecSheets(input({ kind: 'all' }))[0]!.blocks[0]!.rows);
    expect(sheets[0]!.blocks[0]!.note).toBe(`${SUMMARY_NOTE} ${LEFT_OUT_NOTE}`);
    expect(every[0]!.blocks[0]!.note).toBe(SUMMARY_NOTE);
  });

  test('the report over its lines that earn: the same money, nothing at 0.00 left in it', () => {
    const e = earningOnly(R0);
    expect(e.totals.totalSen).toBe(R0.totals.totalSen);
    expect(e.fairs.flatMap((f) => f.sos).every((x) => x.commissionSen !== 0)).toBe(true);
    expect(e.fairs.map((f) => f.id)).toEqual([363, 345]);
    expect(e.changedOrders!.map((o) => o.docNo)).toEqual(['HC-SO-2610-001', 'HC-SO-2609-060']);
    expect(e.earlierOrders!.map((o) => o.docNo)).toEqual(['HC-SO-2609-050', 'HC-SO-2609-051']);
    expect(e.marked).toEqual([]);
    /* Nadia has nothing that earns: no line, no pages. */
    expect(salespeopleOf(R0)).toContain('Nadia');
    expect(salespeopleOf(e)).toEqual(['Ethan', 'Jason', 'Mayson']);
    expect(ecSections(input({ kind: 'each' }, {}, { report: R0, leaveOutZero: true })).map((x) => x.heading)).toEqual([null, 'Ethan', 'Jason', 'Mayson']);
    expect(ecSections(input({ kind: 'each' }, {}, { report: R0 })).map((x) => x.heading)).toEqual([null, 'Ethan', 'Jason', 'Mayson', 'Nadia']);
    const pdf = ecSections(input({ kind: 'all' }, {}, { report: R0, leaveOutZero: true }))[0]!.blocks.map((b) => b.title);
    expect(pdf).not.toContain('Below 30% paid');
    expect(pdf).not.toContain('Marked — not paid here');
  });
});

/* Owner 2026-11-19: 「同时我要有一个是可以export summary，包括goods 和rate和commission」,
   「summary我主要看的就是 每个tab的total」, 「要有total good」. */
describe('the summary', () => {
  test('each tab is its brands added up, each brand Goods × Rate = Commission, the total the report\'s and the tables\' that add to it', () => {
    const sheets = ecSheets(input({ kind: 'all' }));
    const rows = sheets[0]!.blocks[0]!.rows;
    const tabs = rows.flatMap((r, i) => (r.kind === 'subtotal' ? [{ tab: r, brands: rows.slice(i + 1).filter((_, j, after) => after.slice(0, j + 1).every((x) => x.kind === 'inner')) }] : []));
    expect(tabs).toHaveLength(cardsOf(R).length);
    for (const { tab, brands } of tabs) {
      for (const at of [1, 2, 4]) expect(Math.round(sum(brands, (b) => Number(b.cells[at] ?? 0)) * 100)).toBe(Math.round(Number(tab.cells[at] ?? 0) * 100));
      for (const b of brands) expect(Math.round(Number(b.cells[2]) * Number(String(b.cells[3]).replace('%', '')))).toBe(Math.round(Number(b.cells[4]) * 100));
    }
    const total = rows.at(-1)!;
    expect(Math.round(Number(total.cells[2]) * 100)).toBe(Math.round(sum(tabs, (t) => Number(t.tab.cells[2] ?? 0)) * 100));
    expect(Math.round(Number(total.cells[4]) * 100)).toBe(R.totals.totalSen);
    expect(Math.round(Number(total.cells[4]) * 100)).toBe(sum(cardsOf(R), (c) => c.sen));
    /* The detailed file's own total: the tables that add to the total, at their feet. */
    const detail = [['Fair orders', 'Commission'], ['Earlier fairs', 'Commission'], ['Closed months', 'Adjustment'], ['Added by Finance', 'Commission'], ['Upsales-drops earlier', 'Commission effect']] as const;
    expect(Math.round(sum(detail, ([name, label]) => Number(footOf(sheetOf(sheets, name), label))) * 100)).toBe(Math.round(Number(total.cells[4]) * 100));
  });

  test('the summary alone: its sheet or its pages, for everyone, one salesperson, or each in turn under it', () => {
    const all = ecSheets(input({ kind: 'all' }, {}, { part: 'summary' }));
    expect(all.map((x) => x.name)).toEqual(['Summary']);
    expect(all[0]!.blocks.map((b) => b.title)).toEqual(['Summary', 'By salesperson']);
    const each = ecSheets(input({ kind: 'each' }, {}, { part: 'summary' }));
    expect(each).toHaveLength(1);
    expect(each[0]!.blocks.map((b) => b.title)).toEqual(['Summary', 'By salesperson', 'Ethan', 'Jason', 'Mayson']);
    /* Each salesperson's own summary ends on their line of the By salesperson table. */
    const people = bySalespersonOf(earningOnly(R));
    for (const p of people) expect(each[0]!.blocks.find((b) => b.title === p.name)!.rows.at(-1)!.cells[4]).toBe(p.totalSen / 100);
    expect(ecSheets(input({ kind: 'one', name: 'Jason' }, {}, { part: 'summary' })).map((x) => [x.name, x.title, x.blocks.length])).toEqual([['Summary', 'Event commission — Jason', 1]]);
    const pdf = ecSections(input({ kind: 'each' }, {}, { part: 'summary' }));
    expect(pdf.map((x) => [x.heading, x.newPage, x.blocks.map((b) => b.title)])).toEqual([
      [null, false, ['Summary', 'By salesperson']], ['Ethan', true, ['Summary']], ['Jason', true, ['Summary']], ['Mayson', true, ['Summary']],
    ]);
    expect(ecSections(input({ kind: 'all' }, {}, { part: 'summary' }))[0]!.blocks.map((b) => b.title)).toEqual(['Summary', 'By salesperson']);
  });

  test('on paper and in the workbook: a brand set in under its tab, a line with no goods a dash', () => {
    const summary = ecSheets(input({ kind: 'all' }))[0]!;
    const data = ecSheetData(summary);
    const zan = data.find((row) => (row[0] as { value?: string } | null)?.value === 'ZANOTTI')!;
    expect(zan[0]).toMatchObject({ value: 'ZANOTTI', indent: 1 });
    expect(zan[4]).toMatchObject({ type: Number, value: 557.44 });
    const block = { title: '', note: null, columns: summary.blocks[0]!.columns, rows: [{ kind: 'inner' as const, cells: ['AKEMI', 1, null, '14%', 98] }] };
    expect(ecPrintedBlock(block).body).toEqual([['AKEMI', '1', '–', '14%', '98.00']]);
  });
});

test('the file is named for whom it is', () => {
  expect(ecFileBase('event-commission-by-fair-2026-10-01-2026-10-31', { kind: 'all' }, 'full')).toBe('event-commission-by-fair-2026-10-01-2026-10-31');
  expect(ecFileBase('ec', { kind: 'one', name: 'Chea Huan' }, 'full')).toBe('ec-chea-huan');
  expect(ecFileBase('ec', { kind: 'each' }, 'full')).toBe('ec-by-salesperson');
  expect(ecFileBase('ec', { kind: 'all' }, 'summary')).toBe('ec-summary');
  expect(ecFileBase('ec', { kind: 'each' }, 'summary')).toBe('ec-summary-by-salesperson');
});

describe('the writers', () => {
  test('the workbook: a sheet each, Excel\'s tab names, each sheet its own widths, its title, line and header frozen', async () => {
    const sheets = ecSheets(input({ kind: 'all' }));
    await downloadEcXlsx(sheets, 'ec.xlsx');
    const [data, opts] = handed.xlsx.mock.calls[0] as [unknown[], { fileName: string; sheets: string[]; columns: unknown[]; stickyRowsCount: number }];
    expect(data).toHaveLength(sheets.length);
    expect(opts).toMatchObject({ fileName: 'ec.xlsx', sheets: ecSheetNames(sheets), stickyRowsCount: 3 });
    expect(opts.columns).toEqual(sheets.map(ecColumnWidths));
  });

  test('the PDF: landscape A4, the summary, then each salesperson from a new page', async () => {
    await generateEcPdf(ecSections(input({ kind: 'each' })), { meta: [], subtitle: 'October 2026', fileName: 'ec.pdf', action: 'print' });
    expect(handed.pdfs).toHaveLength(1);
    expect(handed.pdfs[0]).toMatchObject({ wide: true, name: 'ec.pdf', action: 'print' });
    expect(handed.pdfs[0]!.pages).toBeGreaterThanOrEqual(4);
  });
});
