// ----------------------------------------------------------------------------
// so-do-conversion — Finance's SO to DO conversion report (owner 2026-11-24:
// 「我要的报表比较简单，就是这个月开的订单转化去do是多少，剩下的都算之前」 and
// 「我要可以选月份，如果看到total amount，和percentage」).
//
// The month's delivery orders — every DO dated in the month that has shipped,
// so neither a Draft nor a Cancelled one (owner 2026-08-22: Confirmed means the
// goods went out) — split by the month of the sales order each was raised from:
//   • this month's orders: the order's SO date is in the same month;
//   • earlier orders: the order is dated before the month, the orders brought
//     over from AutoCount at the cutover included (「剩下的都算之前」);
//   • other: a DO with no sales order of this company, or one whose order is
//     dated after the DO's month. Shown only when there is one.
// Each part carries its DOs, their total (the DO's own total, which is the sum
// of its lines) and its share of the month's DO total. A DO is raised from one
// order (`delivery_orders.so_doc_no`), so it sits in exactly one part.
// ----------------------------------------------------------------------------

import { doCountsAsDelivered } from '../scm/shared/do-shipped-states';
import { soIsMigratedShape } from '../scm/lib/so-is-migrated';

export type ScDoRow = {
  id: string;
  do_number: string | null;
  do_date: string;
  so_doc_no: string | null;
  status: string | null;
  local_total_sen: number | string | null;
  debtor_name: string | null;
};

export type ScOrder = {
  doc_no: string;
  so_date: string | null;
  debtor_name: string | null;
  linked_ac_docno: string | null;
};

export type ConversionPart = 'this_month' | 'earlier' | 'other';

/** Why a DO of the month is in "other": it names no order, its order is not one
 *  of this company's, or its order is dated after the DO's month. */
export type OtherReason = 'no_order' | 'order_not_found' | 'order_after';

export type ConversionRow = {
  id: string;
  doNumber: string;
  doDate: string;
  status: string;
  docNo: string | null;
  soDate: string | null;
  customer: string | null;
  /** The order came over from AutoCount at the cutover (`soIsMigratedShape`). */
  imported: boolean;
  part: ConversionPart;
  otherReason: OtherReason | null;
  amountSen: number;
};

export type ConversionTotal = {
  dos: number;
  amountSen: number;
  /** Share of the month's DO total, one decimal; null when the month has none. */
  pct: number | null;
};

export type SoDoConversionData = {
  month: string;
  from: string;
  to: string;
  total: ConversionTotal;
  parts: Record<ConversionPart, ConversionTotal>;
  rows: ConversionRow[];
};

const sen = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? Math.round(x) : 0;
};

const day = (v: string | null | undefined): string | null => (v ? String(v).slice(0, 10) : null);

export const shareOf = (part: number, whole: number): number | null =>
  (whole === 0 ? null : Math.round((part / whole) * 1000) / 10);

const PARTS: readonly ConversionPart[] = ['this_month', 'earlier', 'other'];

/** Each part's share, one decimal, adding up to 100.0: what rounding leaves
 *  over goes to the largest part, as a statement's rounding line would, so a
 *  reader adding the shares never lands on 99.9. */
function sharesOf(amounts: Record<ConversionPart, number>, whole: number): Record<ConversionPart, number | null> {
  if (whole === 0) return { this_month: null, earlier: null, other: null };
  const tenths = Object.fromEntries(PARTS.map((p) => [p, Math.round((amounts[p] / whole) * 1000)])) as Record<ConversionPart, number>;
  const left = 1000 - PARTS.reduce((s, p) => s + tenths[p], 0);
  if (left !== 0) {
    const largest = PARTS.reduce((a, b) => (amounts[b] > amounts[a] ? b : a));
    tenths[largest] += left;
  }
  return { this_month: tenths.this_month / 10, earlier: tenths.earlier / 10, other: tenths.other / 10 };
}

function partOf(soDate: string | null, from: string, to: string): { part: ConversionPart; otherReason: OtherReason | null } {
  if (soDate === null) return { part: 'other', otherReason: 'order_not_found' };
  if (soDate < from) return { part: 'earlier', otherReason: null };
  if (soDate <= to) return { part: 'this_month', otherReason: null };
  return { part: 'other', otherReason: 'order_after' };
}

export function buildSoDoConversion(input: {
  month: string;
  from: string;
  to: string;
  dos: readonly ScDoRow[];
  orders: readonly ScOrder[];
}): SoDoConversionData {
  const orderOf = new Map(input.orders.map((o) => [o.doc_no, o]));
  const rows: ConversionRow[] = [];
  for (const d of input.dos) {
    const doDate = day(d.do_date);
    if (doDate === null || doDate < input.from || doDate > input.to) continue;
    if (!doCountsAsDelivered(d.status)) continue;
    const docNo = d.so_doc_no?.trim() || null;
    const o = docNo ? orderOf.get(docNo) : undefined;
    const soDate = o ? day(o.so_date) : null;
    const placed = docNo === null
      ? { part: 'other' as const, otherReason: 'no_order' as const }
      : partOf(soDate, input.from, input.to);
    rows.push({
      id: d.id,
      doNumber: d.do_number ?? d.id,
      doDate,
      status: String(d.status ?? ''),
      docNo,
      soDate,
      customer: o?.debtor_name ?? d.debtor_name ?? null,
      imported: o ? soIsMigratedShape(o.doc_no, o.linked_ac_docno) : false,
      ...placed,
      amountSen: sen(d.local_total_sen),
    });
  }
  rows.sort((a, b) => (a.doDate !== b.doDate ? (a.doDate < b.doDate ? -1 : 1) : a.doNumber.localeCompare(b.doNumber)));

  const add = (rs: readonly ConversionRow[]) => ({ dos: rs.length, amountSen: rs.reduce((s, r) => s + r.amountSen, 0) });
  const all = add(rows);
  const sums = Object.fromEntries(PARTS.map((p) => [p, add(rows.filter((r) => r.part === p))])) as Record<ConversionPart, { dos: number; amountSen: number }>;
  const pct = sharesOf({ this_month: sums.this_month.amountSen, earlier: sums.earlier.amountSen, other: sums.other.amountSen }, all.amountSen);
  return {
    month: input.month,
    from: input.from,
    to: input.to,
    total: { ...all, pct: all.amountSen === 0 ? null : 100 },
    parts: {
      this_month: { ...sums.this_month, pct: pct.this_month },
      earlier: { ...sums.earlier, pct: pct.earlier },
      other: { ...sums.other, pct: pct.other },
    },
    rows,
  };
}
