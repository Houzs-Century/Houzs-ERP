/* The bucket classifier for close-stale-sales-orders.mjs — PURE, no I/O.

   Input: one sales order and the lines of it that the MRP engine still plans
   for, each with its ERP delivery facts and its AutoCount book state.
   Output: which bucket the ORDER falls in, and why.

   THE OWNER'S RULES (2026-09-15):
     1. 「开了 DO 的东西就代表已经不需要这个货了」 — a line that went out on a
        delivery order needs no more goods.
     2. 「这个0其实就是代表没送货的意思，是对的」 — a line on a DO at quantity 0
        was NOT delivered. So rule 1 does not close it.

   BUCKETS (exclusive, first match wins, in this order):
     1 BOOK_DELIVERED   the AutoCount book says a planned line was delivered in
                        full, and the ERP has no delivery order for that line.
     2 DO_QTY_ZERO      a planned line sits on a live DO at qty 0. Report only:
                        per rule 2 the order stays open.
     - DRAFT_DO         a planned line is on a DRAFT delivery order — a delivery
                        is being prepared right now. Never closed.
     3 HAD_DO_EXPIRED   the order already shipped something (a live DO with
                        qty > 0) and every planned line is past its delivery date.
     4 NO_DO_EXPIRED    no live DO on the order at all, every planned line past
                        its delivery date. A list for the owner to tick.
     5 UNDATED          every planned line has no delivery date. Counted by SO
                        month only; no close is proposed.
     - OUT_OF_SCOPE     anything else (future-dated, or a mix of expired and
                        future/undated lines — closing the header would take the
                        future lines with it).

   `closable` says whether the close tool may act on the order at all when its
   bucket is selected. It is false for 2, DRAFT_DO, 5 and OUT_OF_SCOPE, and
   false for bucket 1 unless EVERY planned line is book-delivered — a header
   close would otherwise take lines the book still owes.

   NO SHEBANG — imported by tests (CLAUDE.md R101). */

export const BUCKETS = Object.freeze({
  BOOK_DELIVERED: "1",
  DO_QTY_ZERO: "2",
  HAD_DO_EXPIRED: "3",
  NO_DO_EXPIRED: "4",
  UNDATED: "5",
  DRAFT_DO: "DRAFT_DO",
  OUT_OF_SCOPE: "OUT_OF_SCOPE",
});

/** What one planned line is, from the delivery side.
 *  @param {{ liveDoLines: number, liveDoQty: number, draftDoLines: number, book: string }} l */
export function lineKind(l) {
  if (Number(l.draftDoLines) > 0) return "DRAFT_DO";
  if (Number(l.liveDoQty) > 0) return "PARTIAL_ON_DO";
  if (Number(l.liveDoLines) > 0) return "ON_DO_QTY_ZERO";
  if (l.book === "BOOK_DELIVERED") return "BOOK_DELIVERED";
  return "NOT_ON_DO";
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

/**
 * @param {{
 *   orderLiveDoQty: number,               // units on live (not DRAFT/CANCELLED) DOs across the WHOLE order, header-linked DOs included
 *   lines: Array<{ delivery: string|null, liveDoLines: number, liveDoQty: number, draftDoLines: number, book: string }>,
 * }} order
 * @param {string} today  YYYY-MM-DD (MYT)
 */
export function classifyOrder(order, today) {
  const lines = order.lines ?? [];
  if (lines.length === 0) throw new Error("classifyOrder: an order with no planned lines is not MRP demand");
  const kinds = lines.map(lineKind);
  const dated = lines.map((l) => (!l.delivery ? "UNDATED" : l.delivery < today ? "EXPIRED" : "FUTURE"));
  const allExpired = dated.every((d) => d === "EXPIRED");
  const latest = lines.map((l) => l.delivery).filter(Boolean).sort().at(-1) ?? null;
  const daysOverdue = allExpired && latest ? daysBetween(latest, today) : null;
  const count = (k) => kinds.filter((x) => x === k).length;
  const base = { kinds, daysOverdue, bookDeliveredLines: count("BOOK_DELIVERED"), zeroQtyLines: count("ON_DO_QTY_ZERO"), partialLines: count("PARTIAL_ON_DO") };

  if (count("BOOK_DELIVERED") > 0) {
    const all = count("BOOK_DELIVERED") === lines.length;
    return { ...base, bucket: BUCKETS.BOOK_DELIVERED, closable: all, why: all ? "every planned line is delivered in the AutoCount book; the ERP has no DO for them" : `${count("BOOK_DELIVERED")} of ${lines.length} planned lines are book-delivered; the rest are still owed — not closed as a whole` };
  }
  if (count("ON_DO_QTY_ZERO") > 0) {
    return { ...base, bucket: BUCKETS.DO_QTY_ZERO, closable: false, why: "owner: qty 0 = not delivered, left open" };
  }
  if (count("DRAFT_DO") > 0) {
    return { ...base, bucket: BUCKETS.DRAFT_DO, closable: false, why: "a planned line is on a DRAFT delivery order being prepared" };
  }
  if (dated.every((d) => d === "UNDATED")) {
    return { ...base, bucket: BUCKETS.UNDATED, closable: false, why: "no delivery date on any planned line; counted by SO month only" };
  }
  if (!allExpired) {
    return { ...base, bucket: BUCKETS.OUT_OF_SCOPE, closable: false, why: dated.includes("EXPIRED") ? "some planned lines are expired and others are not — a header close would take the others" : "delivery date not yet reached" };
  }
  if (Number(order.orderLiveDoQty) > 0) {
    return { ...base, bucket: BUCKETS.HAD_DO_EXPIRED, closable: true, why: "the order already shipped on a live DO; the lines left were never delivered and their delivery date has passed" };
  }
  return { ...base, bucket: BUCKETS.NO_DO_EXPIRED, closable: true, why: "no live DO on the order; every planned line is past its delivery date" };
}

/** Parse a comma/space separated list of SO numbers, normalised to HC-SO-NNNNNN. */
export function parseDocList(text) {
  return [...new Set(String(text ?? "").split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? `HC-SO-${s.padStart(6, "0")}` : /^SO-/.test(s) ? `HC-${s}` : s)))];
}

/** Parse the buckets input ("1,3"). Only closable buckets are accepted. */
export function parseBuckets(text) {
  const out = [...new Set(String(text ?? "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
  const bad = out.filter((b) => !["1", "3", "4"].includes(b));
  if (bad.length) throw new Error(`buckets: only 1, 3 and 4 can be closed (2 and 5 are report-only); got ${bad.join(", ")}`);
  return out;
}

/**
 * Which classified orders an APPLY run would close.
 * Bucket 4 needs an explicit tick: without `docs` no bucket-4 order is selected.
 * `docs`, when given, restricts every bucket to those orders; `exclude` removes.
 */
export function selectForClose(classified, { buckets, docs, exclude }) {
  const want = new Set(buckets);
  const only = docs?.length ? new Set(docs) : null;
  const drop = new Set(exclude ?? []);
  return classified.filter((o) => {
    if (!o.closable || !want.has(o.bucket) || drop.has(o.doc_no)) return false;
    if (o.bucket === BUCKETS.NO_DO_EXPIRED && !only) return false;
    return only ? only.has(o.doc_no) : true;
  });
}
