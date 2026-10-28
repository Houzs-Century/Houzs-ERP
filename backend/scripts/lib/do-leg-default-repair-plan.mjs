// ---------------------------------------------------------------------------
// do-leg-default-repair-plan — decide what the five stranded delivery lines of
// docs/bugs/0722 SHOULD have written, without writing anything.
//
// THE DEFECT IT ANSWERS. `SoLineCard`'s heal effect auto-filled a blank sofa Leg
// Height with "Default" (the owner's 2026-07-13 convenience so a SALES ORDER
// never shows an empty field). The card is SHARED, so the same seeding ran on
// the DELIVERY ORDER form, and `computeVariantKey` emits `legheight=` for a
// sofa — so the delivery asked the stock ledger about a bucket nothing had ever
// been stored under. Three documents were pushed through on "Ship anyway"
// (HC-DO-2609-004, -009, -011). The goods left the building; the OUT movement
// was written with the invented key, consumed NO lot, and carried NO cost. So
// stock is overstated by those pieces and the sale carries no COGS.
//
// #3296 stopped it happening again (`seedSofaLegDefault` is a mandatory prop, so
// the compiler enumerates the call sites). Nothing has repaired the five lines
// that already went out — docs/bugs/0722 says so in terms: "recorded here and
// NOT repaired — a stock write needs its own plan/apply tool and the owner's
// word." This module is the planning half of that tool.
//
// WHAT THIS MODULE IS. Pure. It takes rows somebody else read and returns what
// WOULD be written. No database, no clock, no writes — so every refusal below is
// a test, not a hope. The apply half does not exist yet, deliberately: the owner
// sees the plan first.
//
// WHY IT REFUSES RATHER THAN GUESSES. Every repair here consumes real stock and
// stamps real money. A line whose corrected key finds no lot, or finds several,
// is a FINDING — the tool says so and stops. Picking one would be a guess
// wearing the clothes of a repair, and the same rule already governs
// duplicate-sofa-lot-plan.mjs: "two wrong keys are a finding, not a repair."
// ---------------------------------------------------------------------------

/** The fragment the delivery form invented. A sofa lot never carries it: of 179
 *  sofa compartment lots on production, ZERO do (docs/bugs/0722). */
export const LEG_DEFAULT_FRAGMENT = "legheight=default";

/** Remove the invented `legheight=default` segment from a variant key, leaving
 *  the key the sales order — and therefore the lot — actually carries.
 *
 *  Segment-wise on purpose. A blind string replace would also mangle a genuine
 *  `legheight=default-plus` if one is ever added, and would leave a stray `|`
 *  behind at either end. */
export function stripLegDefault(variantKey) {
  const segments = String(variantKey ?? "")
    .split("|")
    .filter((s) => s.trim().toLowerCase() !== LEG_DEFAULT_FRAGMENT);
  return segments.join("|");
}

/** True when this movement is one the defect produced. */
export function carriesLegDefault(variantKey) {
  return String(variantKey ?? "")
    .split("|")
    .some((s) => s.trim().toLowerCase() === LEG_DEFAULT_FRAGMENT);
}

/**
 * @param movements  [{ id, sourceDocNo, itemCode, qty, warehouseId, variantKey,
 *                      unitCostSen }] OUT movements of the affected documents.
 * @param lots       [{ id, itemCode, variantKey, warehouseId, qtyRemaining,
 *                      unitCostSen, batchNo, receivedAt }] OPEN lots only — the
 *                   caller filters `qty_remaining > 0`, because "open" is a
 *                   database question.
 * @param consumptionCountByMovementId  { [movementId]: number } — how many lot
 *                   consumptions each movement already has. A movement with any
 *                   is already whole and must not be repaired twice.
 * @returns { repairs, refusals, totals }
 */
export function planDoLegDefaultRepair({
  movements = [],
  lots = [],
  consumptionCountByMovementId = {},
}) {
  const repairs = [];
  const refusals = [];

  for (const m of movements) {
    const base = {
      movementId: m.id,
      sourceDocNo: m.sourceDocNo,
      itemCode: m.itemCode,
      qty: m.qty,
      fromKey: m.variantKey,
    };

    if (!carriesLegDefault(m.variantKey)) {
      refusals.push({ ...base, reason: "NOT_IN_SCOPE", detail: "the key carries no invented leg height" });
      continue;
    }

    /* Already whole. The pillow lines on these same documents look exactly like
       this — they consumed their lot and carry cost — which is why the scope is
       the movement's own consumption count and not the document. */
    const already = consumptionCountByMovementId[m.id] ?? 0;
    if (already > 0) {
      refusals.push({ ...base, reason: "ALREADY_CONSUMED", detail: `${already} lot consumption(s) already recorded` });
      continue;
    }

    const toKey = stripLegDefault(m.variantKey);
    const candidates = lots.filter(
      (l) =>
        l.itemCode === m.itemCode &&
        l.warehouseId === m.warehouseId &&
        l.variantKey === toKey &&
        Number(l.qtyRemaining) > 0,
    );

    if (candidates.length === 0) {
      refusals.push({ ...base, toKey, reason: "NO_LOT", detail: "no open lot carries the corrected key at this warehouse" });
      continue;
    }
    /* Several open lots under one corrected key is the duplicate class of
       docs/bugs/0721, not this one. Repairing across it would pick a lot — and
       therefore a cost — on this tool's authority. It is refused here so the two
       repairs stay separable and neither hides the other. */
    if (candidates.length > 1) {
      refusals.push({
        ...base,
        toKey,
        reason: "AMBIGUOUS",
        detail: `${candidates.length} open lots carry the corrected key (see docs/bugs/0721)`,
      });
      continue;
    }

    const lot = candidates[0];
    if (Number(lot.qtyRemaining) < Number(m.qty)) {
      refusals.push({
        ...base,
        toKey,
        reason: "SHORT",
        detail: `lot holds ${lot.qtyRemaining}, movement took ${m.qty}`,
      });
      continue;
    }
    /* A repair that fixes the QUANTITY and leaves the cost at zero would close
       the stock overstatement and leave the sale still carrying no COGS — half a
       repair, and the half nobody would notice was missing. Refuse instead. */
    if (!(Number(lot.unitCostSen) > 0)) {
      refusals.push({
        ...base,
        toKey,
        lotId: lot.id,
        reason: "LOT_UNCOSTED",
        detail: "the corrected lot carries no cost, so this would fix stock and leave COGS at zero",
      });
      continue;
    }

    repairs.push({
      ...base,
      toKey,
      lotId: lot.id,
      batchNo: lot.batchNo ?? null,
      lotQtyRemaining: Number(lot.qtyRemaining),
      unitCostSen: Number(lot.unitCostSen),
      totalCostSen: Number(lot.unitCostSen) * Number(m.qty),
    });
  }

  const totals = {
    movementsRead: movements.length,
    repairs: repairs.length,
    refusals: refusals.length,
    piecesToConsume: repairs.reduce((n, r) => n + Number(r.qty), 0),
    costToStampSen: repairs.reduce((n, r) => n + r.totalCostSen, 0),
  };

  return { repairs, refusals, totals };
}
