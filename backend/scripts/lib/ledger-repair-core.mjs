// PURE core of the 2026-08 ledger-perfection repairs (W2 inbound gap, W3
// reference-cost basis, W4 variant-key relabel). No database, no I/O — every
// rule that decides whether the money-critical FIFO ledger may be written is
// unit-testable here, and the scripts that talk to production carry no
// judgement of their own (the doc-ref-repair-core.mjs discipline, verbatim).
//
// THE THREE WOUNDS these rules close (costing audit 2026-08-01, runs
// 30694120826 / 30695536709; detector check-inventory-integrity.mjs):
//
//   W2  A posted GRN accepted more units than its IN movements booked
//       (2990-GRN-2606-001: 501 accepted vs one movement of 500) — one unit
//       never entered the ledger. Audit section 3a.
//   W3  OUT movements that consumed no lot because NOTHING was on hand, and no
//       later receipt ever arrived to retro-cost them — COGS RM0 forever
//       unless a reference cost is seeded. Detector section (2), residual class.
//   W4  Movement rows whose variant_key DISAGREES with the lot their own
//       consumptions (or their own opened lot) point at — the 2990 import
//       copied movements and lots whose keys were computed by different
//       writers, so per-bucket sums drift in EQUAL AND OPPOSITE pairs while
//       the family total, and every cost, is right. Audit sections 1 and 2b.
//       The repair is a LABEL move: no cost column changes, RM impact zero.

/** W2 — decide, per product of ONE GRN, whether the missing inbound units can
 *  be inserted with evidence. `lineQty` is the GRN's accepted-net-of-returns
 *  total for the product; `buckets` are the DISTINCT
 *  (warehouse, variant, batch, company) groups of the GRN's OWN existing IN
 *  movements for that product, each with its summed movement qty and the
 *  DISTINCT unit costs those movements carry.
 *
 *  A missing unit is inserted ONLY when its bucket and cost are PROVEN by a
 *  sibling movement of the same GRN + product: exactly one bucket, exactly one
 *  unit cost. Anything else is reported, never guessed:
 *    insert            — qty = lineQty - movQty inserted into the one bucket
 *                        at the one sibling cost
 *    balanced          — lines and movements agree; nothing to do (idempotent
 *                        re-run lands here)
 *    over-posted       — movements EXCEED lines; an insert cannot fix that
 *    no-sibling        — no IN movement exists to prove bucket or cost
 *    ambiguous-bucket  — >1 distinct (warehouse, variant, batch, company)
 *    ambiguous-cost    — sibling movements disagree on unit cost */
export function classifyGrnInboundGap({ productCode, lineQty, buckets = [] }) {
  const movQty = buckets.reduce((a, b) => a + Number(b.movQty ?? 0), 0);
  const delta = Number(lineQty ?? 0) - movQty;
  const base = { productCode, lineQty: Number(lineQty ?? 0), movQty, delta };
  if (delta === 0) return { ...base, verdict: "balanced" };
  if (delta < 0) return { ...base, verdict: "over-posted" };
  if (buckets.length === 0) return { ...base, verdict: "no-sibling" };
  if (buckets.length > 1) return { ...base, verdict: "ambiguous-bucket" };
  const b = buckets[0];
  const costs = [...new Set((b.unitCosts ?? []).map((c) => Number(c)))];
  if (costs.length !== 1) return { ...base, verdict: "ambiguous-cost", unitCosts: costs };
  return {
    ...base,
    verdict: "insert",
    insert: {
      qty: delta,
      warehouseId: b.warehouseId,
      variantKey: b.variantKey ?? "",
      batchNo: b.batchNo ?? null,
      companyId: b.companyId,
      unitCostSen: costs[0],
    },
  };
}

/** W3 — pick the reference cost for units that shipped with NOTHING on hand.
 *  Owner's basis rule: the most recent same-(product, variant) GRN landed unit
 *  cost in the same company; fall back to the product's latest PO line cost if
 *  no GRN exists. A zero cost is NOT a basis (it is the wound itself), so
 *  zero-cost candidates are skipped and reported. Candidates arrive ALREADY
 *  filtered to the right (company, product, variant) and sorted newest-first
 *  by the caller; this rule only chooses and refuses.
 *    { source: 'GRN'|'PO', docNo, unitCostSen, skippedZeroCost } — or
 *    { source: null, skippedZeroCost } when no candidate carries a cost. */
export function pickCostBasis({ grnCandidates = [], poCandidates = [] }) {
  let skippedZeroCost = 0;
  for (const list of [grnCandidates, poCandidates]) {
    for (const c of list) {
      if (Number(c.unitCostSen ?? 0) > 0) {
        return {
          source: list === grnCandidates ? "GRN" : "PO",
          docNo: c.docNo ?? null,
          unitCostSen: Number(c.unitCostSen),
          skippedZeroCost,
        };
      }
      skippedZeroCost += 1;
    }
  }
  return { source: null, skippedZeroCost };
}

/** W4 — decide, per movement, whether its variant_key may be relabelled to the
 *  key of the lot its OWN ledger trail proves it belongs to. The evidence is
 *  never a guess about what the key SHOULD be — it is the consumption rows the
 *  movement already owns (OUT / negative ADJUSTMENT: the lots it decremented)
 *  or the lot it opened (IN / positive ADJUSTMENT: inventory_lots.movement_id).
 *  The LOT side is canonical: lots + consumptions are the costing spine, and
 *  the FIFO trigger's own invariant is that a movement and its lot agree on
 *  the key — these rows broke that invariant in the 2990 import.
 *
 *    relabel          — every lot the movement touches carries ONE key, and it
 *                       differs from the movement's; newKey is that key
 *    consistent       — the movement already matches its lots
 *    no-lot-evidence  — the movement touches no lot (an uncosted OUT — W3's
 *                       territory — or an IN whose lot is missing); untouched
 *    mixed-lot-keys   — its lots disagree among themselves; untouched, reported
 *    out-of-scope     — a movement type this rule holds no evidence for */
export function classifyMovementRelabel({
  movementId,
  movementType,
  qty,
  variantKey,
  consumptionLotKeys = [],
  openedLotKey = undefined,
}) {
  const base = { movementId, variantKey: variantKey ?? "" };
  const type = String(movementType ?? "").toUpperCase();
  const consumes = type === "OUT" || (type === "ADJUSTMENT" && Number(qty ?? 0) < 0);
  const opens = type === "IN" || (type === "ADJUSTMENT" && Number(qty ?? 0) > 0);
  if (consumes) {
    const keys = [...new Set(consumptionLotKeys.map((k) => k ?? ""))];
    if (keys.length === 0) return { ...base, verdict: "no-lot-evidence" };
    if (keys.length > 1) return { ...base, verdict: "mixed-lot-keys", lotKeys: keys };
    if (keys[0] === base.variantKey) return { ...base, verdict: "consistent" };
    return { ...base, verdict: "relabel", newKey: keys[0] };
  }
  if (opens) {
    if (openedLotKey === undefined || openedLotKey === null) return { ...base, verdict: "no-lot-evidence" };
    const key = openedLotKey ?? "";
    if (key === base.variantKey) return { ...base, verdict: "consistent" };
    return { ...base, verdict: "relabel", newKey: key };
  }
  return { ...base, verdict: "out-of-scope" };
}

/** W4 — the whole-family check the dry run prints: given each bucket's CURRENT
 *  movement and lot sums plus the planned relabels (movement qty MOVES from its
 *  old key's bucket to its new key's bucket; lots never move), return the
 *  per-bucket before/after so drift closing — or honestly failing to close —
 *  is visible before anything is written. Buckets are keyed by the caller
 *  (company::warehouse::product::variant); `relabels` carry the movement's
 *  SIGNED balance contribution (IN +qty, OUT -qty, ADJUSTMENT +qty — the
 *  scm.inventory_balances convention). */
export function projectRelabelledDrift(buckets, relabels) {
  const after = new Map();
  for (const [key, b] of buckets) {
    after.set(key, { movQty: Number(b.movQty ?? 0), lotQty: Number(b.lotQty ?? 0) });
  }
  const ensure = (key) => {
    if (!after.has(key)) after.set(key, { movQty: 0, lotQty: 0 });
    return after.get(key);
  };
  for (const r of relabels) {
    ensure(r.fromKey).movQty -= Number(r.signedQty ?? 0);
    ensure(r.toKey).movQty += Number(r.signedQty ?? 0);
  }
  return after;
}
