// ----------------------------------------------------------------------------
// statementColumns — the columns a Finance statement shows (the owner's Claude
// Design, batch 6 §4.1 / §5.1) and the lines they merge into. A column IS the
// report for its period, read from the report's own endpoint, so a month can
// never disagree with the same month shown alone:
//   · Single — the range picked;
//   · Compare — the range and the one it is compared with (the period before
//     it, or the same dates a year back), and the change between them;
//   · By month — Total over the months (leftmost), then each month, newest
//     first, ending at the range's last month (a balance sheet's month is its
//     month-end balance, and it has no Total).
// Nothing here formats a date by hand: days through fmtDate, months through
// toLocaleString with a fixed locale and zone (a month label is not a date).
// ----------------------------------------------------------------------------

import { addDays, daysInRange, monthEnd, monthStart } from '../../../lib/dateRangePresets';
import { fmtDate } from '../../../vendor/shared/format';
import type { FlatLine, MonthlyLine } from '../../../vendor/scm/lib/report-monthly';
import { mergeColumns } from '../../../vendor/scm/lib/report-monthly';

export type StatementView = 'single' | 'compare' | 'month';
export type CompareWith = 'previous' | 'lastYear';

export type StatementColumn = {
  key: string;
  label: string;
  /** The small grey line under the label. */
  sub?: string;
  /** Total: the tinted column with the stronger rule after it; change: computed, no lines. */
  kind: 'total' | 'period' | 'change';
  /** The period the column reads, and its lines open on. */
  from: string;
  to: string;
  /** A % rides beside the amount. */
  pct: boolean;
  /** A column under a heading it shares with its neighbours (the Cash Flow's Settlement |
      Deposit under each month): the heading's key, its name, its small grey line. */
  group?: { key: string; label: string; sub?: string };
  /** A small coloured mark before the column's name, so two columns of one heading tell
      apart at a glance (the Cash Flow's Settlement petrol, Deposit gold — owner 2026-11-10). */
  mark?: 'petrol' | 'gold';
};

export type StatementLine = MonthlyLine;

/** "Oct 2026" — a month as a column names it. */
export const monthName = (iso: string): string =>
  new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** "October 2026" when the range is one whole month, else its two days. */
export function periodLabel(from: string, to: string): string {
  if (from === monthStart(from) && to === monthEnd(from)) {
    return new Date(`${from}T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return from === to ? fmtDate(from) : `${fmtDate(from)} – ${fmtDate(to)}`;
}

/** Whole months a range spans, counting both ends' months. */
export const monthsSpanned = (from: string, to: string): number =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/** The same calendar day a year back (29 Feb falls to the 28th). */
export function yearBack(iso: string): string {
  const yr = Number(iso.slice(0, 4)) - 1;
  const mo = Number(iso.slice(5, 7)) - 1;
  const last = new Date(Date.UTC(yr, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(yr, mo, Math.min(Number(iso.slice(8, 10)), last))).toISOString().slice(0, 10);
}

/**
 * The range a period is compared with — the design's rule (script shiftR):
 *   · same period last year: the same days a year back;
 *   · previous period: a range starting on the 1st steps back by the whole
 *     months it spans (October → September, Q3 → Q2); any other range steps
 *     back by its own length in days. A range running past today counts to
 *     today, so a month in progress is compared day for day.
 */
export function compareRange(from: string, to: string, today: string, how: CompareWith): { from: string; to: string } {
  const end = to > today ? today : to;
  if (how === 'lastYear') return { from: yearBack(from), to: yearBack(end) };
  if (from === monthStart(from)) {
    const n = monthsSpanned(from, end);
    return { from: monthStart(from, -n), to: addDays(from, -1) };
  }
  const len = daysInRange(from, end);
  const cmpTo = addDays(from, -1);
  return { from: addDays(cmpTo, -(len - 1)), to: cmpTo };
}

export const COMPARE_WITH: ReadonlyArray<{ value: CompareWith; label: string }> = [
  { value: 'previous', label: 'Previous period' },
  { value: 'lastYear', label: 'Same period last year' },
];

export const MONTH_COUNTS = [3, 6, 12] as const;

/** A P&L's columns for the view. */
export function pnlColumns(view: StatementView, from: string, to: string, today: string, opts: { compareWith: CompareWith; months: number }): StatementColumn[] {
  if (view === 'compare') {
    const cmp = compareRange(from, to, today, opts.compareWith);
    return [
      { key: 'cur', label: periodLabel(from, to), sub: 'This period', kind: 'period', from, to, pct: true },
      { key: 'cmp', label: periodLabel(cmp.from, cmp.to), sub: opts.compareWith === 'lastYear' ? 'Same period last year' : 'Previous period', kind: 'period', from: cmp.from, to: cmp.to, pct: true },
      { key: 'chg', label: 'Change', sub: 'This period less the other', kind: 'change', from, to, pct: false },
    ];
  }
  if (view === 'month') return monthColumns(to, opts.months, today, true);
  return [{ key: 'cur', label: periodLabel(from, to), kind: 'period', from, to, pct: true }];
}

/** A balance sheet's columns: the day, or each month-end, newest first. */
export function balanceColumns(view: StatementView, asAt: string, today: string, months: number): StatementColumn[] {
  if (view === 'month') return monthColumns(asAt, months, today, false);
  return [{ key: 'cur', label: `As at ${fmtDate(asAt)}`, kind: 'period', from: monthStart(asAt), to: asAt, pct: true }];
}

/** `count` months ending with the month `latest` falls in, newest first; a
 *  Total over them leftmost when the report adds months up. The month still
 *  running says so under its name. */
export function monthColumns(latest: string, count: number, today: string, withTotal: boolean): StatementColumn[] {
  const n = Math.max(1, count);
  const months = Array.from({ length: n }, (_, i) => monthStart(latest, -i));
  const cols: StatementColumn[] = months.map((m) => {
    const running = m <= today && today < monthEnd(m);
    return {
      key: m.slice(0, 7),
      label: monthName(m),
      ...(running ? { sub: `to ${fmtDate(today)} *` } : {}),
      kind: 'period',
      from: m,
      to: monthEnd(m),
      pct: true,
    };
  });
  if (withTotal) {
    const oldest = months[months.length - 1]!;
    cols.unshift({ key: 'total', label: 'Total', sub: `${n} months`, kind: 'total', from: oldest, to: monthEnd(months[0]!), pct: true });
  }
  return cols;
}

/** The columns' lines merged by id (the union, each line where its column
 *  first had it), the change column computed once, here: this period less
 *  the other, on every line both name. */
export function statementLines(columns: StatementColumn[], linesByKey: Partial<Record<string, FlatLine[]>>): StatementLine[] {
  const read = columns.filter((c) => c.kind !== 'change' && linesByKey[c.key]);
  const merged = mergeColumns(read.map((c) => ({ key: c.key, lines: linesByKey[c.key]! })));
  const change = columns.find((c) => c.kind === 'change');
  if (!change) return merged;
  return merged.map((l) => {
    if (l.kind === 'block') return l;
    const cur = l.cells.cur?.amountSen;
    const cmp = l.cells.cmp?.amountSen;
    if (cur === undefined && cmp === undefined) return l;
    return { ...l, cells: { ...l.cells, [change.key]: { amountSen: (cur ?? 0) - (cmp ?? 0), pct: null } } };
  });
}

/** The span every column with lines covers — what an account's name opens. */
export function columnsSpan(columns: StatementColumn[]): { from: string; to: string } {
  const read = columns.filter((c) => c.kind !== 'change');
  return {
    from: read.reduce((a, c) => (c.from < a ? c.from : a), read[0]?.from ?? ''),
    to: read.reduce((a, c) => (c.to > a ? c.to : a), read[0]?.to ?? ''),
  };
}
