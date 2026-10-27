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
  projectId: number;
  salesperson: string | null;
  customer: string | null;
  status: string;
  onHold: boolean;
  goodsSen: number;
  totalSen: number;
  createdAt: string;
  /** The order's SO date (YYYY-MM-DD) — the "by SO date" basis. */
  soDate: string | null;
};

export type CommissionPayment = { docNo: string; paidAt: string; amountSen: number };
export type CommissionChange = {
  docNo: string; changedAt: string;
  beforeGoodsSen: number; afterGoodsSen: number; beforeTotalSen: number; afterTotalSen: number;
  source: string; changedBy: string | null;
};
export type CommissionCancel = { docNo: string; at: string };

export type ChangeView = {
  date: string;
  deltaGoodsSen: number;
  kind: 'upsale' | 'drop';
  /** Why it is not an upsale / drop; null when it is one. */
  notCounted: 'opening_day' | 'first_price' | 'system_fix' | null;
  source: string;
  changedBy: string | null;
  /** Back-filled from the SO's modification history (1–19 October 2026). */
  fromHistory: boolean;
};

export type SoRow = {
  docNo: string;
  soDate: string | null;
  salesperson: string | null;
  customer: string | null;
  goodsSen: number;
  totalSen: number;
  paidSen: number;
  paidPct: number;
  /** The day payments reached 30% of the total, on or before `to`. */
  reachedOn: string | null;
  commissionSen: number;
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
  totalSalesRm: number | null;
  estimateRm: number | null;
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
};

/** Where an order sits on the page: its fair, and that fair's place. */
type OrderPlace = {
  docNo: string; fairId: number; fairName: string;
  brand: string | null; organizer: string | null; venue: string | null; state: string | null;
  salesperson: string | null; customer: string | null; ratePct: number | null;
};

/** An earlier order, once, with what happened to it in the range. */
export type EarlierOrderRow = OrderPlace & {
  events: Array<{ date: string; kind: AdjustmentRow['kind']; beforeReach: boolean }>;
  lastDate: string;
  /** Goods before the range's counted changes, as at `to`, and the difference. */
  originalSen: number; latestSen: number; amendedSen: number;
  /** The order's commission lines in the range, summed. */
  commissionSen: number;
  fromHistory: boolean;
};

/** An order whose goods the range changed (upsales / drop sales), once, final. */
export type ChangedOrderRow = OrderPlace & {
  /** 'range' — this range's fairs (the effect is inside their commission);
      'earlier' — an earlier order (inside the earlier lines). */
  part: 'range' | 'earlier';
  lastChange: string;
  originalSen: number; latestSen: number; amendedSen: number;
  reachedOn: string | null;
  /** Amended × the brand rate once the order has reached 30% by `to`, else 0. */
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
  totals: { payableSen: number; adjustmentsSen: number; monthAdjustmentsSen: number; totalSen: number };
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

/** What a month's report pays each order: its fair commission and its earlier
 *  lines. The adjustments for closed months it carries are not the month's own. */
export function paidByOrder(r: Pick<EventCommissionReport, 'fairs' | 'adjustments'>): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (doc: string, sen: number) => { if (sen !== 0) out[doc] = (out[doc] ?? 0) + sen; };
  for (const f of r.fairs) for (const so of f.sos) add(so.docNo, so.commissionSen);
  for (const a of r.adjustments) add(a.docNo, a.commissionSen);
  return out;
}

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
      where.set(so.docNo, { fairId: f.id, fairName: f.name, brand: f.brand, salesperson: so.salesperson, customer: so.customer });
    }
    for (const o of now.earlierOrders) {
      if (!where.has(o.docNo)) where.set(o.docNo, { fairId: o.fairId, fairName: o.fairName, brand: o.brand, salesperson: o.salesperson, customer: o.customer });
    }
    for (const doc of new Set([...Object.keys(was), ...Object.keys(nowPaid)])) {
      const w = was[doc] ?? 0;
      const n = nowPaid[doc] ?? 0;
      if (w === n) continue;
      const at = where.get(doc) ?? { fairId: null, fairName: '', brand: null, salesperson: null, customer: null };
      rows.push({ month: k.month, docNo: doc, ...at, wasSen: w, nowSen: n, adjustmentSen: n - w });
    }
  }
  return rows.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : a.docNo < b.docNo ? -1 : 1));
}

/** The report with the closed months' adjustments added to it and its total. */
export function withMonthAdjustments(r: EventCommissionReport, rows: MonthAdjustmentRow[]): EventCommissionReport {
  const monthAdjustmentsSen = rows.reduce((s, a) => s + a.adjustmentSen, 0);
  return {
    ...r,
    monthAdjustments: rows,
    totals: { ...r.totals, monthAdjustmentsSen, totalSen: r.totals.payableSen + r.totals.adjustmentsSen + monthAdjustmentsSen },
  };
}

export const COMMISSION_PAID_SHARE = 0.3;
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
    date, deltaGoodsSen: delta, kind: delta > 0 ? 'upsale' : 'drop', notCounted, source: ch.source, changedBy: ch.changedBy,
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
  const placeOf = (so: CommissionSo, f: CommissionFair): OrderPlace => ({
    docNo: so.docNo, fairId: f.id, fairName: f.name,
    brand: f.brand, organizer: f.organizer ?? null, venue: f.venue ?? null, state: f.state ?? null,
    salesperson: so.salesperson, customer: so.customer, ratePct: rateOf(f),
  });
  /* The range's counted changes of an order (before `until`, when it was cancelled). */
  const countedIn = (so: CommissionSo, chs: readonly CommissionChange[], until: string | null = null): ChangeView[] =>
    chs.map((ch) => changeView(ch, so))
      .filter((v): v is ChangeView => v != null && v.notCounted == null && v.date >= from && v.date <= to && (until == null || v.date < until));
  const changedOrders: ChangedOrderRow[] = [];
  /* An order whose goods the range changed, once: Original before the counted
     changes, Latest as at `to`. Nothing to list when they cancel out. */
  const noteChanged = (so: CommissionSo, f: CommissionFair, part: ChangedOrderRow['part']) => {
    const chs = changesOf.get(so.docNo) ?? [];
    const counted = countedIn(so, chs);
    if (counted.length === 0) return;
    const amended = counted.reduce((s, v) => s + v.deltaGoodsSen, 0);
    if (amended === 0) return;
    const latest = goodsAt(so.goodsSen, chs, to);
    const reached = reachedOn(so.totalSen, paymentsOf.get(so.docNo) ?? [], to);
    const place = placeOf(so, f);
    changedOrders.push({
      ...place, part,
      lastChange: counted.reduce((m, v) => (v.date > m ? v.date : m), counted[0]!.date),
      originalSen: latest - amended, latestSen: latest, amendedSen: amended, reachedOn: reached,
      effectSen: reached ? commissionOf(amended, place.ratePct) : 0,
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
    const goods = goodsAt(so.goodsSen, chs, to);
    const paid = pays.filter((p) => mytDay(p.paidAt) <= to).reduce((s, p) => s + (Number(p.amountSen) || 0), 0);
    const reached = reachedOn(so.totalSen, pays, to);
    return {
      docNo: so.docNo,
      soDate: so.soDate,
      salesperson: so.salesperson,
      customer: so.customer,
      goodsSen: goods,
      totalSen: so.totalSen,
      paidSen: paid,
      paidPct: so.totalSen > 0 ? Math.round((paid / so.totalSen) * 1000) / 10 : 0,
      reachedOn: reached,
      commissionSen: reached ? commissionOf(goods, rate) : 0,
      changes: chs.filter((ch) => mytDay(ch.changedAt) <= to).map((ch) => changeView(ch, so)).filter((v): v is ChangeView => v != null),
    };
  };
  const fairRowOf = (f: CommissionFair, members: readonly CommissionSo[]): FairRow => {
    const rate = rateOf(f);
    const sos = members.map((so) => soRowAsAt(so, rate)).filter((r): r is SoRow => r != null)
      .sort((a, b) => (a.docNo < b.docNo ? -1 : 1));
    for (const so of members) if (sos.some((r) => r.docNo === so.docNo)) noteChanged(so, f, 'range');
    return {
      id: f.id, name: f.name, brand: f.brand, organizer: f.organizer ?? null, venue: f.venue ?? null, state: f.state ?? null,
      startDate: f.startDate, endDate: f.endDate,
      ratePct: rate, totalSalesRm: f.totalSalesRm, estimateRm: f.estimateRm,
      payableSen: sos.reduce((s, r) => s + r.commissionSen, 0),
      sos,
    };
  };
  const inRange = (day: string | null): boolean => day != null && day >= from && day <= to;

  /* PART 1 — by fair: the fairs starting in the range, all their orders.
     By SO date: the orders opened in the range, grouped under their fairs. */
  const fairs: FairRow[] = [];
  if (basis === 'fair') {
    for (const f of input.fairs.filter((x) => inRange(x.startDate))) {
      fairs.push(fairRowOf(f, input.sos.filter((s) => s.projectId === f.id)));
    }
  } else {
    const opened = new Map<number, CommissionSo[]>();
    for (const so of input.sos) {
      if (!inRange(so.soDate) || !fairById.has(so.projectId)) continue;
      const list = opened.get(so.projectId);
      if (list) list.push(so); else opened.set(so.projectId, [so]);
    }
    const ordered = [...opened.keys()].map((id) => fairById.get(id)!)
      .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.name < b.name ? -1 : 1));
    for (const f of ordered) fairs.push(fairRowOf(f, opened.get(f.id)!));
  }

  /* PART 2 — in the range, on orders of fairs that started before it (by fair),
     or on orders opened before it (by SO date). */
  const earlier = (so: CommissionSo, f: CommissionFair): boolean =>
    basis === 'fair' ? f.startDate < from : so.soDate != null && so.soDate < from;
  const adjustments: AdjustmentRow[] = [];
  const earlierOrders: EarlierOrderRow[] = [];
  for (const so of input.sos) {
    const f = fairById.get(so.projectId);
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
      const goods = goodsAt(so.goodsSen, chs, reached!);
      adjustments.push({ ...base, date: reached!, kind: 'reached', goodsSen: goods, commissionSen: commissionOf(goods, rate), beforeReach: false });
    }
    for (const ch of chs) {
      const v = changeView(ch, so);
      if (!v || v.notCounted || v.date < from || v.date > to) continue;
      if (cancelled != null && v.date >= cancelled) continue;
      if (reached != null && v.date === reached) continue; // folded into the amount earned that day
      const after = earned && reached! < v.date;
      adjustments.push({
        ...base, date: v.date, kind: v.kind, goodsSen: v.deltaGoodsSen,
        commissionSen: after ? commissionOf(v.deltaGoodsSen, rate) : 0,
        beforeReach: !after,
      });
    }
    if (earned && cancelled != null && cancelled >= from && cancelled <= to) {
      const goods = goodsAt(so.goodsSen, chs, cancelled);
      adjustments.push({ ...base, date: cancelled, kind: 'cancelled', goodsSen: goods, commissionSen: -commissionOf(goods, rate), beforeReach: false });
    }
    /* The same order once, its final result in the range. */
    const mine = adjustments.slice(firstLine);
    if (mine.length > 0) {
      const counted = countedIn(so, chs, cancelled);
      const amended = counted.reduce((s, v) => s + v.deltaGoodsSen, 0);
      const latest = goodsAt(so.goodsSen, chs, to);
      earlierOrders.push({
        ...placeOf(so, f),
        events: mine.map((a) => ({ date: a.date, kind: a.kind, beforeReach: a.beforeReach })),
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

  const payableSen = fairs.reduce((s, f) => s + f.payableSen, 0);
  const adjustmentsSen = adjustments.reduce((s, a) => s + a.commissionSen, 0);
  return {
    basis, from, to, fairs, adjustments, earlierOrders, changedOrders, monthAdjustments: [],
    totals: { payableSen, adjustmentsSen, monthAdjustmentsSen: 0, totalSen: payableSen + adjustmentsSen },
  };
}
