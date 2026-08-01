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

/** W2 fallback (live run 2026-08-01: the short line had NO sibling movement to
 *  copy from — `no-sibling`). The GRN line's OWN landed cost is the fallback
 *  basis: round(unit_price_centi x exchange_rate) — the exact `toMyrSen` path
 *  grns.ts uses for movements written outside the allocation (warehouse-change
 *  precedent, grns.ts:2463). MIRROR of lib/fx.ts `toMyrSen`/`safeRate`; the
 *  lockstep test pins the two together. */
export function toMyrSenMirror(foreignSen, rate) {
  const n = Number(rate ?? 1);
  const safe = Number.isFinite(n) && n > 0 ? n : 1;
  return Math.round(Number(foreignSen ?? 0) * safe);
}

/** MIRROR of src/scm/shared/variant-key.ts `computeVariantKey`, needed because
 *  a line-derived W2 insert must land in the SAME bucket the app would compute
 *  for that line, and the repair scripts run under plain node (no TS import).
 *  KEEP IN LOCKSTEP — the ledgerRepairCore test imports the real function and
 *  fails if the two ever disagree on a matrix of fixtures. */
export function variantKeyMirror(itemGroup, attrs) {
  const ATTRS_BY_GROUP = {
    sofa: ["fabricCode", "seatHeight", "legHeight"],
    bedframe: ["fabricCode", "gap", "divanHeight", "legHeight", "totalHeight"],
    mattress: [],
    accessory: [],
    others: [],
    service: [],
  };
  const norm = (v) => (v == null ? "" : String(v).trim().toLowerCase());
  const group = norm(itemGroup);
  const a = attrs ?? {};
  const parts = [];
  for (const k of ATTRS_BY_GROUP[group] ?? []) {
    const raw = k === "fabricCode"
      ? (a.fabricCode ?? a.colorCode ?? a.colourCode ?? a.fabricColor)
      : k === "seatHeight"
        ? (a.seatHeight ?? a.depth)
        : k === "legHeight"
          ? (a.legHeight ?? a.sofaLegHeight)
          : a[k];
    const val = norm(raw);
    if (val) parts.push(`${k.toLowerCase()}=${val}`);
  }
  const specials = Array.isArray(a.specials) && a.specials.length > 0
    ? a.specials
        .map((s) => (typeof s === "string" ? s : (s?.code ?? s?.label ?? "")))
        .map(norm)
        .filter(Boolean)
        .sort()
        .join(",")
    : "";
  if (specials) parts.push(`special=${specials}`);
  return parts.join("|");
}

/** W2 fallback — derive the insert for a short product with NO sibling
 *  movement, from the GRN's own facts. Everything must be single-valued or the
 *  product is refused:
 *    - exactly ONE line for the product (a delta cannot be attributed across
 *      several lines)
 *    - warehouse: the single warehouse the GRN's OTHER movements share, else
 *      the header warehouse; refused when neither exists
 *    - batch: the single batch the GRN's other movements share, else NULL
 *      (a plain unbatched lot — printed, not guessed)
 *    - variant: the line's own variants via the computeVariantKey mirror
 *    - cost: round(line unit_price_centi x GRN exchange_rate); refused at <= 0
 *  Verdicts: line-insert | multi-line | no-warehouse | zero-cost */
export function deriveGrnLineBasis({
  lines = [],
  qty,
  headerWarehouseId = null,
  exchangeRate = 1,
  grnMovementWarehouses = [],
  grnMovementBatches = [],
  companyId,
}) {
  if (lines.length !== 1) return { verdict: "multi-line", lineCount: lines.length };
  const line = lines[0];
  const whs = [...new Set(grnMovementWarehouses.filter(Boolean))];
  const warehouseId = whs.length === 1 ? whs[0] : headerWarehouseId;
  if (!warehouseId) return { verdict: "no-warehouse" };
  const unitCostSen = toMyrSenMirror(Number(line.unit_price_centi ?? 0), exchangeRate);
  if (!(unitCostSen > 0)) return { verdict: "zero-cost", unitCostSen };
  const batches = [...new Set(grnMovementBatches.filter(Boolean))];
  return {
    verdict: "line-insert",
    insert: {
      qty,
      warehouseId,
      variantKey: variantKeyMirror(line.item_group, line.variants ?? null),
      batchNo: batches.length === 1 ? batches[0] : null,
      companyId,
      unitCostSen,
    },
    costSource: `line unit_price_centi ${line.unit_price_centi} x rate ${exchangeRate}`,
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

/** part=dedupe (owner authorization 2026-08-01, "继续 全部可以") — decide
 *  whether a movement that part=ids classified `duplicate-of-real` may be
 *  DELETED. The index collision alone is NOT enough: uq_inv_mov_do_source is
 *  documented as keyed WITHOUT movement_type (and says nothing about qty), so
 *  a collision could pair two rows that describe DIFFERENT physical events.
 *  The owner's deletion rule requires a FULL-ROW twin: a real counterpart on
 *  the true doc id carrying the same (company, product_code, variant_key,
 *  warehouse, movement_type, qty). Anything less is refused and reported.
 *    delete           exactly this twin exists (>= 1 counterpart matches all
 *                     six facts) — the row is a provable import duplicate
 *    no-counterpart   the collision was real but no full-row twin exists —
 *                     the two rows disagree on type or qty; owner review
 *  `counterparts` are the REAL document's movements sharing the duplicate's
 *  bucket; the caller fetches them by (source_doc_id = resolvedDocId) and
 *  passes the six facts for each. */
export function classifyDuplicateMovement({ duplicate, counterparts = [] }) {
  const same = (a, b) => String(a ?? "") === String(b ?? "");
  const matches = counterparts.filter((c) =>
    Number(c.companyId) === Number(duplicate.companyId)
    && same(c.productCode, duplicate.productCode)
    && same(c.variantKey ?? "", duplicate.variantKey ?? "")
    && same(c.warehouseId, duplicate.warehouseId)
    && same(String(c.movementType).toUpperCase(), String(duplicate.movementType).toUpperCase())
    && Number(c.qty) === Number(duplicate.qty));
  if (matches.length === 0) return { verdict: "no-counterpart", matches: [] };
  return { verdict: "delete", matches: matches.map((m) => m.movementId) };
}

/** part=dedupe — the movement-ledger effect of deleting a set of duplicate
 *  movements, per (company, warehouse, product, variant) bucket, in the
 *  scm.inventory_balances signed convention. Deleting an OUT RAISES the
 *  bucket's on-hand sum by qty (the OUT contributed -qty); deleting an IN
 *  lowers it. This is what the owner's 2b question needs: duplicate OUTs
 *  double-decrement on-hand, so their deletion should shrink the negative
 *  buckets — the dry run prints each affected bucket before -> after so the
 *  linkage is visible either way. */
export function projectDedupeBucketImpact(deletions, currentSums) {
  const after = new Map();
  for (const [k, v] of currentSums) after.set(k, Number(v));
  for (const d of deletions) {
    const type = String(d.movementType).toUpperCase();
    const signed = type === "IN" ? Number(d.qty) : type === "OUT" ? -Number(d.qty) : Number(d.qty);
    after.set(d.bucketKey, (after.get(d.bucketKey) ?? 0) - signed);
  }
  return after;
}

/** W4 phase 1, round 3 (live run 2026-08-01) — classify ONE lot against the
 *  COSTING AUDIT'S OWN 2a lens. Round 2's candidate query used
 *  `received - consumed - remaining > 0` (deficit only — the missing-rows
 *  hypothesis) while the audit's 2a is `received - consumed <> remaining` OR
 *  three more arms — so reconstruct reported "every lot conserves" on the
 *  same day the audit counted 13. The two tools must never disagree: the
 *  runner now lifts the audit's WHERE verbatim, and THIS rule names which arm
 *  a candidate violates and which repair (if any) is provable:
 *    deficit            received - consumed - remaining > 0 — consumption
 *                       rows are MISSING; planFamilyReconstruction pairs them
 *    surplus            residual < 0 with consumed <= received — the rows
 *                       EXIST but qty_remaining was never decremented (the
 *                       import double-count); planSurplusCorrection restores
 *                       the trigger invariant remaining = received - consumed
 *    over-consumed      consumed > received — no decrement can conserve this
 *                       lot (remaining would go negative); owner review
 *    negative-remaining / negative-received — corrupt quantities; owner review
 *    conserves          not a candidate (the audit would not have flagged it) */
export function classifyLotConservation({ qtyReceived, consumed, qtyRemaining }) {
  const received = Number(qtyReceived ?? 0);
  const cons = Number(consumed ?? 0);
  const remaining = Number(qtyRemaining ?? 0);
  const residual = received - cons - remaining;
  const base = { received, consumed: cons, remaining, residual };
  if (received < 0) return { ...base, verdict: "negative-received" };
  if (remaining < 0) return { ...base, verdict: "negative-remaining" };
  if (cons > received) return { ...base, verdict: "over-consumed" };
  if (residual > 0) return { ...base, verdict: "deficit" };
  if (residual < 0) return { ...base, verdict: "surplus" };
  return { ...base, verdict: "conserves" };
}

/** W4 phase 1, the SURPLUS repair — a lot whose consumption rows exist but
 *  whose qty_remaining was never decremented holds the same units twice (once
 *  consumed, once on hand). The provable correction restores the FIFO
 *  trigger's own invariant: remaining := received - consumed. Refused unless
 *  every consumption row is traceable and honest:
 *    orphan-consumptions  a row with movement_id NULL asserts consumption by
 *                         nothing traceable
 *    missing-movement     a row references a movement that does not exist
 *    over-attribution     a referenced movement's total consumed exceeds its
 *                         own |qty| (audit 10c — the rows themselves lie)
 *    over-consumed        consumed > received (no non-negative remaining)
 *  On "correct": { newRemaining, delta } — delta is the double-counted
 *  on-hand units removed; the CALLER prices it (delta x unit cost) and prints
 *  the inventory-value impact. COGS does not move: the consumption rows
 *  already booked it. */
export function planSurplusCorrection({ qtyReceived, consumed, qtyRemaining, referencedMovements = [] }) {
  const received = Number(qtyReceived ?? 0);
  const cons = Number(consumed ?? 0);
  const remaining = Number(qtyRemaining ?? 0);
  const newRemaining = received - cons;
  if (newRemaining < 0) return { verdict: "over-consumed", newRemaining };
  if (referencedMovements.some((m) => m.movementId == null)) return { verdict: "orphan-consumptions" };
  const missing = referencedMovements.filter((m) => !m.exists);
  if (missing.length > 0) return { verdict: "missing-movement", missing: missing.map((m) => m.movementId) };
  const over = referencedMovements.filter((m) => Number(m.consumedTotal ?? 0) > Math.abs(Number(m.absQty ?? 0)));
  if (over.length > 0) return { verdict: "over-attribution", over: over.map((m) => m.movementId) };
  return { verdict: "correct", newRemaining, delta: remaining - newRemaining };
}

/** W4 phase 1 (live run 2026-08-01) — RECONSTRUCT the consumption rows the
 *  2990 import dropped. The relabel's dry run refused every XAMMAR movement
 *  with `no-lot-evidence`: the OUT movements carry qty and (mostly) cost, the
 *  lots are ALREADY decremented (audit 2a: received - consumed != remaining;
 *  10a agrees per batch), but the inventory_lot_consumptions rows LINKING them
 *  were never imported — so there was no trail for the relabel to follow.
 *
 *  This rule rebuilds the link where the family's own arithmetic PROVES it,
 *  per (company, warehouse, product) family across ALL sibling variant keys:
 *    movements: OUT / negative-ADJUSTMENT rows with consumption shortfall
 *               s = ABS(qty) - alreadyConsumed > 0, oldest first
 *    lots:      rows with conservation deficit d = received - consumed -
 *               remaining > 0, oldest first
 *  GUARDS — the family is refused wholesale unless ALL hold:
 *    1. Sigma(s) === Sigma(d) — the two sides describe the same missing rows
 *    2. the FIFO pairing walk covers every shortfall exactly
 *    3. per movement, cost consistency: the paired cost (Sigma take x lot
 *       unit cost) EQUALS the movement's stored total_cost_sen (pure re-link,
 *       RM0) OR the movement's cost is 0 (the pairing will stamp it, 0154-
 *       style, and the RM amount is reported) — any other mismatch refuses
 *       the family, because the pairing would contradict money already booked.
 *  Nothing is deleted, no lot quantity moves (remaining is already the truth);
 *  only the missing consumption rows are written, plus the 0154 cost stamp for
 *  movements that had none. Drift (movement sum vs lot remaining) is NOT
 *  closed by this phase — the movements still sit under their old key; run
 *  MODE=relabel afterwards: with the reconstructed rows it finally has the
 *  evidence it demands.
 *
 *  Returns { verdict: "reconstruct", pairs, stamps, rmStampedSen } or
 *  { verdict: refusal, ...evidence }. `pairs` are
 *  { movementId, lotId, qty, unitCostSen }; `stamps` are movements whose
 *  total/unit cost will be written from their (new) consumption sum. */
export function planFamilyReconstruction({ movements = [], lots = [] }) {
  const shorts = movements
    .map((m) => ({
      ...m,
      shortfall: Math.abs(Number(m.qty ?? 0)) - Number(m.alreadyConsumed ?? 0),
    }))
    .filter((m) => m.shortfall > 0)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.movementId < b.movementId ? -1 : 1));
  const deficits = lots
    .map((l) => ({
      ...l,
      deficit: Number(l.qtyReceived ?? 0) - Number(l.consumed ?? 0) - Number(l.qtyRemaining ?? 0),
    }))
    .filter((l) => l.deficit > 0)
    .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.lotId < b.lotId ? -1 : 1));

  const totalShort = shorts.reduce((a, m) => a + m.shortfall, 0);
  const totalDeficit = deficits.reduce((a, l) => a + l.deficit, 0);
  const base = { totalShort, totalDeficit, shorts, deficits };
  if (totalShort === 0 && totalDeficit === 0) return { ...base, verdict: "balanced" };
  if (totalShort !== totalDeficit) return { ...base, verdict: "sums-mismatch" };

  // FIFO pairing walk — deterministic, oldest movement takes oldest deficit.
  const pairs = [];
  const perMovement = new Map();
  let li = 0;
  let remaining = deficits.map((l) => l.deficit);
  for (const m of shorts) {
    let need = m.shortfall;
    let cost = 0;
    while (need > 0) {
      while (li < deficits.length && remaining[li] <= 0) li += 1;
      if (li >= deficits.length) return { ...base, verdict: "pairing-failed" };
      const take = Math.min(need, remaining[li]);
      pairs.push({ movementId: m.movementId, lotId: deficits[li].lotId, qty: take, unitCostSen: Number(deficits[li].unitCostSen ?? 0) });
      cost += take * Number(deficits[li].unitCostSen ?? 0);
      remaining[li] -= take;
      need -= take;
    }
    perMovement.set(m.movementId, { pairedCostSen: cost, movement: m });
  }

  // Cost consistency per movement. The 0154 convention is
  // total_cost_sen === Sigma(its consumptions' cost), so with the EXISTING
  // rows' cost E and the paired new cost P the only two honest states are:
  //   stored === E + P  — the import stamped the full cost and dropped only
  //                       the rows: pure re-link, RM0
  //   stored === E      — the cost never covered the missing rows: stamp to
  //                       E + P (0154-style), RM impact = P, reported
  // Anything else contradicts money already booked and refuses the family.
  const stamps = [];
  let rmStampedSen = 0;
  const conflicts = [];
  for (const { pairedCostSen, movement } of perMovement.values()) {
    const stored = Number(movement.totalCostSen ?? 0);
    const existing = Number(movement.alreadyConsumedCostSen ?? 0);
    if (stored === existing + pairedCostSen) continue; // pure re-link, RM0
    if (stored === existing) {
      stamps.push({ movementId: movement.movementId, newTotalCostSen: existing + pairedCostSen });
      rmStampedSen += pairedCostSen;
      continue;
    }
    conflicts.push({ movementId: movement.movementId, storedCostSen: stored, existingConsumedCostSen: existing, pairedCostSen });
  }
  if (conflicts.length > 0) return { ...base, verdict: "cost-conflict", conflicts };
  return { ...base, verdict: "reconstruct", pairs, stamps, rmStampedSen };
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
