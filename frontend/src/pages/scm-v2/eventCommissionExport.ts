// ----------------------------------------------------------------------------
// eventCommissionExport — what Event Commission's Excel and PDF hold (owner
// 2026-11-16: 导出的效果不满意 — 排版不好看, 缺资料或栏位, 要按销售员分开; 「就是多个
// 选项让我选，可以total，可以单独」; 「通常根据我tab的header就行了」; 「by sales order
// 那边每个tab的listing计算」):
//   · a summary first — the cards, the first card's "of which" lines under it,
//     the total — and, for everyone, a line per salesperson: each card over
//     their own lines and their total, together the report's;
//   · then each table the page shows, in the page's order, with the columns
//     its reader has showing, in their order; its rows as its own column
//     filters leave them, in its sort (the filter said above it); its money
//     totalled at its foot;
//   · for everyone, for one salesperson (the report over their lines alone),
//     or for each in turn: the Excel lists every table's rows by salesperson,
//     a subtotal after each; the PDF prints one salesperson after another, each
//     from a new page.
// Pure: the page hands it the report and what each table shows; the writers
// (vendor/scm/lib/event-commission-xlsx.ts and event-commission-pdf.ts) lay it out.
// ----------------------------------------------------------------------------

import type { Column } from '../../components/DataTable';
import { buildLineExportMatrix, type ExportCell, type ExportFormat } from '../../components/dataTableLineExport';
import type {
  CommissionBasis, CommissionChangedOrder, CommissionDeferredIn, CommissionEarlierOrder, CommissionFairRow, CommissionManualLine,
  CommissionMarkedOrder, CommissionMonthAdjustment, EventCommission,
} from '../../vendor/scm/lib/event-queries';
import {
  BASIS_WORDS, RULE_NOTE, TITLE, basisOf, belowDepositOf, bySalespersonOf, cardsOf, changesEarlierOf, changesInRangeOf, changesTitle,
  countText, deferredInOf, earlierShownOf, forSalesperson, insideFirstOf, manualOf, markedOf, monthAdjOf, salespeopleOf, soListOf, sum,
  type BelowDepositRow, type SoListRow,
} from './eventCommissionModel';

/** Each table's row. */
type Rows = {
  fairs: CommissionFairRow;
  fairOrders: SoListRow;
  orders: SoListRow;
  earlier: CommissionEarlierOrder;
  monthAdj: CommissionMonthAdjustment;
  movedIn: CommissionDeferredIn;
  manual: CommissionManualLine;
  changesEarlier: CommissionChangedOrder;
  changesInRange: CommissionChangedOrder;
  below: BelowDepositRow;
  marked: CommissionMarkedOrder;
};
export type EcTableKey = keyof Rows;
export type EcRows = Rows;

/** What one table on the page shows, as it told the page. */
export type ShownTable<T> = {
  /** Its columns showing, in their order. */
  columns: ReadonlyArray<Column<T>>;
  /** Its rows' keys as its own column filters leave them, in its sort; null before it has said. */
  rowKeys: readonly string[] | null;
  /** Its column filters, in words; null when none. */
  filters: string | null;
};
export type ShownTables = { [K in EcTableKey]: ShownTable<Rows[K]> };

/** A row's key, as its table on the page keys it (`getRowKey`). */
export const EC_ROW_KEY: { [K in EcTableKey]: (row: Rows[K]) => string } = {
  fairs: (f) => String(f.id),
  fairOrders: (o) => o.docNo,
  orders: (o) => o.docNo,
  earlier: (o) => o.docNo,
  monthAdj: (a) => `${a.month}-${a.docNo}`,
  movedIn: (d) => `${d.fromMonth}-${d.docNo}`,
  manual: (m) => m.line.id,
  changesEarlier: (o) => o.docNo,
  changesInRange: (o) => o.docNo,
  below: (o) => o.docNo,
  marked: (m) => m.mark.id,
};

/** Who the file is for. */
export type EcWho = { kind: 'all' } | { kind: 'one'; name: string } | { kind: 'each' };

export type EcColumn = { label: string; format: ExportFormat; align: 'left' | 'right'; sums: boolean };
/** A line; an "of which" line under a card; a salesperson's name over their lines; their subtotal; the total. */
export type EcRowKind = 'row' | 'memo' | 'group' | 'subtotal' | 'total';
export type EcRow = { kind: EcRowKind; cells: ExportCell[] };
/** One table: its title, a line on what narrowed it or that it is not in the total, its columns and rows.
    `narrow`: a short table (the summary) that keeps to its own width on paper. */
export type EcBlock = { title: string; note: string | null; columns: EcColumn[]; rows: EcRow[]; narrow?: boolean };
/** An Excel sheet: its tab's name, the two lines over it, its tables, notes under them. */
export type EcSheet = { name: string; title: string; subtitle: string; blocks: EcBlock[]; notes: string[] };
/** A stretch of the PDF: a salesperson's name over it, from a new page or not; its tables; notes under them. */
export type EcSection = { heading: string | null; newPage: boolean; blocks: EcBlock[]; notes: string[] };

export type EcInput = { report: EventCommission; period: string; brand: string; shown: ShownTables; who: EcWho };

type Spec<K extends EcTableKey> = {
  title: (r: EventCommission) => string;
  /** The Excel tab: short, unique, at most 31 characters. */
  sheet: (r: EventCommission) => string;
  /** A table not added to the total says so. */
  apart: ((r: EventCommission) => string) | null;
  rows: (r: EventCommission) => Array<Rows[K]>;
  unit: string;
};
const wordsOf = (r: EventCommission) => BASIS_WORDS[basisOf(r)];
const SPECS: { [K in EcTableKey]: Spec<K> } = {
  fairs: { title: (r) => wordsOf(r).part1, sheet: () => 'Fairs', apart: null, rows: (r) => r.fairs.filter((f) => f.sos.length > 0), unit: 'fair' },
  fairOrders: { title: (r) => `${wordsOf(r).part1} — their orders`, sheet: () => 'Fair orders', apart: null, rows: soListOf, unit: 'order' },
  orders: { title: (r) => wordsOf(r).part1, sheet: () => 'Orders', apart: null, rows: soListOf, unit: 'order' },
  earlier: { title: (r) => wordsOf(r).part2, sheet: (r) => wordsOf(r).earlier, apart: null, rows: earlierShownOf, unit: 'order' },
  monthAdj: { title: () => TITLE.monthAdj, sheet: () => 'Closed months', apart: null, rows: monthAdjOf, unit: 'order' },
  movedIn: { title: () => TITLE.deferredIn, sheet: () => TITLE.deferredIn, apart: null, rows: deferredInOf, unit: 'order' },
  manual: { title: () => TITLE.manual, sheet: () => TITLE.manual, apart: null, rows: manualOf, unit: 'line' },
  changesEarlier: { title: (r) => changesTitle(wordsOf(r).earlier), sheet: () => 'Upsales-drops earlier', apart: null, rows: changesEarlierOf, unit: 'order' },
  changesInRange: {
    title: (r) => changesTitle(wordsOf(r).card1), sheet: () => 'Upsales-drops in range',
    apart: (r) => `inside ${wordsOf(r).card1} above, not added again`, rows: changesInRangeOf, unit: 'order',
  },
  below: { title: () => 'Below 30% paid', sheet: () => 'Below 30%', apart: () => 'not in the total: earns once 30% is paid', rows: belowDepositOf, unit: 'order' },
  marked: { title: () => 'Marked — not paid here', sheet: () => 'Marked', apart: () => 'not in the total', rows: markedOf, unit: 'mark' },
};
/** The tables in the page's order. */
export const EC_TABLES: Record<CommissionBasis, EcTableKey[]> = {
  fair: ['fairs', 'fairOrders', 'earlier', 'monthAdj', 'movedIn', 'manual', 'changesEarlier', 'changesInRange', 'below', 'marked'],
  so_date: ['orders', 'earlier', 'monthAdj', 'movedIn', 'manual', 'changesEarlier', 'changesInRange', 'below', 'marked'],
};

const isFigure = (f: ExportFormat): boolean => f === 'money' || f === 'number';
/** A table's columns as written: its header, its cell type, which side it reads from, whether its foot adds it up. */
const columnOf = <T,>(c: Column<T>): EcColumn => {
  const format = c.exportFormat ?? 'text';
  return { label: c.exportLabel || c.label, format, align: isFigure(format) || c.align === 'right' ? 'right' : 'left', sums: isFigure(format) };
};
/** A sum in ringgit, added in sen so 0.1 + 0.2 stays 0.30. */
const addUp = (cells: readonly ExportCell[]): number => cells.reduce<number>((s, v) => s + (typeof v === 'number' ? Math.round(v * 100) : 0), 0) / 100;

/** A foot row: the label in the first column that does not add up, every column that does added up. */
function footOf(kind: 'subtotal' | 'total', label: string, columns: readonly EcColumn[], body: readonly ExportCell[][]): EcRow {
  const at = Math.max(0, columns.findIndex((c) => !c.sums));
  return { kind, cells: columns.map((c, i) => (c.sums ? addUp(body.map((row) => row[i] ?? null)) : i === at ? label : null)) };
}

/** A table's rows in the order its table on the page shows them, and only those its own column filters leave. */
function ordered<K extends EcTableKey>(key: K, rows: Array<Rows[K]>, rowKeys: readonly string[] | null): Array<Rows[K]> {
  if (!rowKeys) return rows;
  const keyOf = EC_ROW_KEY[key] as (row: Rows[K]) => string;
  const at = new Map(rowKeys.map((k, i) => [k, i]));
  return rows.filter((row) => at.has(keyOf(row))).sort((a, b) => at.get(keyOf(a))! - at.get(keyOf(b))!);
}

/** One table's columns and its body over one report — the whole one, or one salesperson's —
    and how many rows it had before its table's own filters. A salesperson's own pages leave
    out the Salesperson column: their name heads them. */
function bodyOf<K extends EcTableKey>(key: K, r: EventCommission, shown: ShownTable<Rows[K]>, personal: boolean): { columns: EcColumn[]; body: ExportCell[][]; of: number } {
  const cols = shown.columns.filter((c) => (c.getValue || c.exportValue) && !(personal && c.key === 'salesperson'));
  const all = SPECS[key].rows(r);
  const rows = ordered(key, all, shown.rowKeys);
  return { columns: cols.map(columnOf), body: buildLineExportMatrix(rows, () => [], cols).body, of: all.length };
}

/** Above a table: that it is not in the total, and what narrowed it — its column filters, or
    (a search on the table) how many of its rows it kept. */
const noteOf = (key: EcTableKey, r: EventCommission, shown: ShownTable<unknown>, kept: number, of: number): string | null => {
  const apart = SPECS[key].apart?.(r) ?? null;
  const narrowed = shown.filters ? `Filter: ${shown.filters}` : kept < of ? `Filtered on the page: ${kept} of ${of} rows` : null;
  const parts = [apart, narrowed].filter((p): p is string => p != null);
  return parts.length > 0 ? parts.join(' · ') : null;
};

/** One table over one report, its total at its foot; null when it has no row. */
function tableBlock<K extends EcTableKey>(key: K, r: EventCommission, input: EcInput, personal: boolean): EcBlock | null {
  const shown = input.shown[key];
  const { columns, body, of } = bodyOf(key, r, shown, personal);
  if (body.length === 0 || columns.length === 0) return null;
  return {
    title: SPECS[key].title(r), note: noteOf(key, r, shown as ShownTable<unknown>, body.length, of), columns,
    rows: [...body.map((cells): EcRow => ({ kind: 'row', cells })), footOf('total', `Total · ${countText(body.length, SPECS[key].unit)}`, columns, body)],
  };
}

/** One table for each salesperson in turn: their name, their rows, their subtotal; the total at the foot. */
function groupedBlock<K extends EcTableKey>(key: K, r: EventCommission, people: ReadonlyArray<{ name: string; report: EventCommission }>, input: EcInput): EcBlock | null {
  const shown = input.shown[key];
  const each = people.map((p) => ({ name: p.name, ...bodyOf(key, p.report, shown, true) }));
  const parts = each.filter((p) => p.body.length > 0);
  const columns = parts[0]?.columns ?? [];
  if (parts.length === 0 || columns.length === 0) return null;
  const at = Math.max(0, columns.findIndex((c) => !c.sums));
  const unit = SPECS[key].unit;
  const rows = parts.flatMap((p): EcRow[] => [
    { kind: 'group', cells: columns.map((_, i) => (i === at ? p.name : null)) },
    ...p.body.map((cells): EcRow => ({ kind: 'row', cells })),
    footOf('subtotal', `Subtotal · ${p.name}`, columns, p.body),
  ]);
  const all = parts.flatMap((p) => p.body);
  rows.push(footOf('total', `Total · ${countText(all.length, unit)}`, columns, all));
  return { title: SPECS[key].title(r), note: noteOf(key, r, shown as ShownTable<unknown>, all.length, sum(each, (p) => p.of)), columns, rows };
}

const text = (label: string, align: 'left' | 'right' = 'left'): EcColumn => ({ label, format: 'text', align, sums: false });
const money = (label: string): EcColumn => ({ label, format: 'money', align: 'right', sums: true });
const ringgit = (sen: number): number => sen / 100;

/** The summary: the cards in the tables' order, the first one's "of which" lines under it, the total;
    and with `people`, a line per salesperson — each card over their own lines, their total. */
function summaryBlocks(r: EventCommission, people: boolean): EcBlock[] {
  const cards = cardsOf(r);
  const inside = insideFirstOf(r);
  const blocks: EcBlock[] = [{
    title: 'Summary', note: null, narrow: true,
    columns: [text(''), text('Orders', 'right'), { ...money('Commission'), sums: false }],
    rows: [
      ...cards.flatMap((c): EcRow[] => [
        { kind: 'row', cells: [c.label, c.count, ringgit(c.sen)] },
        ...(c.key === 'inRange' ? inside.map((o): EcRow => ({ kind: 'memo', cells: [o.label, o.count, ringgit(o.sen)] })) : []),
      ]),
      { kind: 'total', cells: ['Total commission', null, ringgit(sum(cards, (c) => c.sen))] },
    ],
  }];
  if (!people) return blocks;
  const lines = bySalespersonOf(r);
  const columns: EcColumn[] = [text('Salesperson'), { label: 'Orders', format: 'number', align: 'right', sums: true }, ...cards.map((c) => money(c.label)), money('Total')];
  const body = lines.map((p): ExportCell[] => [
    p.name, p.orders, ...cards.map((c) => { const sen = p.cards[c.key] ?? 0; return sen === 0 ? null : ringgit(sen); }), ringgit(p.totalSen),
  ]);
  blocks.push({
    title: 'By salesperson', note: "each card over the salesperson's own orders; together the report's total", columns,
    rows: [...body.map((cells): EcRow => ({ kind: 'row', cells })), footOf('total', `Total · ${lines.length === 1 ? '1 salesperson' : `${lines.length} salespeople`}`, columns, body)],
  });
  return blocks;
}

const whoText = (who: EcWho): string => (who.kind === 'all' ? 'Everyone' : who.kind === 'one' ? `Salesperson: ${who.name}` : 'By salesperson');
const forText = (who: EcWho): string => (who.kind === 'all' ? 'Everyone' : who.kind === 'one' ? who.name : 'Each salesperson');
/** The line under each sheet's title, and under the PDF's: period, view, brand, who. */
export const ecSubtitle = (input: Pick<EcInput, 'report' | 'period' | 'brand' | 'who'>): string =>
  [input.period, wordsOf(input.report).toggle, input.brand || 'All brands', whoText(input.who)].filter(Boolean).join(' · ');
export const ecMeta = (input: Pick<EcInput, 'report' | 'period' | 'brand' | 'who'>): Array<{ label: string; value: string }> => [
  { label: 'Period', value: input.period }, { label: 'View', value: wordsOf(input.report).toggle },
  { label: 'Brand', value: input.brand || 'All brands' }, { label: 'For', value: forText(input.who) },
];
/* In English: the PDF's Chinese face has no 补开单, and refused the whole export over it. */
const NOTES = [RULE_NOTE.replace(' (补开单)', '')];

/** Excel: Summary, then a sheet per table — for everyone, for one salesperson, or each
    table's rows by salesperson with a subtotal each. A table with no row has no sheet. */
export function ecSheets(input: EcInput): EcSheet[] {
  const { report, who } = input;
  const subtitle = ecSubtitle(input);
  const r = who.kind === 'one' ? forSalesperson(report, who.name) : report;
  const sheets: EcSheet[] = [{ name: 'Summary', title: who.kind === 'one' ? `Event commission — ${who.name}` : 'Event commission', subtitle, blocks: summaryBlocks(r, who.kind !== 'one'), notes: NOTES }];
  const people = who.kind === 'each' ? salespeopleOf(report).map((name) => ({ name, report: forSalesperson(report, name) })) : [];
  for (const key of EC_TABLES[basisOf(report)]) {
    const block = who.kind === 'each' ? groupedBlock(key, report, people, input) : tableBlock(key, r, input, who.kind === 'one');
    /* The table's own title and note are the sheet's two lines, so its header is the third row on every sheet. */
    if (block) sheets.push({ name: SPECS[key].sheet(report), title: block.title, subtitle: [subtitle, block.note].filter(Boolean).join(' · '), blocks: [{ ...block, title: '', note: null }], notes: [] });
  }
  return sheets;
}

/** PDF: the summary and every table — for everyone, for one salesperson, or the summary
    with its line per salesperson and then each salesperson from a new page. */
export function ecSections(input: EcInput): EcSection[] {
  const { report, who } = input;
  const tablesOf = (r: EventCommission, personal: boolean): EcBlock[] =>
    EC_TABLES[basisOf(report)].map((key) => tableBlock(key, r, input, personal)).filter((b): b is EcBlock => b != null);
  if (who.kind === 'one') {
    const r = forSalesperson(report, who.name);
    return [{ heading: who.name, newPage: false, blocks: [...summaryBlocks(r, false), ...tablesOf(r, true)], notes: NOTES }];
  }
  if (who.kind === 'all') return [{ heading: null, newPage: false, blocks: [...summaryBlocks(report, true), ...tablesOf(report, false)], notes: NOTES }];
  return [
    { heading: null, newPage: false, blocks: summaryBlocks(report, true), notes: NOTES },
    ...salespeopleOf(report).map((name): EcSection => {
      const r = forSalesperson(report, name);
      return { heading: name, newPage: true, blocks: [...summaryBlocks(r, false), ...tablesOf(r, true)], notes: [] };
    }),
  ];
}

/** The file's name: the page's, then whose. */
export const ecFileBase = (base: string, who: EcWho): string =>
  who.kind === 'all' ? base : who.kind === 'each' ? `${base}-by-salesperson` : `${base}-${who.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'salesperson'}`;
