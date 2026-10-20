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
// ----------------------------------------------------------------------------

export type CommissionFair = {
  id: number;
  name: string;
  brand: string | null;
  startDate: string;
  endDate: string | null;
  /** The event page's Total Sales (RM) and its Commission row (RM) — the estimate. */
  totalSalesRm: number | null;
  estimateRm: number | null;
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
  notCounted: 'opening_day' | 'first_price' | null;
  source: string;
  changedBy: string | null;
};

export type SoRow = {
  docNo: string;
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

export type EventCommissionReport = {
  from: string;
  to: string;
  fairs: FairRow[];
  adjustments: AdjustmentRow[];
  totals: { payableSen: number; adjustmentsSen: number; totalSen: number };
};

export const COMMISSION_PAID_SHARE = 0.3;
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
  const notCounted = date === mytDay(so.createdAt) ? 'opening_day'
    : ch.beforeTotalSen <= FIRST_PRICE_MAX_SEN ? 'first_price'
    : null;
  return { date, deltaGoodsSen: delta, kind: delta > 0 ? 'upsale' : 'drop', notCounted, source: ch.source, changedBy: ch.changedBy };
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
}): EventCommissionReport {
  const { from, to } = input;
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

  /* PART 1 — fairs starting in the range, as at `to`. */
  const fairs: FairRow[] = [];
  for (const f of input.fairs.filter((x) => x.startDate >= from && x.startDate <= to)) {
    const rate = rateOf(f);
    const sos: SoRow[] = [];
    for (const so of input.sos.filter((s) => s.projectId === f.id)) {
      if (so.onHold || so.status === 'DRAFT' || so.status === 'ON_HOLD') continue;
      const cancelled = cancelOf.get(so.docNo);
      if (so.status === 'CANCELLED' && (!cancelled || cancelled <= to)) continue;
      const pays = paymentsOf.get(so.docNo) ?? [];
      const chs = changesOf.get(so.docNo) ?? [];
      const goods = goodsAt(so.goodsSen, chs, to);
      const paid = pays.filter((p) => mytDay(p.paidAt) <= to).reduce((s, p) => s + (Number(p.amountSen) || 0), 0);
      const reached = reachedOn(so.totalSen, pays, to);
      sos.push({
        docNo: so.docNo,
        salesperson: so.salesperson,
        customer: so.customer,
        goodsSen: goods,
        totalSen: so.totalSen,
        paidSen: paid,
        paidPct: so.totalSen > 0 ? Math.round((paid / so.totalSen) * 1000) / 10 : 0,
        reachedOn: reached,
        commissionSen: reached ? commissionOf(goods, rate) : 0,
        changes: chs.filter((ch) => mytDay(ch.changedAt) <= to).map((ch) => changeView(ch, so)).filter((v): v is ChangeView => v != null),
      });
    }
    sos.sort((a, b) => (a.docNo < b.docNo ? -1 : 1));
    fairs.push({
      id: f.id, name: f.name, brand: f.brand, startDate: f.startDate, endDate: f.endDate,
      ratePct: rate, totalSalesRm: f.totalSalesRm, estimateRm: f.estimateRm,
      payableSen: sos.reduce((s, r) => s + r.commissionSen, 0),
      sos,
    });
  }

  /* PART 2 — in the range, on orders of fairs that started before it. */
  const adjustments: AdjustmentRow[] = [];
  for (const so of input.sos) {
    const f = fairById.get(so.projectId);
    if (!f || !(f.startDate < from)) continue;
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
  }
  adjustments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.docNo < b.docNo ? -1 : 1));

  const payableSen = fairs.reduce((s, f) => s + f.payableSen, 0);
  const adjustmentsSen = adjustments.reduce((s, a) => s + a.commissionSen, 0);
  return { from, to, fairs, adjustments, totals: { payableSen, adjustmentsSen, totalSen: payableSen + adjustmentsSen } };
}
