// ----------------------------------------------------------------------------
// event-commission.ts — Accounting › Reports › Event Commission (owner
// 2026-10-20). Pure: the route reads, this decides.
//
// THE RULES, as the owner set them:
//   · An order's commission = its GOODS (the four goods buckets — delivery and
//     service earn none) × the fair's brand rate (project_cost_rates
//     .commission_normal_pct — 「没有升级后的了」, no boost).
//   · 「收的钱少过 total 的 30% 不算佣金」, per ORDER: commission is earned on the
//     day the order's payments first reach 30% of its total.
//   · Drafts, held and cancelled orders earn nothing.
//   · Upsales / drop sales: a recorded change of the order's goods
//     (scm.so_total_changes, from go-live — 「9/1到上线前的先不补」). Two changes
//     are not upsales or drops (「可以」): one made on the day the order was
//     opened (a typing / scan fix), and pricing an order that had none
//     (total ≤ RM 1 before). The goods still change; they are simply not listed.
//     (The third — a price wiped to 0 by the system and put back — was a bug
//     fixed 2026-10-07, #4509.)
//
// THE REPORT for a free date range [from, to]:
//   PART 1 — fairs that START in the range: each order's commission AS AT `to`
//     (its goods on that day, earned only if 30% was reached by then).
//   PART 2 — what happened in the range to orders of EARLIER fairs: an order
//     reaching 30% (its goods that day × rate), an upsale / drop after it had
//     reached 30% (± the change × rate), and a cancellation of an order that had
//     earned (− its goods × rate). A change before 30% is folded into the
//     amount earned at 30%.
//   Run month after month, nothing is counted twice: an order's commission sits
//   in its fair's month as at month end; what happens after lands in a later
//   month's Part 2.
//
// TWO BASES (owner 2026-10-20, 「我要两个都看，一个是by fair，一个是by sales
// order 日期」): the same two parts keyed on the ORDER's SO date instead of the
// fair's start — Part 1 the orders opened in the range (grouped by fair), Part 2
// what happened in the range to orders opened before it. Orders with no fair are
// in neither (「不算」).
//
// ONE ROW PER ORDER (owner 2026-10-26, 「一张单改了两次我不理，我看final结果」):
// the earlier orders and the upsales / drop sales are also read per order — its
// Original (before the range's counted changes), Latest (as at `to`) and Amended
// (the difference), at the fair's BRAND rate (「percentage 还要根据不同brand」).
// An order changed only on its opening day is not an upsale or drop, so it is
// not listed. Changes back-filled from the SO's modification history for 1–19
// October (「10月的我也要算」 / 「本身不是有history吗？」) carry source 'history';
// the system's own price wipes and put-backs found there carry 'history-ignored'
// — kept so "goods on a day" stays right, never an upsale or a drop.
//
// ROUND 3 (owner 2026-11-12, 做):
//   · A fair's Total Sales is its orders' goods (「total sales 应该是 by total
//     goods」), and its estimate those goods × the rate; the event page's typed
//     figure stays beside it.
//   · Fairs that start the same day sit together: start, end, venue, organizer,
//     brand (AKEMI and ZANOTTI at Mid Valley side by side).
//   · 补开单 — sold at a fair that had ENDED before the range, keyed in the range
//     (「上个月展会卖、这个月才开单」): `lateBills` names them so the page and the
//     export show their commission on a line of its own.
//   · Two buttons (「1个这张单不要算，1个是这个算下个月」): Finance marks an order
//     `exclude` (it earns nothing, any month) or `defer` (what it earns in a month
//     is paid the month after). `withMarks` takes their commission out of the
//     report — the rows stay, tagged — and lists them; the month after a `defer`
//     receives it as `deferredIn`. The marks live in scm.event_commission_marks.
//   · 「这次改价不算」 (the same day, on the Upsales / Drop sales table: 「只是改价
//     不算」): a third mark, `exclude_change`, on an order and a month. The order's
//     upsales and drop sales of that month move no commission, then or later —
//     it earns on its goods LESS them when it reaches 30%, on its later changes
//     and at a cancellation, so month after month nothing is paid or taken back
//     for them. The changes stay listed: `withUncountedChanges` flags them
//     before the report is built, `withMarks` tags the order's row for its Undo.
// ----------------------------------------------------------------------------

/** Which date puts an order in the range: its fair's start, or its own SO date. */
export type CommissionBasis = 'fair' | 'so_date';

export type CommissionFair = {
  id: number;
  name: string;
  brand: string | null;
  startDate: string;
  endDate: string | null;
  /** The event page's Total Sales (RM) and its Commission row (RM) — the estimate. */
  totalSalesRm: number | null;
  estimateRm: number | null;
  /** The project's own organizer, venue and state — a column each on the page. */
  organizer?: string | null;
  venue?: string | null;
  state?: string | null;
};

export type CommissionSo = {
  docNo: string;
  /** Its fair (project); null when it has none — by SO date such an order is
      listed under "No fair" (owner 2026-11-12). */
  projectId: number | null;
  salesperson: string | null;
  customer: string | null;
  status: string;
  onHold: boolean;
  goodsSen: number;
  totalSen: number;
  createdAt: string;
  /** The order's SO date (YYYY-MM-DD) — the "by SO date" basis. */
  soDate: string | null;
  /** Ref No. — the booklet number typed on the order (customer_so_no). */
  ref?: string | null;
  /** The order's own brand (its branding, else its VP brand): the rate of an
      order with no fair. */
  brand?: string | null;
  /** The venue typed on the order: shown for an order with no fair. */
  venue?: string | null;
};

export type CommissionPayment = { docNo: string; paidAt: string; amountSen: number };
export type CommissionChange = {
  docNo: string; changedAt: string;
  beforeGoodsSen: number; afterGoodsSen: number; beforeTotalSen: number; afterTotalSen: number;
  source: string; changedBy: string | null;
  /** Finance left the order's price changes of this month out (「这次改价不算」) — set by withUncountedChanges. */
  uncounted: boolean;
};
export type CommissionCancel = { docNo: string; at: string };

export type ChangeView = {
  date: string;
  deltaGoodsSen: number;
  kind: 'upsale' | 'drop';
  /** Why it is not an upsale / drop; null when it is one. */
  notCounted: 'opening_day' | 'first_price' | 'system_fix' | null;
  /** An upsale / drop Finance left out (「这次改价不算」): listed, and moves no commission. */
  uncounted: boolean;
  source: string;
  changedBy: string | null;
  /** Back-filled from the SO's modification history (1 September – 19 October 2026). */
  fromHistory: boolean;
};

/* ── Finance's buttons ─────────────────────────────────────────────────────── */

/** A mark Finance put on an order (scm.event_commission_marks). */
export type CommissionMark = {
  id: string;
  docNo: string;
  /** 'exclude' — 「这张单不要算」; 'defer' — 「这个算下个月」; 'exclude_change' — 「这次改价不算」. */
  kind: 'exclude' | 'defer' | 'exclude_change';
  /** defer: the month (YYYY-MM) whose commission moves to the month after;
      exclude_change: the month whose upsales / drop sales are left out; exclude: null. */
  month: string | null;
  reason: string | null;
  markedBy: string | null;
  markedAt: string;
};

/** The mark on a row, for its tag and its Undo. */
export type MarkInfo = Pick<CommissionMark, 'id' | 'kind' | 'month' | 'reason' | 'markedBy' | 'markedAt'>;

export type SoRow = {
  docNo: string;
  soDate: string | null;
  /** Ref No. (the booklet number) and the order's status. */
  ref: string | null;
  status: string;
  salesperson: string | null;
  customer: string | null;
  /** When the order was keyed — a 补开单 is keyed after its fair ended. */
  createdAt: string;
  /** Set when Finance marked it; its commission is then 0 here. */
  mark?: MarkInfo;
  goodsSen: number;
  totalSen: number;
  paidSen: number;
  paidPct: number;
  /** The day payments reached 30% of the total, on or before `to`. */
  reachedOn: string | null;
  commissionSen: number;
  /** What 「这次改价不算」 left out of the commission here; absent when nothing. */
  uncountedSen?: number;
  /** The venue typed on an order with no fair (its fair row is "No fair"). */
  venue?: string | null;
  changes: ChangeView[];
};

export type FairRow = {
  id: number;
  name: string;
  brand: string | null;
  organizer: string | null;
  venue: string | null;
  state: string | null;
  startDate: string;
  endDate: string | null;
  ratePct: number | null;
  /** The event page's typed Total Sales and its Commission row (RM). */
  totalSalesRm: number | null;
  estimateRm: number | null;
  /** Its orders' goods as at `to` (every order that is not a draft, held or
      cancelled) — the fair's Total Sales on this page — and those × the rate. */
  goodsSen: number;
  estimateSen: number;
  payableSen: number;
  sos: SoRow[];
};

export type AdjustmentRow = {
  date: string;
  kind: 'reached' | 'upsale' | 'drop' | 'cancelled';
  docNo: string;
  fairId: number;
  fairName: string;
  salesperson: string | null;
  /** Goods the line is about: the order's goods (reached / cancelled) or the change. */
  goodsSen: number;
  commissionSen: number;
  /** An upsale / drop before the order reached 30% moves no commission yet. */
  beforeReach: boolean;
  /** An upsale / drop Finance left out (「这次改价不算」): the line stays, earning nothing. */
  uncounted?: true;
  /** What 「这次改价不算」 left out of this line's commission; absent when nothing. */
  uncountedSen?: number;
};

/** Where an order sits on the page: its fair, and that fair's place. */
export type OrderPlace = {
  docNo: string; fairId: number; fairName: string;
  brand: string | null; organizer: string | null; venue: string | null; state: string | null;
  salesperson: string | null; customer: string | null; ratePct: number | null;
  /** Ref No., SO date and status — more of the order in the tables' Columns. */
  ref: string | null; soDate: string | null; status: string;
};

/** An earlier order, once, with what happened to it in the range. */
export type EarlierOrderRow = OrderPlace & {
  mark?: MarkInfo;
  events: Array<{ date: string; kind: AdjustmentRow['kind']; beforeReach: boolean; uncounted?: true }>;
  lastDate: string;
  /** Goods before the range's counted changes, as at `to`, and the difference. */
  originalSen: number; latestSen: number; amendedSen: number;
  /** The order's commission lines in the range, summed. */
  commissionSen: number;
  fromHistory: boolean;
};

/** An order whose goods the range changed (upsales / drop sales), once, final. */
export type ChangedOrderRow = OrderPlace & {
  mark?: MarkInfo;
  /** The 「这次改价不算」 mark behind the changes left out, for the row's Undo. */
  changeMark?: MarkInfo;
  /** 'range' — this range's fairs (the effect is inside their commission);
      'earlier' — an earlier order (inside the earlier lines). */
  part: 'range' | 'earlier';
  lastChange: string;
  originalSen: number; latestSen: number; amendedSen: number;
  /** The goods of the range's changes Finance left out: in Amended, not in the effect. Absent when none. */
  uncountedGoodsSen?: number;
  reachedOn: string | null;
  /** (Amended less the goods left out) × the brand rate once the order has reached 30% by `to`, else 0. */
  effectSen: number;
  fromHistory: boolean;
};

export type EventCommissionReport = {
  basis: CommissionBasis;
  from: string;
  to: string;
  fairs: FairRow[];
  adjustments: AdjustmentRow[];
  earlierOrders: EarlierOrderRow[];
  changedOrders: ChangedOrderRow[];
  /** Closed months' commission that changed after they closed, paid here (「X 月调整」). */
  monthAdjustments: MonthAdjustmentRow[];
  /** 补开单: orders keyed in the range for a fair that had ended before it. */
  lateBills: string[];
  /** The orders Finance marked that are on this report, with what each mark took out. */
  marked: MarkedOrderRow[];
  /** What the month before moved here (「这个算下个月」); empty unless the range is one month. */
  deferredIn: DeferredInRow[];
  totals: { payableSen: number; adjustmentsSen: number; monthAdjustmentsSen: number; deferredInSen: number; totalSen: number };
};

/** An order Finance marked, with the commission the mark took out of this report. */
export type MarkedOrderRow = OrderPlace & {
  mark: MarkInfo;
  /** What the order would have earned here — not paid here. */
  commissionSen: number;
};

/** An order whose commission the month before moved here. */
export type DeferredInRow = OrderPlace & {
  /** The month it came from, YYYY-MM. */
  fromMonth: string;
  mark: MarkInfo;
  commissionSen: number;
  /** Set when it is marked again here (moved on, or not counted); 0 is paid then. */
  markedAgain?: MarkInfo;
};

/* ── Closing a month (owner 2026-10-26: 关月, Finance) ────────────────────────
   A closed month never changes: the page shows it as it was closed. What later
   moves its orders' commission — a payment dated back into it, a payment
   deleted, an order moved to another fair, an order put on hold — is that month
   recalculated today minus what it paid, and is paid in the first open month as
   that month's adjustment. Nothing here reads the database; the route stores
   and reads the closes. */

/** A closed month's commission for one order, then and now. */
export type MonthAdjustmentRow = {
  /** The closed month it belongs to, YYYY-MM. */
  month: string;
  docNo: string;
  fairId: number | null;
  fairName: string;
  brand: string | null;
  salesperson: string | null;
  customer: string | null;
  /** Ref No. (the booklet number), SO date and status, as on the order tables
      (owner 2026-11-12: 「这个没有reference no. 吗？」). Absent on rows made before. */
  ref?: string | null;
  soDate?: string | null;
  status?: string;
  /** What that month paid for the order: as closed, plus the adjustments paid since. */
  wasSen: number;
  /** That month recalculated today. */
  nowSen: number;
  adjustmentSen: number;
};

/** A closed month as the adjustments need it: what it paid each order, and the
 *  adjustments for earlier closed months it carried when it closed. */
export type ClosedMonthPaid = {
  month: string;
  paid: Record<string, number>;
  carried: Array<{ month: string; docNo: string; sen: number }>;
};

/** What a month's report pays each order: its fair commission, its earlier
 *  lines and what the month before moved here. The adjustments for closed
 *  months it carries are not the month's own. */
export function paidByOrder(r: Pick<EventCommissionReport, 'fairs' | 'adjustments'> & { deferredIn?: readonly DeferredInRow[] }): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (doc: string, sen: number) => { if (sen !== 0) out[doc] = (out[doc] ?? 0) + sen; };
  for (const f of r.fairs) for (const so of f.sos) add(so.docNo, so.commissionSen);
  for (const a of r.adjustments) add(a.docNo, a.commissionSen);
  for (const d of r.deferredIn ?? []) add(d.docNo, d.commissionSen);
  return out;
}

const totalsOf = (t: Omit<EventCommissionReport['totals'], 'totalSen'>): EventCommissionReport['totals'] => ({
  ...t, totalSen: t.payableSen + t.adjustmentsSen + t.monthAdjustmentsSen + t.deferredInSen,
});

/** Each closed month's commission per order, recalculated today (`live`, by
 *  month), against what it paid — as closed plus what later months carried for
 *  it. Only the orders that moved. */
export function monthAdjustmentsOf(closed: readonly ClosedMonthPaid[], live: ReadonlyMap<string, EventCommissionReport>): MonthAdjustmentRow[] {
  const rows: MonthAdjustmentRow[] = [];
  for (const k of closed) {
    const now = live.get(k.month);
    if (!now) continue;
    const was: Record<string, number> = { ...k.paid };
    for (const m of closed) {
      if (m.month <= k.month) continue;
      for (const c of m.carried) if (c.month === k.month) was[c.docNo] = (was[c.docNo] ?? 0) + c.sen;
    }
    const nowPaid = paidByOrder(now);
    const where = new Map<string, Omit<MonthAdjustmentRow, 'month' | 'docNo' | 'wasSen' | 'nowSen' | 'adjustmentSen'>>();
    for (const f of now.fairs) for (const so of f.sos) {
      where.set(so.docNo, { fairId: f.id, fairName: f.name, brand: f.brand, salesperson: so.salesperson, customer: so.customer, ref: so.ref, soDate: so.soDate, status: so.status });
    }
    for (const o of now.earlierOrders) {
      if (!where.has(o.docNo)) where.set(o.docNo, { fairId: o.fairId, fairName: o.fairName, brand: o.brand, salesperson: o.salesperson, customer: o.customer, ref: o.ref, soDate: o.soDate, status: o.status });
    }
    for (const doc of new Set([...Object.keys(was), ...Object.keys(nowPaid)])) {
      const w = was[doc] ?? 0;
      const n = nowPaid[doc] ?? 0;
      if (w === n) continue;
      const at = where.get(doc) ?? { fairId: null, fairName: '', brand: null, salesperson: null, customer: null, ref: null, soDate: null };
      rows.push({ month: k.month, docNo: doc, ...at, wasSen: w, nowSen: n, adjustmentSen: n - w });
    }
  }
  return rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.docNo < b.docNo ? -1 : 1));
}

/** The report with the closed months' adjustments added to it and its total. */
export function withMonthAdjustments(r: EventCommissionReport, rows: MonthAdjustmentRow[]): EventCommissionReport {
  const monthAdjustmentsSen = rows.reduce((s, a) => s + a.adjustmentSen, 0);
  return { ...r, monthAdjustments: rows, totals: totalsOf({ ...r.totals, monthAdjustmentsSen }) };
}

/** The month (YYYY-MM) a report is OF, for Finance's marks: it starts on the
 *  1st and ends inside that month — the whole month, or this month so far.
 *  Null for any other range. */
export function monthOfRange(from: string, to: string): string | null {
  if (!/^\d{4}-\d{2}-01$/.test(from) || to < from) return null;
  return to.slice(0, 7) === from.slice(0, 7) ? from.slice(0, 7) : null;
}

/** Just the place fields of a row that carries more. */
const asPlace = (o: OrderPlace): OrderPlace => ({
  docNo: o.docNo, fairId: o.fairId, fairName: o.fairName, brand: o.brand, organizer: o.organizer, venue: o.venue, state: o.state,
  salesperson: o.salesperson, customer: o.customer, ratePct: o.ratePct, ref: o.ref ?? null, soDate: o.soDate ?? null, status: o.status ?? '',
});

/** Where every order on a report sits — its fair and its own details. */
function placesOf(r: Pick<EventCommissionReport, 'fairs' | 'earlierOrders' | 'changedOrders'>): Map<string, OrderPlace> {
  const out = new Map<string, OrderPlace>();
  for (const f of r.fairs) {
    for (const s of f.sos) {
      out.set(s.docNo, {
        docNo: s.docNo, fairId: f.id, fairName: f.name, brand: f.brand, organizer: f.organizer, venue: f.venue, state: f.state,
        salesperson: s.salesperson, customer: s.customer, ratePct: f.ratePct, ref: s.ref ?? null, soDate: s.soDate, status: s.status ?? '',
      });
    }
  }
  for (const o of [...r.earlierOrders, ...r.changedOrders]) if (!out.has(o.docNo)) out.set(o.docNo, asPlace(o));
  return out;
}

const infoOf = (m: CommissionMark): MarkInfo => ({ id: m.id, kind: m.kind, month: m.month, reason: m.reason, markedBy: m.markedBy, markedAt: m.markedAt });

/**
 * Finance's marks applied to a report (owner 2026-11-12). An order marked
 * `exclude`, or marked `defer` for the month this report is, earns nothing here:
 * its fair commission, its earlier lines, its upsale / drop effect and what the
 * month before moved here are set to 0, its rows stay on the page tagged, and it
 * is listed in `marked` with the amount the mark took out. `deferredIn` is what
 * the month before moved here. A `defer` acts only on a report of one month (or
 * of it so far — monthOfRange).
 * Closed months' adjustments are left alone: a month recalculated with an
 * `exclude` drops the order there, and the adjustment takes it back.
 * An `exclude_change` is already IN the report (withUncountedChanges, before it
 * was built): here the changed order's row gets the mark for its Undo, and the
 * mark is listed with what it left out — the order itself still earns.
 */
export function withMarks(r: EventCommissionReport, marks: readonly CommissionMark[], deferredIn: readonly DeferredInRow[] = []): EventCommissionReport {
  const month = monthOfRange(r.from, r.to);
  const markOf = new Map<string, CommissionMark>();
  for (const m of marks) if (m.kind === 'defer' && month != null && m.month === month) markOf.set(m.docNo, m);
  for (const m of marks) if (m.kind === 'exclude') markOf.set(m.docNo, m); // not counting at all wins
  const places = placesOf(r);
  const taken = new Map<string, number>();
  const take = (doc: string, sen: number) => { if (sen !== 0) taken.set(doc, (taken.get(doc) ?? 0) + sen); };

  /* 「这次改价不算」: per order, its latest such mark up to the range's last month,
     and what the changes left out took off its commission on this report. */
  const changeMarkOf = new Map<string, CommissionMark>();
  for (const m of marks) {
    if (m.kind !== 'exclude_change' || m.month == null || m.month > r.to.slice(0, 7)) continue;
    const seen = changeMarkOf.get(m.docNo);
    if (!seen || (seen.month ?? '') < m.month) changeMarkOf.set(m.docNo, m);
  }
  const leftOut = new Map<string, number>();
  const leave = (doc: string, sen: number | undefined) => { if (sen) leftOut.set(doc, (leftOut.get(doc) ?? 0) + sen); };
  for (const f of r.fairs) for (const s of f.sos) leave(s.docNo, s.uncountedSen);
  for (const a of r.adjustments) leave(a.docNo, a.uncountedSen);

  const fairs = r.fairs.map((f) => {
    const sos = f.sos.map((s) => {
      const m = markOf.get(s.docNo);
      if (!m) return s;
      take(s.docNo, s.commissionSen);
      return { ...s, commissionSen: 0, mark: infoOf(m) };
    });
    return { ...f, sos, payableSen: sos.reduce((t, s) => t + s.commissionSen, 0) };
  });
  const adjustments = r.adjustments.map((a) => {
    if (!markOf.has(a.docNo)) return a;
    take(a.docNo, a.commissionSen);
    return { ...a, commissionSen: 0 };
  });
  const earlierOrders = r.earlierOrders.map((o) => {
    const m = markOf.get(o.docNo);
    return m ? { ...o, commissionSen: 0, mark: infoOf(m) } : o;
  });
  const changedOrders = r.changedOrders.map((o) => {
    const change = o.uncountedGoodsSen ? changeMarkOf.get(o.docNo) : undefined;
    const row = change ? { ...o, changeMark: infoOf(change) } : o;
    const m = markOf.get(o.docNo);
    return m ? { ...row, effectSen: 0, mark: infoOf(m) } : row;
  });
  const din = deferredIn.map((d) => {
    const m = markOf.get(d.docNo);
    if (!m) return d;
    take(d.docNo, d.commissionSen);
    return { ...d, commissionSen: 0, markedAgain: infoOf(m) };
  });
  for (const d of din) if (!places.has(d.docNo)) places.set(d.docNo, asPlace(d));

  const changeDocs = new Set([...leftOut.keys(), ...r.changedOrders.filter((o) => o.uncountedGoodsSen).map((o) => o.docNo)]);
  const changeRank = (m: MarkedOrderRow) => (m.mark.kind === 'exclude_change' ? 1 : 0);
  const marked: MarkedOrderRow[] = [
    ...[...markOf.values()]
      .filter((m) => places.has(m.docNo))
      .map((m) => ({ ...places.get(m.docNo)!, mark: infoOf(m), commissionSen: taken.get(m.docNo) ?? 0 })),
    ...[...changeDocs]
      .filter((doc) => changeMarkOf.has(doc) && places.has(doc))
      .map((doc) => ({ ...places.get(doc)!, mark: infoOf(changeMarkOf.get(doc)!), commissionSen: leftOut.get(doc) ?? 0 })),
  ].sort((a, b) => (a.docNo < b.docNo ? -1 : a.docNo > b.docNo ? 1 : changeRank(a) - changeRank(b)));
  return {
    ...r, fairs, adjustments, earlierOrders, changedOrders, deferredIn: din, marked,
    totals: totalsOf({
      payableSen: fairs.reduce((t, f) => t + f.payableSen, 0),
      adjustmentsSen: adjustments.reduce((t, a) => t + a.commissionSen, 0),
      monthAdjustmentsSen: r.totals.monthAdjustmentsSen ?? 0,
      deferredInSen: din.reduce((t, d) => t + d.commissionSen, 0),
    }),
  };
}

/** The changes with Finance's 「这次改价不算」 on them: a change of a marked order
 *  made in the month the mark names (its Malaysian day) is flagged uncounted,
 *  every other is not. The report is built from these. */
export function withUncountedChanges(changes: readonly CommissionChange[], marks: readonly CommissionMark[]): CommissionChange[] {
  const off = new Set<string>();
  for (const m of marks) if (m.kind === 'exclude_change' && m.month) off.add(`${m.docNo}|${m.month}`);
  return changes.map((ch) => ({ ...ch, uncounted: off.has(`${ch.docNo}|${mytDay(ch.changedAt).slice(0, 7)}`) }));
}

/** What a month's report moved to the month after: its `defer` marks for that
 *  month, each with the amount it took out. Nothing when none (or a report
 *  closed before marks existed). */
export function deferredInFrom(prev: { marked?: readonly MarkedOrderRow[] }, fromMonth: string): DeferredInRow[] {
  return (prev.marked ?? [])
    .filter((m) => m.mark.kind === 'defer' && m.mark.month === fromMonth && m.commissionSen !== 0)
    .map(({ mark, commissionSen, ...place }) => ({ ...place, fromMonth, mark, commissionSen }));
}

/** Fairs in the order the page lists them: start, end, venue, organizer,
 *  brand — so AKEMI and ZANOTTI at the same place and dates sit together. */
export function fairOrder(a: Pick<CommissionFair, 'startDate' | 'endDate' | 'venue' | 'organizer' | 'brand' | 'name'>, b: typeof a): number {
  const keys = (f: typeof a) => [f.startDate ?? '', f.endDate ?? '', (f.venue ?? '').toUpperCase(), (f.organizer ?? '').toUpperCase(), (f.brand ?? '').toUpperCase(), f.name];
  const ka = keys(a);
  const kb = keys(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i]! < kb[i]!) return -1;
    if (ka[i]! > kb[i]!) return 1;
  }
  return 0;
}

export const COMMISSION_PAID_SHARE = 0.3;
/* By SO date, every order opened in the range is listed (owner 2026-11-12:
   「全部列出来，没有展会的标 No fair，要算佣金，然后我检查了不要算的我才自己按
   don't count」): one with no fair sits under a "No fair" row of its own brand,
   at that brand's rate, from the first month the system works out (September
   2026) — the old orders before it, many of them showroom sales, stay out. */
export const NO_FAIR_NAME = 'No fair';
export const NO_FAIR_FROM = '2026-09-01';
/** so_total_changes.source of the rows back-filled from the modification history. */
export const HISTORY = 'history';
export const HISTORY_IGNORED = 'history-ignored';
const FIRST_PRICE_MAX_SEN = 100;

/** The calendar day in Malaysia of a stamp (a bare date passes through). */
export function mytDay(stamp: string): string {
  const s = String(stamp);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return s.slice(0, 10);
  return new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
}

const commissionOf = (goodsSen: number, ratePct: number | null): number =>
  ratePct == null ? 0 : Math.round((goodsSen * ratePct) / 100);

/** The first day the order's payments (up to `upTo`, if given) reach 30% of its total. */
export function reachedOn(totalSen: number, payments: readonly CommissionPayment[], upTo?: string): string | null {
  if (!(totalSen > 0)) return null;
  const need = totalSen * COMMISSION_PAID_SHARE;
  const sorted = payments
    .map((p) => ({ day: mytDay(p.paidAt), amount: Number(p.amountSen) || 0 }))
    .filter((p) => upTo == null || p.day <= upTo)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let paid = 0;
  for (const p of sorted) {
    paid += p.amount;
    if (paid >= need) return p.day;
  }
  return null;
}

/** The order's goods at the END of `day`: today's goods less every change after it. */
export function goodsAt(goodsNowSen: number, changes: readonly CommissionChange[], day: string): number {
  let g = goodsNowSen;
  for (const ch of changes) if (mytDay(ch.changedAt) > day) g -= ch.afterGoodsSen - ch.beforeGoodsSen;
  return g;
}

export function changeView(ch: CommissionChange, so: Pick<CommissionSo, 'createdAt'>): ChangeView | null {
  const delta = ch.afterGoodsSen - ch.beforeGoodsSen;
  if (delta === 0) return null; // the total moved (a fee), not the goods
  const date = mytDay(ch.changedAt);
  const notCounted = ch.source === HISTORY_IGNORED ? 'system_fix'
    : date === mytDay(so.createdAt) ? 'opening_day'
    : ch.beforeTotalSen <= FIRST_PRICE_MAX_SEN ? 'first_price'
    : null;
  return {
    date, deltaGoodsSen: delta, kind: delta > 0 ? 'upsale' : 'drop', notCounted,
    /* Only an upsale / drop can be left out: a fix that is neither keeps its goods. */
    uncounted: notCounted == null && ch.uncounted === true,
    source: ch.source, changedBy: ch.changedBy,
    fromHistory: ch.source === HISTORY || ch.source === HISTORY_IGNORED,
  };
}

export function buildEventCommission(input: {
  from: string;
  to: string;
  fairs: readonly CommissionFair[];
  ratePctByBrand: ReadonlyMap<string, number | null>;
  sos: readonly CommissionSo[];
  payments: readonly CommissionPayment[];
  changes: readonly CommissionChange[];
  cancels: readonly CommissionCancel[];
  basis?: CommissionBasis;
}): EventCommissionReport {
  const { from, to } = input;
  const basis: CommissionBasis = input.basis ?? 'fair';
  const byDoc = <T extends { docNo: string }>(rows: readonly T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) { const a = m.get(r.docNo); if (a) a.push(r); else m.set(r.docNo, [r]); }
    return m;
  };
  const paymentsOf = byDoc(input.payments);
  const changesOf = byDoc(input.changes);
  const cancelOf = new Map<string, string>();
  for (const c of input.cancels) {
    const day = mytDay(c.at);
    const prev = cancelOf.get(c.docNo);
    if (!prev || day > prev) cancelOf.set(c.docNo, day);
  }
  const rateOf = (f: CommissionFair): number | null => input.ratePctByBrand.get((f.brand ?? '').trim()) ?? null;
  const fairById = new Map(input.fairs.map((f) => [f.id, f]));
  /* By SO date, an order with no fair opened from NO_FAIR_FROM goes under a
     "No fair" row of its own brand (the rate card's spelling of it, any case),
     at that brand's rate. Rows numbered -1, -2 … by brand, so a report reads the
     same each time. */
  const cardOf = (brand: string | null | undefined): string | null => {
    const b = (brand ?? '').trim();
    if (!b) return null;
    if (input.ratePctByBrand.has(b)) return b;
    return [...input.ratePctByBrand.keys()].find((k) => k.trim().toUpperCase() === b.toUpperCase()) ?? b;
  };
  const noFair = (so: CommissionSo): boolean => basis === 'so_date' && so.projectId == null && so.soDate != null && so.soDate >= NO_FAIR_FROM;
  const noFairBrands = [...new Set(input.sos.filter(noFair).map((so) => cardOf(so.brand) ?? ''))].sort();
  const noFairId = new Map(noFairBrands.map((b, i) => [b, -(i + 1)]));
  for (const [b, id] of noFairId) {
    fairById.set(id, {
      id, name: NO_FAIR_NAME, brand: b || null, startDate: '', endDate: null, totalSalesRm: null, estimateRm: null,
      organizer: null, venue: null, state: null,
    });
  }
  const sosIn: CommissionSo[] = input.sos.map((so) => (noFair(so) ? { ...so, projectId: noFairId.get(cardOf(so.brand) ?? '')! } : so));
  const placeOf = (so: CommissionSo, f: CommissionFair): OrderPlace => ({
    docNo: so.docNo, fairId: f.id, fairName: f.name,
    brand: f.brand, organizer: f.organizer ?? null, venue: f.id < 0 ? (so.venue ?? null) : (f.venue ?? null), state: f.state ?? null,
    salesperson: so.salesperson, customer: so.customer, ratePct: rateOf(f),
    ref: so.ref ?? null, soDate: so.soDate, status: so.status,
  });
  /* An order's goods at the end of `day` — or, for a day before it was keyed (a
     payment dated before the order, an order keyed after the range: HC-SO-2611-050
     was keyed on 3/11 at RM 4,000 and put right to RM 800 the same day, against
     payments of 14–16/10), at the end of the day it was keyed: that day's own
     corrections are the order as it was sold, not a change to walk back. */
  const goodsOn = (so: CommissionSo, chs: readonly CommissionChange[], day: string): number => {
    const keyed = mytDay(so.createdAt);
    return goodsAt(so.goodsSen, chs, day < keyed ? keyed : day);
  };
  /* The range's counted changes of an order (before `until`, when it was cancelled). */
  const countedIn = (so: CommissionSo, chs: readonly CommissionChange[], until: string | null = null): ChangeView[] =>
    chs.map((ch) => changeView(ch, so))
      .filter((v): v is ChangeView => v != null && v.notCounted == null && v.date >= from && v.date <= to && (until == null || v.date < until));
  /* 「这次改价不算」: the goods of the order's changes Finance left out, up to the
     end of `day`. What the order earns on is its goods less these. */
  const uncountedGoods = (so: CommissionSo, chs: readonly CommissionChange[], day: string): number =>
    chs.reduce((g, ch) => {
      const v = changeView(ch, so);
      return v != null && v.uncounted && v.date <= day ? g + v.deltaGoodsSen : g;
    }, 0);
  /* The commission on `goods` with `off` of them left out, and what that left out. */
  const earnedOn = (goods: number, off: number, rate: number | null): { commissionSen: number; uncountedSen?: number } => {
    const commissionSen = commissionOf(goods - off, rate);
    const left = commissionOf(goods, rate) - commissionSen;
    return left === 0 ? { commissionSen } : { commissionSen, uncountedSen: left };
  };
  const changedOrders: ChangedOrderRow[] = [];
  /* An order whose goods the range changed, once: Original before the counted
     changes, Latest as at `to`. Nothing to list when they cancel out. */
  const noteChanged = (so: CommissionSo, f: CommissionFair, part: ChangedOrderRow['part']) => {
    const chs = changesOf.get(so.docNo) ?? [];
    const counted = countedIn(so, chs);
    if (counted.length === 0) return;
    const amended = counted.reduce((s, v) => s + v.deltaGoodsSen, 0);
    if (amended === 0) return;
    const latest = goodsOn(so, chs, to);
    const reached = reachedOn(so.totalSen, paymentsOf.get(so.docNo) ?? [], to);
    const place = placeOf(so, f);
    const off = counted.reduce((s, v) => (v.uncounted ? s + v.deltaGoodsSen : s), 0);
    changedOrders.push({
      ...place, part,
      lastChange: counted.reduce((m, v) => (v.date > m ? v.date : m), counted[0]!.date),
      originalSen: latest - amended, latestSen: latest, amendedSen: amended, reachedOn: reached,
      ...(off !== 0 ? { uncountedGoodsSen: off } : {}),
      effectSen: reached ? commissionOf(amended - off, place.ratePct) : 0,
      fromHistory: counted.some((v) => v.fromHistory),
    });
  };

  /* One order as at `to`: its goods that day, earned only if 30% was paid by then.
     Null when it earns nothing at all (draft, held, cancelled by `to`). */
  const soRowAsAt = (so: CommissionSo, rate: number | null): SoRow | null => {
    if (so.onHold || so.status === 'DRAFT' || so.status === 'ON_HOLD') return null;
    const cancelled = cancelOf.get(so.docNo);
    if (so.status === 'CANCELLED' && (!cancelled || cancelled <= to)) return null;
    const pays = paymentsOf.get(so.docNo) ?? [];
    const chs = changesOf.get(so.docNo) ?? [];
    const goods = goodsOn(so, chs, to);
    const paid = pays.filter((p) => mytDay(p.paidAt) <= to).reduce((s, p) => s + (Number(p.amountSen) || 0), 0);
    const reached = reachedOn(so.totalSen, pays, to);
    return {
      docNo: so.docNo,
      soDate: so.soDate,
      ref: so.ref ?? null,
      status: so.status,
      salesperson: so.salesperson,
      customer: so.customer,
      createdAt: so.createdAt,
      goodsSen: goods,
      totalSen: so.totalSen,
      paidSen: paid,
      paidPct: so.totalSen > 0 ? Math.round((paid / so.totalSen) * 1000) / 10 : 0,
      reachedOn: reached,
      ...(reached ? earnedOn(goods, uncountedGoods(so, chs, to), rate) : { commissionSen: 0 }),
      ...(so.projectId != null && so.projectId < 0 ? { venue: so.venue ?? null } : {}),
      changes: chs.filter((ch) => mytDay(ch.changedAt) <= to).map((ch) => changeView(ch, so)).filter((v): v is ChangeView => v != null),
    };
  };
  const fairRowOf = (f: CommissionFair, members: readonly CommissionSo[]): FairRow => {
    const rate = rateOf(f);
    const sos = members.map((so) => soRowAsAt(so, rate)).filter((r): r is SoRow => r != null)
      .sort((a, b) => (a.docNo < b.docNo ? -1 : 1));
    for (const so of members) if (sos.some((r) => r.docNo === so.docNo)) noteChanged(so, f, 'range');
    const goodsSen = sos.reduce((s, r) => s + r.goodsSen, 0);
    return {
      id: f.id, name: f.name, brand: f.brand, organizer: f.organizer ?? null, venue: f.venue ?? null, state: f.state ?? null,
      startDate: f.startDate, endDate: f.endDate,
      ratePct: rate, totalSalesRm: f.totalSalesRm, estimateRm: f.estimateRm,
      goodsSen, estimateSen: commissionOf(goodsSen, rate),
      payableSen: sos.reduce((s, r) => s + r.commissionSen, 0),
      sos,
    };
  };
  const inRange = (day: string | null): boolean => day != null && day >= from && day <= to;

  /* PART 1 — by fair: the fairs starting in the range, all their orders.
     By SO date: the orders opened in the range, grouped under their fairs. */
  const fairs: FairRow[] = [];
  if (basis === 'fair') {
    for (const f of input.fairs.filter((x) => inRange(x.startDate)).sort(fairOrder)) {
      fairs.push(fairRowOf(f, sosIn.filter((s) => s.projectId === f.id)));
    }
  } else {
    const opened = new Map<number, CommissionSo[]>();
    for (const so of sosIn) {
      if (so.projectId == null || !inRange(so.soDate) || !fairById.has(so.projectId)) continue;
      const list = opened.get(so.projectId);
      if (list) list.push(so); else opened.set(so.projectId, [so]);
    }
    const ordered = [...opened.keys()].map((id) => fairById.get(id)!).sort(fairOrder);
    for (const f of ordered) fairs.push(fairRowOf(f, opened.get(f.id)!));
  }

  /* PART 2 — in the range, on orders of fairs that started before it (by fair),
     or on orders opened before it (by SO date). */
  const earlier = (so: CommissionSo, f: CommissionFair): boolean =>
    basis === 'fair' ? f.startDate < from : so.soDate != null && so.soDate < from;
  const adjustments: AdjustmentRow[] = [];
  const earlierOrders: EarlierOrderRow[] = [];
  for (const so of sosIn) {
    const f = so.projectId == null ? undefined : fairById.get(so.projectId);
    if (!f || !earlier(so, f)) continue;
    const firstLine = adjustments.length;
    if (so.status === 'DRAFT' || so.onHold || so.status === 'ON_HOLD') continue;
    const rate = rateOf(f);
    const pays = paymentsOf.get(so.docNo) ?? [];
    const chs = changesOf.get(so.docNo) ?? [];
    /* A cancellation counts only while the order IS cancelled — one re-opened
       since is live again. */
    const cancelled = so.status === 'CANCELLED' ? cancelOf.get(so.docNo) ?? null : null;
    if (so.status === 'CANCELLED' && cancelled == null) continue; // cancelled, day unknown: never earned here
    const reached = reachedOn(so.totalSen, pays);
    const earned = reached != null && (cancelled == null || reached < cancelled);
    const base = { docNo: so.docNo, fairId: f.id, fairName: f.name, salesperson: so.salesperson };
    if (earned && reached! >= from && reached! <= to) {
      const goods = goodsOn(so, chs, reached!);
      adjustments.push({ ...base, date: reached!, kind: 'reached', goodsSen: goods, ...earnedOn(goods, uncountedGoods(so, chs, reached!), rate), beforeReach: false });
    }
    for (const ch of chs) {
      const v = changeView(ch, so);
      if (!v || v.notCounted || v.date < from || v.date > to) continue;
      if (cancelled != null && v.date >= cancelled) continue;
      if (reached != null && v.date === reached) continue; // folded into the amount earned that day
      const after = earned && reached! < v.date;
      const moves = after ? commissionOf(v.deltaGoodsSen, rate) : 0;
      adjustments.push({
        ...base, date: v.date, kind: v.kind, goodsSen: v.deltaGoodsSen,
        commissionSen: v.uncounted ? 0 : moves,
        beforeReach: !after,
        ...(v.uncounted ? { uncounted: true as const, ...(moves !== 0 ? { uncountedSen: moves } : {}) } : {}),
      });
    }
    if (earned && cancelled != null && cancelled >= from && cancelled <= to) {
      /* Taken back: what it earned — its goods less the changes left out. */
      const goods = goodsOn(so, chs, cancelled);
      const had = earnedOn(goods, uncountedGoods(so, chs, cancelled), rate);
      adjustments.push({
        ...base, date: cancelled, kind: 'cancelled', goodsSen: goods, commissionSen: -had.commissionSen, beforeReach: false,
        ...(had.uncountedSen ? { uncountedSen: -had.uncountedSen } : {}),
      });
    }
    /* The same order once, its final result in the range. */
    const mine = adjustments.slice(firstLine);
    if (mine.length > 0) {
      const counted = countedIn(so, chs, cancelled);
      const amended = counted.reduce((s, v) => s + v.deltaGoodsSen, 0);
      const latest = goodsOn(so, chs, to);
      earlierOrders.push({
        ...placeOf(so, f),
        events: mine.map((a) => ({ date: a.date, kind: a.kind, beforeReach: a.beforeReach, ...(a.uncounted ? { uncounted: true as const } : {}) })),
        lastDate: mine.reduce((m, a) => (a.date > m ? a.date : m), mine[0]!.date),
        originalSen: latest - amended, latestSen: latest, amendedSen: amended,
        commissionSen: mine.reduce((s, a) => s + a.commissionSen, 0),
        fromHistory: counted.some((v) => v.fromHistory),
      });
    }
    if (cancelled == null || cancelled > to) noteChanged(so, f, 'earlier');
  }
  const byDateThenDoc = <R extends { docNo: string }>(day: (r: R) => string) => (a: R, b: R) =>
    (day(a) < day(b) ? -1 : day(a) > day(b) ? 1 : a.docNo < b.docNo ? -1 : 1);
  adjustments.sort(byDateThenDoc((a) => a.date));
  earlierOrders.sort(byDateThenDoc((r) => r.lastDate));
  changedOrders.sort(byDateThenDoc((r) => r.lastChange));

  /* 补开单 (owner 2026-11-12, 「上个月展会卖、这个月才开单」): keyed in the range
     for a fair that had ended before it. */
  const lateBills = sosIn
    .filter((so) => {
      const f = so.projectId == null ? undefined : fairById.get(so.projectId);
      const ended = f ? (f.endDate || f.startDate) : '';
      return f != null && ended !== '' && ended < from && inRange(mytDay(so.createdAt));
    })
    .map((so) => so.docNo)
    .sort();

  const payableSen = fairs.reduce((s, f) => s + f.payableSen, 0);
  const adjustmentsSen = adjustments.reduce((s, a) => s + a.commissionSen, 0);
  return {
    basis, from, to, fairs, adjustments, earlierOrders, changedOrders, monthAdjustments: [], lateBills, marked: [], deferredIn: [],
    totals: totalsOf({ payableSen, adjustmentsSen, monthAdjustmentsSen: 0, deferredInSen: 0 }),
  };
}
