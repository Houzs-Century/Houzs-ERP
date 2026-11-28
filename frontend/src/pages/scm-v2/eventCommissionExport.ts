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
// Owner 2026-11-19 (「导出的别放先」, 「summary我主要看的就是 每个tab的total」, 「要有
// total good」): a line at 0.00 is left out of the file unless asked for (the page
// lists every line), each table saying how many; the summary is each tab's total —
// its goods and commission, a line per brand with the rate — and the file can be
// the summary alone.
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
  countText, deferredInOf, earlierShownOf, earningOnly, forSalesperson, manualOf, markedOf, monthAdjOf, salespeopleOf, soListOf, sum,
  summaryTabsOf, summaryTotalOf, type BelowDepositRow, type SoListRow, type SummaryLine,
} from './eventCommissionModel';

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
  columns: ReadonlyArray<Column<T>>;
  rowKeys: readonly string[] | null;
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
/** A line; a line inside the one above it (a brand under its tab); an "of which" line under a card;
    a salesperson's name over their lines; their subtotal (or a tab's total over its brands); the total. */
export type EcRowKind = 'row' | 'inner' | 'memo' | 'group' | 'subtotal' | 'total';
export type EcRow = { kind: EcRowKind; cells: ExportCell[] };
/** One table: its title, a line on what narrowed it or that it is not in the total, its columns and rows.
    `narrow`: a short table (the summary) that keeps to its own width on paper. */
export type EcBlock = { title: string; note: string | null; columns: EcColumn[]; rows: EcRow[]; narrow?: boolean };
/** An Excel sheet: its tab's name, the two lines over it, its tables, notes under them. */
export type EcSheet = { name: string; title: string; subtitle: string; blocks: EcBlock[]; notes: string[] };
/** A stretch of the PDF: a salesperson's name over it, from a new page or not; its tables; notes under them. */
export type EcSection = { heading: string | null; newPage: boolean; blocks: EcBlock[]; notes: string[] };

/** The whole report, or its summary alone. */
export type EcPart = 'full' | 'summary';
/** `leaveOutZero`: the tables hold only their lines that earn (the summary always does). */
export type EcInput = { report: EventCommission; period: string; brand: string; shown: ShownTables; who: EcWho; part: EcPart; leaveOutZero: boolean };

type Spec<K extends EcTableKey> = {
  title: (r: EventCommission) => string;
  sheet: (r: EventCommission) => string;
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
const columnOf = <T,>(c: Column<T>): EcColumn => {
  const format = c.exportFormat ?? 'text';
  return { label: c.exportLabel || c.label, format, align: isFigure(format) || c.align === 'right' ? 'right' : 'left', sums: isFigure(format) };
};
const addUp = (cells: readonly ExportCell[]): number => cells.reduce<number>((s, v) => s + (typeof v === 'number' ? Math.round(v * 100) : 0), 0) / 100;

function footOf(kind: 'subtotal' | 'total', label: string, columns: readonly EcColumn[], body: readonly ExportCell[][]): EcRow {
  const at = Math.max(0, columns.findIndex((c) => !c.sums));
  return { kind, cells: columns.map((c, i) => (c.sums ? addUp(body.map((row) => row[i] ?? null)) : i === at ? label : null)) };
}

function ordered<K extends EcTableKey>(key: K, rows: Array<Rows[K]>, rowKeys: readonly string[] | null): Array<Rows[K]> {
  if (!rowKeys) return rows;
  const keyOf = EC_ROW_KEY[key] as (row: Rows[K]) => string;
  const at = new Map(rowKeys.map((k, i) => [k, i]));
  return rows.filter((row) => at.has(keyOf(row))).sort((a, b) => at.get(keyOf(a))! - at.get(keyOf(b))!);
}

type Pair = { r: EventCommission; all: EventCommission };

function bodyOf<K extends EcTableKey>(key: K, r: EventCommission, shown: ShownTable<Rows[K]>, personal: boolean): { columns: EcColumn[]; body: ExportCell[][]; of: number } {
  const cols = shown.columns.filter((c) => (c.getValue || c.exportValue) && !(personal && c.key === 'salesperson'));
  const all = SPECS[key].rows(r);
  const rows = ordered(key, all, shown.rowKeys);
  return { columns: cols.map(columnOf), body: buildLineExportMatrix(rows, () => [], cols).body, of: all.length };
}

function zeroOf<K extends EcTableKey>(key: K, pair: Pair, rowKeys: readonly string[] | null): { left: number; of: number } {
  const of = ordered(key, SPECS[key].rows(pair.all), rowKeys).length;
  return { left: of - ordered(key, SPECS[key].rows(pair.r), rowKeys).length, of };
}

const noteOf = (key: EcTableKey, r: EventCommission, shown: ShownTable<unknown>, kept: number, of: number, zero: { left: number; of: number }): string | null => {
  const apart = SPECS[key].apart?.(r) ?? null;
  const narrowed = shown.filters ? `Filter: ${shown.filters}` : kept < of ? `Filtered on the page: ${kept} of ${of} rows` : null;
  const left = zero.left > 0 ? `${zero.left} of ${zero.of} rows at 0.00 left out` : null;
  const parts = [apart, narrowed, left].filter((p): p is string => p != null);
  return parts.length > 0 ? parts.join(' · ') : null;
};

function tableBlock<K extends EcTableKey>(key: K, pair: Pair, input: EcInput, personal: boolean): EcBlock | null {
  const shown = input.shown[key];
  const { columns, body, of } = bodyOf(key, pair.r, shown, personal);
  if (body.length === 0 || columns.length === 0) return null;
  return {
    title: SPECS[key].title(pair.r), note: noteOf(key, pair.r, shown as ShownTable<unknown>, body.length, of, zeroOf(key, pair, shown.rowKeys)), columns,
    rows: [...body.map((cells): EcRow => ({ kind: 'row', cells })), footOf('total', `Total · ${countText(body.length, SPECS[key].unit)}`, columns, body)],
  };
}

function groupedBlock<K extends EcTableKey>(key: K, pair: Pair, people: ReadonlyArray<{ name: string; report: EventCommission }>, input: EcInput): EcBlock | null {
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
  return {
    title: SPECS[key].title(pair.r), note: noteOf(key, pair.r, shown as ShownTable<unknown>, all.length, sum(each, (p) => p.of), zeroOf(key, pair, shown.rowKeys)),
    columns, rows,
  };
}

const text = (label: string, align: 'left' | 'right' = 'left'): EcColumn => ({ label, format: 'text', align, sums: false });
const money = (label: string): EcColumn => ({ label, format: 'money', align: 'right', sums: true });
const ringgit = (sen: number): number => sen / 100;
const summaryCells = (l: SummaryLine): ExportCell[] =>
  [l.label, l.count, l.goodsSen == null ? null : ringgit(l.goodsSen), l.ratePct == null ? null : `${l.ratePct}%`, ringgit(l.commissionSen)];

/** The summary (owner 2026-11-19: 「summary我主要看的就是 每个tab的total」, 「要有total good」):
    each tab's total — its lines that earn, their goods, its commission — a line per brand
    under it with the rate, the first one's "of which" lines, the total of goods and of
    commission; and with `people`, a line per salesperson — each card over their own lines,
    their total. Over the report's lines that earn: `r` is earningOnly's. */
function summaryBlocks(r: EventCommission, people: boolean, note: string | null): EcBlock[] {
  const tabs = summaryTabsOf(r);
  const total = summaryTotalOf(tabs);
  const blocks: EcBlock[] = [{
    title: 'Summary', note, narrow: true,
    columns: [text(''), { label: 'Orders', format: 'number', align: 'right', sums: false }, { ...money('Goods'), sums: false }, text('Rate', 'right'), { ...money('Commission'), sums: false }],
    rows: [
      ...tabs.flatMap((t): EcRow[] => [
        { kind: 'subtotal', cells: summaryCells(t.total) },
        ...t.brands.map((b): EcRow => ({ kind: 'inner', cells: summaryCells(b) })),
        ...t.inside.map((o): EcRow => ({ kind: 'memo', cells: summaryCells(o) })),
      ]),
      { kind: 'total', cells: ['Total', null, total.goodsSen == null ? null : ringgit(total.goodsSen), null, ringgit(total.commissionSen)] },
    ],
  }];
  if (!people) return blocks;
  const cards = cardsOf(r);
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
const NOTES = [RULE_NOTE];
export const SUMMARY_NOTE = "The summary counts only the lines that earn. On each brand's line Goods × Rate = Commission; a cancelled order's goods are in brackets; a closed month's adjustment is its Goods × Rate less what that month already paid.";
export const LEFT_OUT_NOTE = 'Lines at 0.00 are left out of this file, and with them Below 30% paid and Marked — not paid here; the page lists every line.';
const summaryNote = (input: EcInput): string => [SUMMARY_NOTE, input.part === 'full' && input.leaveOutZero ? LEFT_OUT_NOTE : null].filter(Boolean).join(' ');

function filed(input: EcInput): { pair: Pair; earning: EventCommission; personal: (name: string) => Pair } {
  const earning = earningOnly(input.report);
  const r = input.leaveOutZero ? earning : input.report;
  return { pair: { r, all: input.report }, earning, personal: (name) => ({ r: forSalesperson(r, name), all: forSalesperson(input.report, name) }) };
}

/** Excel: Summary, then a sheet per table — for everyone, for one salesperson, or each
    table's rows by salesperson with a subtotal each. A table with no row has no sheet.
    The summary alone: its sheet, for each salesperson their own summary under it in turn. */
export function ecSheets(input: EcInput): EcSheet[] {
  const { report, who } = input;
  const subtitle = ecSubtitle(input);
  const { pair, earning, personal } = filed(input);
  const one = who.kind === 'one' ? who.name : null;
  const theirs = input.part === 'summary' && who.kind === 'each'
    ? salespeopleOf(earning).map((name): EcBlock => ({ ...summaryBlocks(forSalesperson(earning, name), false, null)[0]!, title: name }))
    : [];
  const sheets: EcSheet[] = [{
    name: 'Summary', title: one ? `Event commission — ${one}` : 'Event commission', subtitle,
    blocks: [...summaryBlocks(one ? forSalesperson(earning, one) : earning, !one, summaryNote(input)), ...theirs], notes: NOTES,
  }];
  if (input.part === 'summary') return sheets;
  const people = who.kind === 'each' ? salespeopleOf(pair.r).map((name) => ({ name, report: forSalesperson(pair.r, name) })) : [];
  for (const key of EC_TABLES[basisOf(report)]) {
    const block = who.kind === 'each' ? groupedBlock(key, pair, people, input) : tableBlock(key, one ? personal(one) : pair, input, one != null);
    if (block) sheets.push({ name: SPECS[key].sheet(report), title: block.title, subtitle: [subtitle, block.note].filter(Boolean).join(' · '), blocks: [{ ...block, title: '', note: null }], notes: [] });
  }
  return sheets;
}

/** PDF: the summary and every table — for everyone, for one salesperson, or the summary
    with its line per salesperson and then each salesperson from a new page. The summary
    alone: the same pages without the tables. */
export function ecSections(input: EcInput): EcSection[] {
  const { report, who } = input;
  const { pair, earning, personal } = filed(input);
  const note = summaryNote(input);
  const tablesOf = (p: Pair, mine: boolean): EcBlock[] => (input.part === 'summary' ? [] :
    EC_TABLES[basisOf(report)].map((key) => tableBlock(key, p, input, mine)).filter((b): b is EcBlock => b != null));
  if (who.kind === 'one') {
    return [{ heading: who.name, newPage: false, blocks: [...summaryBlocks(forSalesperson(earning, who.name), false, note), ...tablesOf(personal(who.name), true)], notes: NOTES }];
  }
  if (who.kind === 'all') return [{ heading: null, newPage: false, blocks: [...summaryBlocks(earning, true, note), ...tablesOf(pair, false)], notes: NOTES }];
  return [
    { heading: null, newPage: false, blocks: summaryBlocks(earning, true, note), notes: NOTES },
    ...salespeopleOf(input.part === 'summary' ? earning : pair.r).map((name): EcSection => ({
      heading: name, newPage: true, blocks: [...summaryBlocks(forSalesperson(earning, name), false, null), ...tablesOf(personal(name), true)], notes: [],
    })),
  ];
}

/** The file's name: the page's, "summary" for the summary alone, then whose. */
export const ecFileBase = (base: string, who: EcWho, part: EcPart): string => {
  const b = part === 'summary' ? `${base}-summary` : base;
  return who.kind === 'all' ? b : who.kind === 'each' ? `${b}-by-salesperson` : `${b}-${who.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'salesperson'}`;
};
