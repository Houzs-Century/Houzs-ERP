// ---------------------------------------------------------------------------
// duplicate-sofa-lot-plan — decide WHICH open sofa cutover lots are surplus.
//
// THE DEFECT IT ANSWERS. `import-ac-sofa-stock.mjs` keys a cell by
// (item code, warehouse, batch, VARIANT KEY) — its own idempotency test, section
// 6. The variant key is computed from the document's variants, so when a build's
// sales line gains or loses a special after its lots were opened, the SAME
// physical sofa re-keys, reads as a cell nobody has opened, and is opened AGAIN.
// Measured on production 2026-09-08: 73 purchase orders hold sofa cutover stock
// and their own lines justify 73 builds; the lot table holds 93. About 20 sofas
// counted twice. docs/bugs/0721.
//
// WHAT THIS MODULE IS. Pure. It takes rows somebody else read and returns which
// lots to retire and which groups to REFUSE. No database, no clock, no writes —
// so every refusal below is a test, not a hope.
//
// THE KEEP RULE, and why it is not "keep the newest".
// The lot that survives is the one whose key equals what the PURCHASE LINE says
// today, because that is the key the allocator (findCoveringBatch) and the
// delivery pre-flight both compute. Newest-wins would be right most of the time
// here and wrong exactly when a special was removed rather than added — and it
// would be a guess either way. If no open lot matches the purchase line, this
// refuses rather than picking: two wrong keys are a finding, not a repair.
// ---------------------------------------------------------------------------

/** MIRROR of src/scm/shared/variant-key.ts computeVariantKey for the sofa
 *  group only — the repair scripts run under plain node and cannot import TS.
 *  KEEP IN LOCKSTEP: duplicateSofaLotPlan.test.mjs imports the REAL function
 *  through the shared mirror in ledger-repair-core.mjs and fails if they part. */
export { variantKeyMirror } from "./ledger-repair-core.mjs";

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/** The sofa MODEL behind a compartment code: `8030-1A(LHF)` -> `8030`.
 *  Strips the LAST dash segment, never the first, because a model may contain
 *  its own dash (`SOFA-333 44-CNR`) — the same rule sofa-piece-fold.mjs states
 *  and for the same reason. */
export function modelOfCompartment(itemCode) {
  const c = norm(itemCode);
  const i = c.lastIndexOf("-");
  return i <= 0 ? c : c.slice(0, i);
}

/**
 * @param lots      [{ id, batchNo, itemCode, variantKey, warehouseId, qtyReceived,
 *                     qtyRemaining, unitCostSen, createdAt, consumptions }]
 *                  OPEN cutover lots only — the caller filters source_doc_type
 *                  and qty_remaining, because "open" is a database question.
 * @param poLines   [{ poNumber, itemCode, itemGroup, variants }] the sofa lines
 *                  of those purchase orders.
 * @param soBindings [{ batchNo, itemCode, variantKey }] sales-order lines
 *                  currently allocated to one of those batches. A lot a live
 *                  order is pointing at is never retired, whatever its key.
 * @param computeKey (itemGroup, variants) -> string. Injected so the test can
 *                  pass the REAL computeVariantKey rather than the mirror.
 * @returns { retire: [...], refusals: [...], groups: number }
 */
export function planDuplicateSofaLots({ lots, poLines, soBindings, computeKey, allowCostedRetire = false }) {
  if (typeof computeKey !== "function") throw new Error("computeKey is required");

  /* allowCostedRetire OPT-IN (default false keeps every existing caller and the
     16 pinned tests unchanged). When true, a surplus lot that carries a cost is
     RETIRED instead of refused — a deliberate inventory WRITE-OFF, only for the
     costed-duplicate decision the owner takes with the figure in front of them
     (docs/bugs/0721). It changes NOTHING else: a consumed, part-consumed,
     live-SO-bound, or model-not-on-order lot is still refused, because those are
     not "money moves" refusals — they are "this is not surplus" refusals. */

  /** `${batch}|${itemCode}` -> the purchase line that governs it. */
  const poByCell = new Map();
  /** `${po}` -> the models its sofa lines carry, for the no-line refusal. */
  const modelsByPo = new Map();
  for (const l of poLines) {
    poByCell.set(`${l.poNumber}|${norm(l.itemCode)}`, l);
    const set = modelsByPo.get(l.poNumber) ?? new Set();
    set.add(modelOfCompartment(l.itemCode));
    modelsByPo.set(l.poNumber, set);
  }

  const boundKeys = new Set(
    (soBindings ?? []).map((b) => `${b.batchNo}|${norm(b.itemCode)}|${b.variantKey ?? ""}`),
  );

  /** `${batch}|${itemCode}` -> lots */
  const cells = new Map();
  for (const lot of lots) {
    const k = `${lot.batchNo}|${norm(lot.itemCode)}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(lot);
  }

  const retire = [];
  const refusals = [];
  const refuse = (batchNo, itemCode, why, lotIds) =>
    refusals.push({ batchNo, itemCode, why, lotIds: lotIds ?? [] });

  for (const [cellKey, cellLots] of cells) {
    const keys = new Set(cellLots.map((l) => l.variantKey ?? ""));
    const [batchNo, itemCode] = cellKey.split("|");
    const ids = cellLots.map((l) => l.id);

    /* A cell whose ITEM CODE is on no line of the order it claims to come from
       is surplus for a different reason, and it is surplus even when it carries
       ONE key — so this test comes before the duplicate-key one. It is only ever
       REPORTED. Three such sets exist on production (2026-09-08): 8030 pieces
       under HC-PO-009712 (a 5535 order), 8030 under HC-PO-009017 (9058) and
       9058 under HC-PO-009550 (8030), all written 2026-09-07 20:49. Retiring
       them would destroy the evidence of whatever wrote them, and re-coding them
       is not a stock operation. docs/bugs/0721. */
    if (!poByCell.has(cellKey) && modelsByPo.has(batchNo)) {
      const models = modelsByPo.get(batchNo);
      if (!models.has(modelOfCompartment(itemCode))) {
        refuse(batchNo, itemCode,
          `MODEL NOT ON THE ORDER — ${itemCode} is a ${modelOfCompartment(itemCode)} piece and ${batchNo}'s sofa lines are ${[...models].join(", ")}. Reported, never retired: what wrote it is unsettled`,
          ids);
        continue;
      }
    }

    if (keys.size <= 1) continue; // one key = one build = nothing to decide

    const po = poByCell.get(cellKey);
    if (!po) {
      const models = modelsByPo.get(batchNo);
      refuse(batchNo, itemCode,
        models
          ? `no line of ${batchNo} carries ${itemCode} — that order's sofa lines are ${[...models].join(", ")}. Which of these is the real build is not answerable from stock alone`
          : `${batchNo} has no sofa purchase line at all`,
        ids);
      continue;
    }

    const current = computeKey(po.itemGroup ?? "sofa", po.variants ?? null);
    if (!keys.has(current)) {
      refuse(batchNo, itemCode,
        `the purchase line's key today is "${current}" and NO open lot carries it (${[...keys].map((k) => `"${k}"`).join(", ")}) — picking one would be a guess`,
        ids);
      continue;
    }

    for (const lot of cellLots) {
      const key = lot.variantKey ?? "";
      if (key === current) continue;
      if (Number(lot.consumptions ?? 0) > 0) {
        refuse(batchNo, itemCode, `lot ${lot.id} has already been consumed ${lot.consumptions} time(s) — retiring it would restate a shipment`, [lot.id]);
        continue;
      }
      if (Number(lot.qtyRemaining) !== Number(lot.qtyReceived)) {
        refuse(batchNo, itemCode, `lot ${lot.id} is part-consumed (${lot.qtyRemaining} of ${lot.qtyReceived} left) — something took goods from it`, [lot.id]);
        continue;
      }
      if (Number(lot.unitCostSen ?? 0) !== 0 && !allowCostedRetire) {
        refuse(batchNo, itemCode, `lot ${lot.id} carries a cost (${lot.unitCostSen} sen) — retiring it moves money, which this tool may not do`, [lot.id]);
        continue;
      }
      if (boundKeys.has(`${batchNo}|${norm(itemCode)}|${key}`)) {
        refuse(batchNo, itemCode, `a sales order is allocated to lot ${lot.id}'s exact key — the order, not the purchase line, decides here`, [lot.id]);
        continue;
      }
      retire.push({
        lotId: lot.id,
        batchNo,
        itemCode: lot.itemCode,
        warehouseId: lot.warehouseId,
        staleKey: key,
        currentKey: current,
        qty: Number(lot.qtyRemaining),
        unitCostSen: Number(lot.unitCostSen ?? 0),
        createdAt: lot.createdAt ?? null,
      });
    }
  }

  return { retire, refusals, groups: cells.size };
}
