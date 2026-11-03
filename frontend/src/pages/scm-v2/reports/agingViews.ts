// ----------------------------------------------------------------------------
// agingViews — what the AR / AP aging screen works out from the report it was
// given (the owner's Claude Design, batch 6 §5.4 (a), question g1's default),
// once, so the tiles, the tables and the exports read the same figures:
//   · the tiles' second lines — how many parties hold money in each column,
//     in Unapplied, and at all;
//   · the By invoice view — the design's flat table: each open bill of each
//     party with its Days overdue (the as-at day less the due day; a bill with
//     no due date is due on its own date, as the server ages it by due date)
//     and the design's bucket (Current / 1-30 / 31-60 / 61-90 / 90+), then the
//     money not tied to a bill, as Unapplied.
// No read change: everything comes from the report's rows[].items/unapplied.
// ----------------------------------------------------------------------------

import type { AgingRow } from '../../../vendor/scm/lib/aging-queries';
import type { Tone } from '../finance/SetupParts';

export type OverdueBucket = 'current' | 'd1' | 'd31' | 'd61' | 'd91';

/** The design's buckets with their tags' tones (script 535–537: Current calm,
 *  1-30 info, 31-60 warn, 61-90 and 90+ late — a late tag carries its dot). */
export const OVERDUE_BUCKET: Record<OverdueBucket, { label: string; tone: Tone; dot: boolean }> = {
  current: { label: 'Current', tone: 'calm', dot: false },
  d1: { label: '1-30', tone: 'info', dot: false },
  d31: { label: '31-60', tone: 'warn', dot: false },
  d61: { label: '61-90', tone: 'late', dot: true },
  d91: { label: '90+', tone: 'late', dot: true },
};

/** Money not tied to a bill (未冲) gets its own tag. */
export const UNAPPLIED_LABEL = 'Unapplied';

/** A line's tag text: its bucket, or Unapplied. */
export const bucketLabel = (b: OverdueBucket | 'unapplied'): string => (b === 'unapplied' ? UNAPPLIED_LABEL : OVERDUE_BUCKET[b].label);

/** The order a customer's bill belongs to — its group is 'SO:<order>' on AR. */
export const soOfGroup = (group: string): string | null => (group.startsWith('SO:') ? group.slice(3) : null);

const dayNo = (iso: string): number =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round(dayNo(to) - dayNo(from));

/** The design's bucket for a number of days overdue; not yet due is Current. */
export function overdueBucket(days: number): OverdueBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1';
  if (days <= 60) return 'd31';
  if (days <= 90) return 'd61';
  return 'd91';
}

export type AgingInvoiceLine = {
  key: string;
  partyKey: string;
  partyCode: string | null;
  partyName: string;
  docNo: string;
  kind: string;
  date: string;
  dueDate: string | null;
  /** The order a customer's bill belongs to (AR), for its link. */
  so: string | null;
  /** The bill's whole amount; for unapplied money, that money. */
  amountSen: number;
  /** What is outstanding: the bill's open part, or the unapplied money (negative). */
  outstandingSen: number;
  /** The column the bill sits in on the party view; null for unapplied money. */
  column: number | null;
  /** The as-at day less the due day (or the bill's date); null for unapplied money. */
  daysOverdue: number | null;
  bucket: OverdueBucket | 'unapplied';
};

/** Most overdue first; the unapplied money after the bills; then by date and number. */
const byOverdue = (a: AgingInvoiceLine, b: AgingInvoiceLine): number =>
  (b.daysOverdue ?? Number.NEGATIVE_INFINITY) - (a.daysOverdue ?? Number.NEGATIVE_INFINITY)
  || a.date.localeCompare(b.date)
  || a.docNo.localeCompare(b.docNo);

/** The By invoice view's lines, from the parties the screen shows. */
export function agingInvoiceLines(rows: readonly AgingRow[], asOf: string): AgingInvoiceLine[] {
  const out: AgingInvoiceLine[] = [];
  for (const r of rows) {
    const party = { partyKey: r.key, partyCode: r.code, partyName: r.name };
    r.items.forEach((i, n) => {
      const days = daysBetween(i.dueDate ?? i.date, asOf);
      out.push({
        key: `${r.key}|b${n}|${i.docNo}`, ...party,
        docNo: i.docNo, kind: i.kind, date: i.date, dueDate: i.dueDate,
        so: soOfGroup(i.group),
        amountSen: i.amountSen, outstandingSen: i.openSen, column: i.column,
        daysOverdue: days, bucket: overdueBucket(days),
      });
    });
    r.unapplied.forEach((u, n) => {
      out.push({
        key: `${r.key}|u${n}|${u.docNo}`, ...party,
        docNo: u.docNo, kind: u.kind, date: u.date, dueDate: null, so: null,
        amountSen: u.amountSen, outstandingSen: u.amountSen, column: null,
        daysOverdue: null, bucket: 'unapplied',
      });
    });
  }
  return out.sort(byOverdue);
}

export type AgingPartyCounts = { cells: number[]; unapplied: number; all: number };

/** How many parties hold money in each column, in Unapplied, and at all. */
export function agingPartyCounts(rows: readonly AgingRow[], columns: number): AgingPartyCounts {
  const cells = Array<number>(columns).fill(0);
  let unapplied = 0;
  for (const r of rows) {
    r.cells.forEach((v, i) => { if (v !== 0 && i < columns) cells[i] += 1; });
    if (r.unappliedSen !== 0) unapplied += 1;
  }
  return { cells, unapplied, all: rows.length };
}

/** What a tile picks: one of the five columns, the unapplied money, or nothing (Total). */
export type AgingPick = number | 'unapplied' | null;

/** The parties with money where the tile points. */
export const partiesIn = (rows: readonly AgingRow[], pick: AgingPick): AgingRow[] =>
  pick === null ? [...rows]
    : pick === 'unapplied' ? rows.filter((r) => r.unappliedSen !== 0)
      : rows.filter((r) => r.cells[pick] !== 0);

/** The By invoice lines where the tile points. */
export const linesIn = (lines: readonly AgingInvoiceLine[], pick: AgingPick): AgingInvoiceLine[] =>
  pick === null ? [...lines]
    : pick === 'unapplied' ? lines.filter((l) => l.bucket === 'unapplied')
      : lines.filter((l) => l.column === pick);
