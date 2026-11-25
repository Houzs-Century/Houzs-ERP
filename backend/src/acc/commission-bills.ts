// ----------------------------------------------------------------------------
// acc/commission-bills — what the PREPAYMENT COMMISSION account holds, read off
// the ledger: every line the books count on the company's COMMISSION_PREPAID
// account except the monthly release itself (COMMREL), each with the month it
// pays for. A bill names its month in its line ("REVENUE TEAM PAYROLL TO
// COLLECT BACK - OCT'26 …", "… AUG26"); a line that names none is read as its
// own entry's month. The books' OPENING line is the opening balance (month null).
//
// Two readers: the monthly release (acc/commission-release.ts) splits each
// month's bills over the orders they paid; the Performance P&L shows each
// month's bills as that month's commission (owner 2026-11-25: 「如果performance
// PNL就remain invoice amount，因为这个是performance」).
// ----------------------------------------------------------------------------

import { paginateAll } from '../scm/lib/paginate-all';
import { countsInTheBooks } from './reversal-pairs';
import type { resolveRoles } from './rules';
import type { PrepaidLine, Ym } from './commission-release-plan';

export const RELEASE_SOURCE = 'COMMREL';

const MONTH_NO: Record<string, number> = {
  JAN: 1, JANUARY: 1, FEB: 2, FEBRUARY: 2, MAR: 3, MARCH: 3, APR: 4, APRIL: 4, MAY: 5,
  JUN: 6, JUNE: 6, JUL: 7, JULY: 7, AUG: 8, AUGUST: 8, SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10, NOV: 11, NOVEMBER: 11, DEC: 12, DECEMBER: 12,
};
const NAME = '(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER|SEPT|JAN|FEB|MAR|APR|JUN|JUL|AUG|SEP|OCT|NOV|DEC)';
/* OCT'26 · OCT’ 26 · AUG26 · SEPT2026 · SEP 2026 — a two-digit year only when
   it is joined to the month (or after an apostrophe), so "SEP 30" is a day. */
const MONTH_YEAR = new RegExp(`(?<![A-Z])${NAME}(?:\\s*['’]\\s?(\\d{2})(?!\\d)|(\\d{2})(?!\\d)|\\s*(\\d{4})(?!\\d))`);
/* SEP 1 – SEP 30, 2026: the first month, the year at the end. */
const DAY_RANGE = new RegExp(`(?<![A-Z])${NAME}\\s+\\d{1,2}\\s*[–—-]\\s*${NAME}\\s+\\d{1,2},?\\s*(\\d{4})(?!\\d)`);

/** The month a commission bill's text names, or null when it names none. */
export function billMonthOf(text: string | null | undefined): Ym | null {
  const t = String(text ?? '').toUpperCase();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hit = MONTH_YEAR.exec(t);
  if (hit) {
    /* A group that did not take part is undefined at run time, whatever the array's type says. */
    const m: Array<string | undefined> = [...hit];
    const mo = MONTH_NO[m[1] ?? ''];
    const yy = m[2] ?? m[3];
    const year = yy ? 2000 + Number(yy) : Number(m[4]);
    if (mo && year >= 2000 && year < 2100) return `${year}-${pad(mo)}`;
  }
  const r = DAY_RANGE.exec(t);
  if (r) {
    const mo = MONTH_NO[r[1]!];
    const year = Number(r[3]);
    if (mo && year >= 2000 && year < 2100) return `${year}-${pad(mo)}`;
  }
  return null;
}

export type PrepaidLedgerLine = PrepaidLine & {
  entryDate: string;
  jeNo: string;
  sourceType: string;
  notes: string | null;
  /** The line named no month — read as its entry's month. */
  monthGuessed: boolean;
};

type Row = Record<string, unknown>;
/* The PostgREST client is untyped throughout the acc layer; borrow its type rather than write any. */
type Db = Parameters<typeof resolveRoles>[0];

/** Every line on the prepaid account the books count, but the release's own. */
export async function loadPrepaidLines(sb: Db, companyId: number, prepaidCode: string): Promise<{ ok: true; lines: PrepaidLedgerLine[] } | { ok: false; reason: string }> {
  const { data, error } = await paginateAll<Row>((f, t) => sb.from('v_gl_entries')
    .select('line_id, je_no, entry_date, source_type, source_doc_no, debit_sen, credit_sen, notes, posted, reversed, reversed_by_je')
    .eq('company_id', companyId).eq('account_code', prepaidCode)
    .order('line_id').range(f, t));
  if (error) return { ok: false, reason: `prepaid lines: ${String((error as { message?: string }).message ?? error)}` };
  const lines: PrepaidLedgerLine[] = [];
  for (const r of data ?? []) {
    if (!countsInTheBooks(r as { posted?: boolean | null; reversed?: boolean | null; reversed_by_je?: string | null })) continue;
    const sourceType = String(r.source_type ?? '');
    if (sourceType.replace(/_REVERSAL$/, '') === RELEASE_SOURCE) continue;
    const entryDate = String(r.entry_date ?? '').slice(0, 10);
    const notes = r.notes == null ? null : String(r.notes);
    const opening = sourceType === 'OPENING';
    const named = opening ? null : billMonthOf(notes);
    lines.push({
      month: opening ? null : (named ?? entryDate.slice(0, 7)),
      amountSen: Number(r.debit_sen ?? 0) - Number(r.credit_sen ?? 0),
      docNo: String(r.source_doc_no ?? r.je_no ?? ''),
      entryDate, jeNo: String(r.je_no ?? ''), sourceType, notes,
      monthGuessed: !opening && named == null,
    });
  }
  return { ok: true, lines };
}

/** The bills by the month they pay for (the opening left out) — the Performance P&L's commission. */
export function billsByMonth(lines: ReadonlyArray<Pick<PrepaidLine, 'month' | 'amountSen'>>): Map<Ym, number> {
  const out = new Map<Ym, number>();
  for (const l of lines) if (l.month != null) out.set(l.month, (out.get(l.month) ?? 0) + l.amountSen);
  return out;
}
