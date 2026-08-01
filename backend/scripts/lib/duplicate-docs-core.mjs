// PURE core of the system-wide DUPLICATE-DOCUMENT detector (owner 2026-08-02,
// off 2990-PO-2606-023 vs -024: same supplier DIGLANT, same date, same
// MAKOTO OLIVE x5 + BRONZE x5 at RM2,650/line — 023 never received, 024
// received AND shipped; 023's phantom lines inflated MRP supply and its
// fifo-attribute allocations re-claimed SO demand 024 had already delivered).
//
// No database, no I/O — the check script (check-duplicate-documents.mjs) feeds
// normalized document lines in and prints what comes out; every judgement that
// decides whether two documents LOOK like one order twice lives here, where the
// unit suite can hold it still.
//
// THE COMPARISON KEY is the line MULTISET: each line reduced to
// (item_code, variant_key, qty, unit_price_centi), the whole document to the
// sorted multiset of those tuples. Two documents with the SAME multiset ordered
// the same physical goods at the same prices — for the same counterparty within
// a few days, that is a duplicate CANDIDATE (never a verdict on its own: the
// execution state decides how much it matters, and Q-vs-K sibling buys share
// everything BUT the codes).

/* One line → its canonical tuple string. Codes are case/space-normalized;
   qty/price are numbers (null price prints as '?'). */
export const lineTupleKey = (l) =>
  [
    String(l.itemCode ?? "").trim().toUpperCase(),
    String(l.variantKey ?? "").trim(),
    String(Math.max(0, Number(l.qty ?? 0))),
    l.unitPriceCenti == null ? "?" : String(Number(l.unitPriceCenti)),
  ].join("|");

/* Document → sorted multiset key (the exact-duplicate fingerprint). */
export const docLineMultisetKey = (lines = []) =>
  lines.map(lineTupleKey).sort().join("::");

/* Multiset overlap in [0,1]: |intersection| / |larger side|, counting
   multiplicity. 1 = identical multisets; the report prints it as a percent. */
export function lineMultisetMatchPct(aLines = [], bLines = []) {
  const count = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const k = lineTupleKey(l);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const a = count(aLines);
  const b = count(bLines);
  let inter = 0;
  for (const [k, n] of a.entries()) inter += Math.min(n, b.get(k) ?? 0);
  const denom = Math.max(aLines.length, bLines.length);
  return denom === 0 ? 0 : inter / denom;
}

/* SIBLING shape: same line count and the same (qty, price) multiset but
   DIFFERENT item codes — the legitimate "Q size + K size from one supplier"
   pattern the owner named (2990-PO-2607-001 vs -005). */
export function isSiblingShape(aLines = [], bLines = []) {
  if (aLines.length === 0 || aLines.length !== bLines.length) return false;
  const qp = (lines) => lines
    .map((l) => `${Math.max(0, Number(l.qty ?? 0))}|${l.unitPriceCenti == null ? "?" : Number(l.unitPriceCenti)}`)
    .sort()
    .join("::");
  if (qp(aLines) !== qp(bLines)) return false;
  const codes = (lines) => new Set(lines.map((l) => String(l.itemCode ?? "").trim().toUpperCase()));
  const ca = codes(aLines);
  const cb = codes(bLines);
  for (const c of ca) if (cb.has(c)) return false; // any shared code → not a pure sibling
  return true;
}

export const dateGapDays = (a, b) => {
  const ta = Date.parse(String(a ?? ""));
  const tb = Date.parse(String(b ?? ""));
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.abs(ta - tb) / 86_400_000;
};

/* Verdict for one candidate pair. Inputs are FACTS the script gathered; the
 * rule is fixed here:
 *   LIKELY-DUPLICATE  exact multiset match (pct === 1), same counterparty,
 *                     dates within the window
 *   SIBLING-LEGIT     sibling shape (same qty+price multiset, disjoint codes)
 *   NEEDS-EYES        everything else that scored past the report floor
 * Risk rank (sort ascending): 0 = LIKELY-DUPLICATE where exactly one side is
 * executed (the 023-class: an unexecuted twin of a real order — cancel-able
 * without touching goods), 1 = LIKELY-DUPLICATE both-executed (possible double
 * receipt/shipment — worse, but needs physical verification), 2 = other
 * LIKELY-DUPLICATE, 3 = NEEDS-EYES, 4 = SIBLING-LEGIT. */
export function classifyDocPair({ matchPct, sibling, gapDays, windowDays = 3, aExecuted, bExecuted }) {
  const inWindow = gapDays != null && gapDays <= windowDays;
  let verdict;
  if (matchPct === 1 && inWindow) verdict = "LIKELY-DUPLICATE";
  else if (sibling) verdict = "SIBLING-LEGIT";
  else verdict = "NEEDS-EYES";
  let risk;
  if (verdict === "LIKELY-DUPLICATE") {
    const oneExecuted = Boolean(aExecuted) !== Boolean(bExecuted);
    risk = oneExecuted ? 0 : (aExecuted && bExecuted ? 1 : 2);
  } else if (verdict === "NEEDS-EYES") risk = 3;
  else risk = 4;
  return { verdict, risk };
}

/* Pair up duplicate candidates inside ONE group (same company + counterparty).
 * docs: [{ id, docNo, date, executed, lines }] — the script groups them.
 * Only pairs worth reading are returned: exact multiset matches inside the
 * date window, sibling shapes inside the window, and high-overlap
 * (>= reportFloor) near-misses inside the window. */
export function pairDuplicateCandidates(docs = [], { windowDays = 3, reportFloor = 0.8 } = {}) {
  const out = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const a = docs[i];
      const b = docs[j];
      const gap = dateGapDays(a.date, b.date);
      if (gap == null || gap > windowDays) continue;
      const matchPct = lineMultisetMatchPct(a.lines, b.lines);
      const sibling = isSiblingShape(a.lines, b.lines);
      if (matchPct < reportFloor && !sibling) continue;
      const { verdict, risk } = classifyDocPair({
        matchPct, sibling, gapDays: gap, windowDays,
        aExecuted: a.executed, bExecuted: b.executed,
      });
      out.push({ a, b, matchPct, gapDays: gap, verdict, risk });
    }
  }
  return out.sort((x, y) => x.risk - y.risk || y.matchPct - x.matchPct
    || String(x.a.docNo).localeCompare(String(y.a.docNo)));
}

/* (I) MRP SUPPLY INFLATION from a duplicate-suspect PO. computeMrp counts every
 * non-dead PO line's (qty - received) as incoming supply, so an unexecuted
 * duplicate inflates "PO Outstanding" and suppresses shortage. Per affected
 * bucket: supply with vs without the suspect's open qty, and the shortage
 * delta that vanishes once the duplicate is cancelled (dead statuses are
 * excluded from supply, so cancellation self-corrects MRP).
 *   buckets: [{ bucket, demandQty, stockQty, supplyQty, suspectOpenQty }]
 * shortage = max(0, demand - stock - supply). */
export function mrpInflationForBuckets(buckets = []) {
  return buckets.map((b) => {
    const demand = Math.max(0, Number(b.demandQty ?? 0));
    const stock = Math.max(0, Number(b.stockQty ?? 0));
    const withSupply = Math.max(0, Number(b.supplyQty ?? 0));
    const suspect = Math.max(0, Number(b.suspectOpenQty ?? 0));
    const withoutSupply = Math.max(0, withSupply - suspect);
    const shortageWith = Math.max(0, demand - stock - withSupply);
    const shortageWithout = Math.max(0, demand - stock - withoutSupply);
    return {
      bucket: b.bucket,
      demandQty: demand,
      stockQty: stock,
      supplyWith: withSupply,
      supplyWithout: withoutSupply,
      shortageWith,
      shortageWithout,
      shortageHiddenBySuspect: shortageWithout - shortageWith,
    };
  });
}
