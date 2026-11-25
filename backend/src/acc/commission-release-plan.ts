// ----------------------------------------------------------------------------
// acc/commission-release-plan — what each month's commission release IS. Pure:
// acc/commission-release.ts reads the books and posts; this decides.
//
// The owner's practice (2026-11-25): salespeople are paid in full as soon as an
// order exists (「我每次付给sales person是full的，是订单一有就要付了」), so each
// month's commission bill sits in PREPAYMENT COMMISSION, and each month the part
// whose orders became sales moves to cost (「每个月根据送的货或covert as sales
// invoice 才重这里转」) — on NET sales: sales invoices plus deposit invoices less
// the credit notes that contra those deposit invoices, so a deposit counts once
// (「根据net sales covert to commission」). A bill booked after its month goes
// back to that month (「要改会原月份」).
//
// LAYERS — what the prepaid account holds, each split over the orders it paid:
//   • a month's bill lines (the prepaid lines naming the month): each order's
//     share is what the Event Commission close paid it that month (by SO date,
//     its adjustments included), scaled so the shares add up to the bill. A month
//     the report never closed — or one before the books start, when there was no
//     report — is split by the goods of the orders dated in it;
//   • the books' opening balance on the account: split by goods over the orders
//     dated before the first billed month that were still unsold when the books
//     started (the owner's AutoCount balance carried them).
// RELEASE — by the end of month m an order has released share × (net sales to
//   date ÷ its total), whole once sold; an order cancelled or closed releases what
//   is left the day it ends. Never before the bill's own month, never before the
//   books start. Per order in whole sen, so a layer whose orders are all sold has
//   released exactly its amount.
// ----------------------------------------------------------------------------

export type Ym = string;

const YM = /^(\d{4})-(\d{2})$/;
const pad = (n: number): string => String(n).padStart(2, '0');

/** The month after `ym`. */
export function nextYm(ym: Ym): Ym {
  const m = YM.exec(ym);
  if (!m) return ym;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 12 ? `${y + 1}-01` : `${y}-${pad(mo + 1)}`;
}

/** Every month from `from` to `to`, both included (empty when `from` is later). */
export function monthsFromTo(from: Ym, to: Ym): Ym[] {
  const out: Ym[] = [];
  if (!YM.test(from) || !YM.test(to)) return out;
  for (let m = from; m <= to && out.length < 600; m = nextYm(m)) out.push(m);
  return out;
}

/** The last day of a month, YYYY-MM-DD. */
export function lastDayOf(ym: Ym): string {
  const m = YM.exec(ym);
  if (!m) return `${ym}-31`;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

/** The day before a YYYY-MM-DD day. */
export function dayBefore(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : day;
}

/**
 * `totalSen` split over the weights so the parts add up exactly (largest
 * remainder; ties to the earlier key). Weights may be negative — a close pays a
 * cancellation back as a minus — but must not sum to zero. Null when they do.
 */
export function splitByWeight(totalSen: number, weights: ReadonlyArray<readonly [string, number]>): Map<string, number> | null {
  const sum = weights.reduce((s, [, w]) => s + w, 0);
  if (sum === 0 || weights.length === 0) return null;
  const exact = weights.map(([k, w], i) => ({ k, i, v: (totalSen * w) / sum }));
  const out = new Map<string, number>();
  let given = 0;
  for (const e of exact) {
    const f = Math.floor(e.v);
    out.set(e.k, f);
    given += f;
  }
  let left = totalSen - given;
  const byRest = [...exact].sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)) || a.i - b.i);
  for (const e of byRest) {
    if (left <= 0) break;
    out.set(e.k, (out.get(e.k) ?? 0) + 1);
    left -= 1;
  }
  return out;
}

/* ── What the planner is given ──────────────────────────────────────────── */

/** A line on the prepaid account other than the release itself: a bill (or its
    credit) naming the month it pays for, or the books' opening. */
export type PrepaidLine = {
  /** The month the line pays for; null for the books' opening balance. */
  month: Ym | null;
  /** Debit less credit, sen. */
  amountSen: number;
  /** The document it came from (AP invoice number, the opening's number). */
  docNo: string;
};

/** One Event Commission close: what the month paid each order, its adjustments for earlier closed months included. */
export type PlanClose = { month: Ym; perOrder: ReadonlyArray<readonly [string, number]> };

export type PlanOrder = {
  docNo: string;
  soDate: string | null;
  status: string;
  /** The order's total — what its net sales are measured against. */
  totalSen: number;
  /** The day it ended without the rest of its sale (cancelled or closed); null while it is live. */
  endedOn: string | null;
};

/** A movement of an order's net sales: + a sales invoice or a deposit invoice, − a credit note that contras a deposit invoice. */
export type PlanSale = { docNo: string; day: string; amountSen: number };

export type PlanInput = {
  /** The first month a release may be dated in (the books' start). */
  booksStart: Ym;
  /** The last month planned. */
  through: Ym;
  prepaid: PrepaidLine[];
  closes: PlanClose[];
  orders: PlanOrder[];
  sales: PlanSale[];
  /** An order's goods as at the end of a day (the four goods buckets). */
  goodsAt: (docNo: string, day: string) => number;
  /** Only orders dated on or after this day carry the opening balance; null = every older order. */
  openingFrom: string | null;
};

/* ── What it answers ────────────────────────────────────────────────────── */

export type LayerBasis = 'close' | 'goods' | 'none';

export type PlanLayer = {
  /** 'opening' or 'bill:YYYY-MM'. */
  key: string;
  month: Ym | null;
  amountSen: number;
  docs: string[];
  basis: LayerBasis;
  /** The orders its amount is split over. */
  orders: number;
  /** The first month it may release in. */
  fromMonth: Ym;
  /** The release dated in each month, oldest first (months with nothing left out). */
  byMonth: Array<{ month: Ym; sen: number }>;
  releasedSen: number;
  leftSen: number;
  /** What a person should know: scaled to the bill, waiting for the report, nothing to carry it. */
  note: string | null;
};

export type PlanMonth = {
  month: Ym;
  totalSen: number;
  /** The month's release per layer (only layers that moved). */
  parts: Array<{ key: string; sen: number }>;
};

export type CommissionPlan = {
  months: PlanMonth[];
  layers: PlanLayer[];
  /** Each layer's per-order shares — the page's drill-down and the tests. */
  shares: Map<string, Map<string, number>>;
};

const fmtRm = (sen: number): string => `RM ${(sen / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const layerLabel = (l: Pick<PlanLayer, 'key' | 'month'>): string => {
  if (l.key === 'opening') return 'Opening balance';
  const m = l.month ? YM.exec(l.month) : null;
  if (!m) return l.key;
  const name = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${name} ${m[1]} bill`;
};

/** How much of an order is sold by the end of a day, 0..1. */
function soldShare(o: PlanOrder | undefined, sales: PlanSale[] | undefined, end: string): number {
  if (!o) return 0;
  if (o.endedOn != null && o.endedOn <= end) return 1;
  let sold = 0;
  for (const s of sales ?? []) if (s.day <= end) sold += s.amountSen;
  if (o.totalSen <= 0) return sold > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, sold / o.totalSen));
}

export function planCommissionRelease(input: PlanInput): CommissionPlan {
  const booksStartDay = `${input.booksStart}-01`;
  const orderOf = new Map(input.orders.map((o) => [o.docNo, o]));
  const salesOf = new Map<string, PlanSale[]>();
  for (const s of input.sales) salesOf.set(s.docNo, [...(salesOf.get(s.docNo) ?? []), s]);
  const live = (o: PlanOrder): boolean => o.status !== 'DRAFT';
  const endedBy = (o: PlanOrder, day: string): boolean => o.endedOn != null && o.endedOn <= day;

  /* The bills by the month they pay for; the opening on its own. */
  const billByMonth = new Map<Ym, { amountSen: number; docs: Set<string> }>();
  let opening: { amountSen: number; docs: Set<string> } | null = null;
  for (const p of input.prepaid) {
    if (p.month == null) {
      opening = opening ?? { amountSen: 0, docs: new Set() };
      opening.amountSen += p.amountSen;
      opening.docs.add(p.docNo);
      continue;
    }
    const at = billByMonth.get(p.month) ?? { amountSen: 0, docs: new Set<string>() };
    at.amountSen += p.amountSen;
    at.docs.add(p.docNo);
    billByMonth.set(p.month, at);
  }
  const closeOf = new Map(input.closes.map((c) => [c.month, c]));
  const billMonths = [...billByMonth.keys()].sort();
  const firstBilled = billMonths[0] ?? input.booksStart;

  type Built = { key: string; month: Ym | null; amountSen: number; docs: string[]; basis: LayerBasis; shares: Map<string, number>; fromMonth: Ym; note: string | null };
  const built: Built[] = [];

  const goodsWeights = (docs: string[], day: string): Array<[string, number]> =>
    docs.map((d) => [d, input.goodsAt(d, day)] as [string, number]).filter(([, w]) => w > 0);

  for (const month of billMonths) {
    const bill = billByMonth.get(month)!;
    if (bill.amountSen === 0) continue;
    const fromMonth = month < input.booksStart ? input.booksStart : month;
    const close = month >= input.booksStart ? closeOf.get(month) : undefined;
    let basis: LayerBasis = 'none';
    let shares: Map<string, number> | null = null;
    let note: string | null = null;
    if (close) {
      const entries = close.perOrder.filter(([, sen]) => sen !== 0);
      const paid = entries.reduce((s, [, sen]) => s + sen, 0);
      shares = splitByWeight(bill.amountSen, entries);
      if (shares) {
        basis = 'close';
        if (paid !== bill.amountSen) note = `The bill (${fmtRm(bill.amountSen)}) and the Event Commission close (${fmtRm(paid)}) differ — each order's share is scaled to the bill.`;
      }
    }
    if (!shares) {
      const end = lastDayOf(month);
      const docs = input.orders
        .filter((o) => live(o) && o.soDate != null && o.soDate.slice(0, 7) === month && !endedBy(o, end))
        .map((o) => o.docNo);
      shares = splitByWeight(bill.amountSen, goodsWeights(docs, end));
      if (shares) {
        basis = 'goods';
        note = month >= input.booksStart
          ? 'The Event Commission report for this month is not closed yet — split by the goods of the month\'s orders until it is.'
          : 'Before the books start there is no Event Commission report — split by the goods of the month\'s orders.';
      } else {
        note = 'No order carries this bill — nothing is released.';
      }
    }
    built.push({ key: `bill:${month}`, month, amountSen: bill.amountSen, docs: [...bill.docs].sort(), basis, shares: shares ?? new Map(), fromMonth, note });
  }

  if (opening && opening.amountSen !== 0) {
    /* The orders the opening carried: dated before the first billed month (and on
       or after openingFrom), still live and unsold the day the books start. */
    const cutoff = `${firstBilled < input.booksStart ? firstBilled : input.booksStart}-01`;
    const eve = dayBefore(booksStartDay);
    const docs = input.orders
      .filter((o) => live(o) && o.soDate != null && o.soDate < cutoff && (input.openingFrom == null || o.soDate >= input.openingFrom))
      .filter((o) => !endedBy(o, eve) && !(salesOf.get(o.docNo) ?? []).some((s) => s.day < booksStartDay))
      .map((o) => o.docNo);
    const shares = splitByWeight(opening.amountSen, goodsWeights(docs, eve));
    built.push({
      key: 'opening', month: null, amountSen: opening.amountSen, docs: [...opening.docs].sort(),
      basis: shares ? 'goods' : 'none', shares: shares ?? new Map(), fromMonth: input.booksStart,
      note: shares ? 'No per-order breakdown — split by the goods of the orders still unsold when the books started.' : 'No order carries the opening balance — nothing is released.',
    });
  }

  /* The release: per order, whole sen, cumulative; the month's release is what moved. */
  const months = monthsFromTo(input.booksStart, input.through);
  const monthTotals = new Map<Ym, Map<string, number>>(months.map((m) => [m, new Map()]));
  const layers: PlanLayer[] = [];
  const sharesOut = new Map<string, Map<string, number>>();
  for (const l of built) {
    sharesOut.set(l.key, l.shares);
    const byMonth: Array<{ month: Ym; sen: number }> = [];
    const prev = new Map<string, number>();
    let released = 0;
    for (const m of months) {
      if (m < l.fromMonth) continue;
      const end = lastDayOf(m);
      let moved = 0;
      for (const [doc, share] of l.shares) {
        const now = Math.round(share * soldShare(orderOf.get(doc), salesOf.get(doc), end));
        moved += now - (prev.get(doc) ?? 0);
        prev.set(doc, now);
      }
      if (moved !== 0) {
        byMonth.push({ month: m, sen: moved });
        monthTotals.get(m)!.set(l.key, moved);
        released += moved;
      }
    }
    layers.push({
      key: l.key, month: l.month, amountSen: l.amountSen, docs: l.docs, basis: l.basis,
      orders: l.shares.size, fromMonth: l.fromMonth, byMonth,
      releasedSen: released, leftSen: l.amountSen - released, note: l.note,
    });
  }

  return {
    months: months.map((m) => {
      const parts = [...monthTotals.get(m)!.entries()].map(([key, sen]) => ({ key, sen }));
      return { month: m, totalSen: parts.reduce((s, p) => s + p.sen, 0), parts };
    }),
    layers,
    shares: sharesOut,
  };
}

/* ── One layer, order by order (the page's drill-down) ──────────────────── */

export type LayerOrderRow = {
  docNo: string;
  soDate: string | null;
  status: string;
  totalSen: number;
  /** The order's share of the layer. */
  shareSen: number;
  /** How much of it is sold by the end of the plan's last month, 0..1. */
  sold: number;
  releasedSen: number;
  leftSen: number;
};

export function layerOrders(input: PlanInput, plan: CommissionPlan, key: string): LayerOrderRow[] {
  const layer = plan.layers.find((l) => l.key === key);
  const shares = plan.shares.get(key);
  if (!layer || !shares) return [];
  const orderOf = new Map(input.orders.map((o) => [o.docNo, o]));
  const salesOf = new Map<string, PlanSale[]>();
  for (const s of input.sales) salesOf.set(s.docNo, [...(salesOf.get(s.docNo) ?? []), s]);
  const end = lastDayOf(input.through);
  return [...shares.entries()].map(([docNo, shareSen]) => {
    const o = orderOf.get(docNo);
    const sold = soldShare(o, salesOf.get(docNo), end);
    const releasedSen = input.through < layer.fromMonth ? 0 : Math.round(shareSen * sold);
    return { docNo, soDate: o?.soDate ?? null, status: o?.status ?? 'NOT FOUND', totalSen: o?.totalSen ?? 0, shareSen, sold, releasedSen, leftSen: shareSen - releasedSen };
  }).sort((a, b) => String(a.soDate ?? '').localeCompare(String(b.soDate ?? '')) || a.docNo.localeCompare(b.docNo));
}
