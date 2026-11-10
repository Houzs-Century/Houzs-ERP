// Pure planning logic for scripts/repair-uncosted-out-named.mjs.
//
// That script costs uncosted stock-out movements of ONE item in NAMED warehouses
// by doing what scm.fn_reconcile_uncosted_out (0154, latest body in
// 20261026T1600) does — consumption row, lot decremented, OUT cost raised by what
// was consumed — for OUTs the function refuses to touch (non-DO OUTs). The
// function is not weakened; the script performs the same steps for exactly the
// movements its plan printed. Everything that decides WHAT gets written lives
// here, so it can be tested without a database.

import { createHash } from "node:crypto";

/** A movement that draws stock: OUT, or a negative ADJUSTMENT (the FIFO trigger
 *  consumes lots for both). OUT qty is stored positive (inventory_balances
 *  subtracts it), so ABS is taken everywhere, as 0154 does. */
export function isConsumingMovement(movementType, qty) {
  const t = String(movementType ?? "").toUpperCase();
  return t === "OUT" || (t === "ADJUSTMENT" && Number(qty ?? 0) < 0);
}

/** Units of a consuming movement that no consumption row covers yet. */
export function outstandingQty(m) {
  return Math.max(0, Math.abs(Number(m.qty ?? 0)) - Number(m.consumed ?? 0));
}

/** Why a short movement must NOT be costed by this repair, or null. Mirrors the
 *  DO guards of 0154 that still make sense for a named repair: a CANCELLED DO's
 *  OUT is netted by its reversal (costing it books COGS on a cancelled sale), and
 *  a drop-ship DO is costed by fn_reconcile_dropship_batch. Both go to the owner. */
export function refusalFor(m) {
  if (String(m.source_doc_type ?? "").toUpperCase() !== "DO") return null;
  if (m.do_status == null) return "names a DO that no longer exists";
  if (String(m.do_status).toUpperCase() === "CANCELLED") return "its DO is CANCELLED (the reversal nets it; costing it would book COGS on a cancelled sale)";
  if (m.do_dropship) return "its DO is drop-ship (fn_reconcile_dropship_batch owns that cost)";
  return null;
}

const byTimeThenId = (ta, tb) => (a, b) => {
  const x = new Date(a[ta]).getTime() - new Date(b[tb]).getTime();
  if (x !== 0) return x;
  return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
};

/**
 * Plan the repair of ONE (company, warehouse, item, variant) bucket.
 *
 * @param {object} p
 * @param {Array}  p.consumers  consuming movements of the bucket:
 *                 {id, movement_type, qty, consumed, created_at, source_doc_type,
 *                  source_doc_no, total_cost_sen, do_status, do_dropship}
 * @param {Array}  p.openLots   lots with qty_remaining > 0: {id, qty_remaining, unit_cost_sen, received_at}
 * @param {number} p.onHandQty  the bucket's qty as inventory_balances shows it
 * @param {object|null} p.basis pickCostBasis() result, or null when not looked up
 * @param {boolean} p.allowBasis the owner named this warehouse for a reference-cost seed
 * @returns {{status: 'repair'|'nothing'|'needs-basis'|'refused', reasons: string[],
 *            targets: Array, refused: Array, lotsAfter: Array, after: {qty:number, valueSen:number},
 *            before: {qty:number, valueSen:number}, basisUnits: number, addedSen: number}}
 */
export function planBucketRepair({ consumers, openLots, onHandQty, basis, allowBasis }) {
  const reasons = [];
  const short = consumers
    .filter((m) => isConsumingMovement(m.movement_type, m.qty) && outstandingQty(m) > 0)
    .sort(byTimeThenId("created_at", "created_at"));
  const refused = [];
  const eligible = [];
  for (const m of short) {
    const why = refusalFor(m);
    if (why) refused.push({ id: m.id, doc: m.source_doc_no ?? null, outstanding: outstandingQty(m), why });
    else eligible.push(m);
  }

  const lots = openLots
    .filter((l) => Number(l.qty_remaining) > 0)
    .map((l) => ({ ...l, left: Number(l.qty_remaining), unitCostSen: Number(l.unit_cost_sen ?? 0) }))
    .sort(byTimeThenId("received_at", "received_at"));
  const valueOf = (ls) => ls.reduce((s, l) => s + l.left * l.unitCostSen, 0);
  const before = { qty: Number(onHandQty ?? 0), valueSen: valueOf(lots) };

  // 0154 order: oldest short first, oldest lot first.
  const targets = [];
  let residualTotal = 0;
  for (const m of eligible) {
    let need = outstandingQty(m);
    const takes = [];
    for (const l of lots) {
      if (need <= 0) break;
      if (l.left <= 0) continue;
      const take = Math.min(l.left, need);
      l.left -= take;
      need -= take;
      takes.push({ lotId: l.id, qty: take, unitCostSen: l.unitCostSen, costSen: take * l.unitCostSen });
    }
    targets.push({ m, takes, residual: need });
    residualTotal += need;
  }

  let basisUnits = 0;
  const basisUsable = basis && basis.source != null && Number(basis.unitCostSen) > 0;
  if (residualTotal > 0) {
    if (!allowBasis) {
      reasons.push(`${residualTotal} unit(s) have no open lot to draw on — ${basisUsable
        ? `proposed: cost them at the reference basis (${basis.source} ${basis.docNo}); re-run PLAN with this warehouse in ALLOW_BASIS_WAREHOUSE_IDS to bind it`
        : "and no GRN/PO carries a nonzero cost for this item, so there is no honest basis (owner decision)"}`);
    } else if (!basisUsable) {
      reasons.push(`${residualTotal} unit(s) have no open lot and no GRN/PO carries a nonzero cost for this item — no honest basis exists (owner decision)`);
    } else {
      for (const t of targets) {
        if (t.residual <= 0) continue;
        const u = Number(basis.unitCostSen);
        t.takes.push({ lotId: "BASIS", qty: t.residual, unitCostSen: u, costSen: t.residual * u });
        basisUnits += t.residual;
        t.residual = 0;
      }
      residualTotal = 0;
    }
  }

  const planned = targets.map(({ m, takes, residual }) => {
    const addedSen = takes.reduce((s, x) => s + x.costSen, 0);
    const oldTotal = Number(m.total_cost_sen ?? 0);
    const absQty = Math.abs(Number(m.qty));
    const newTotal = oldTotal + addedSen;
    return {
      movementId: m.id,
      movementType: String(m.movement_type).toUpperCase(),
      doc: m.source_doc_no ?? null,
      docType: m.source_doc_type ?? null,
      qty: absQty,
      outstanding: outstandingQty(m),
      takes,
      residual,
      addedSen,
      oldTotalSen: oldTotal,
      // Same arithmetic as 0154: (old + added) / |qty|, integer division, only
      // when something was added.
      newTotalSen: addedSen > 0 ? newTotal : oldTotal,
      newUnitSen: addedSen > 0 ? (absQty > 0 ? Math.trunc(newTotal / absQty) : 0) : Number(m.unit_cost_sen ?? 0),
    };
  });

  const lotsAfter = lots.map((l) => ({ id: l.id, before: Number(l.qty_remaining), after: l.left, unitCostSen: l.unitCostSen }));
  const after = { qty: before.qty, valueSen: valueOf(lots) };
  const addedSen = planned.reduce((s, t) => s + t.addedSen, 0);

  if (refused.length) reasons.push(`${refused.length} short movement(s) are not this repair's to cost: ${refused.map((r) => `${r.id} (${r.doc ?? "no doc"}) — ${r.why}`).join("; ")}`);
  if (after.qty !== 0) reasons.push(`after the repair this warehouse would still show qty ${after.qty} (this repair moves no quantity; the target is qty 0)`);
  if (after.valueSen !== 0) reasons.push(`after the repair open lots would still hold ${lotsAfter.filter((l) => l.after > 0).reduce((s, l) => s + l.after, 0)} unit(s) of value (the target is value 0)`);

  let status;
  if (eligible.length === 0 && refused.length === 0) {
    status = before.valueSen === 0 && before.qty === 0 ? "nothing" : "refused";
    if (status === "refused") reasons.push("no uncosted OUT exists in this bucket to absorb the open-lot value — this is not an uncosted-OUT problem");
  } else if (refused.length || after.qty !== 0 || after.valueSen !== 0) {
    status = "refused";
  } else if (residualTotal > 0) {
    status = "needs-basis";
  } else {
    status = "repair";
  }
  return { status, reasons, targets: planned, refused, lotsAfter, before, after, basisUnits, addedSen };
}

/** A short, stable hash of everything an APPLY would write for this bucket and
 *  of the state it was computed from. APPLY recomputes it inside the
 *  transaction under row locks and refuses unless it equals the one PLAN printed,
 *  so nothing can be written that the owner did not see. */
export function planFingerprint({ companyId, warehouseId, itemCode, variantKey, plan, basis }) {
  const canonical = {
    companyId: Number(companyId),
    warehouseId: String(warehouseId),
    itemCode: String(itemCode),
    variantKey: String(variantKey ?? ""),
    status: plan.status,
    before: plan.before,
    after: plan.after,
    lots: plan.lotsAfter.map((l) => [l.id, l.before, l.after, l.unitCostSen]),
    targets: plan.targets.map((t) => [t.movementId, t.qty, t.outstanding, t.oldTotalSen, t.newTotalSen, t.takes.map((x) => [x.lotId, x.qty, x.unitCostSen])]),
    refused: plan.refused.map((r) => [r.id, r.outstanding]),
    basis: plan.basisUnits > 0 && basis ? [basis.source, basis.docNo ?? null, Number(basis.unitCostSen)] : null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

/** Parse and validate the script's KEY=VALUE inputs. Returns errors instead of
 *  throwing so the script can print all of them at once. */
export function parseNamedRepairEnv(env) {
  const errors = [];
  const list = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const companyId = Number(env.COMPANY_ID);
  if (!Number.isInteger(companyId) || companyId <= 0) errors.push("COMPANY_ID is required (a positive integer, e.g. 1)");
  const itemCode = String(env.ITEM_CODE ?? "").trim();
  if (!itemCode) errors.push("ITEM_CODE is required (the exact item code)");
  const variantKey = String(env.VARIANT_KEY ?? "");
  const warehouseIds = [...new Set(list(env.WAREHOUSE_IDS).map((s) => s.toLowerCase()))];
  if (warehouseIds.length === 0) errors.push("WAREHOUSE_IDS is required (comma-separated warehouse uuids)");
  for (const w of warehouseIds) if (!uuid.test(w)) errors.push(`WAREHOUSE_IDS: "${w}" is not a uuid`);
  const allowBasis = new Set(list(env.ALLOW_BASIS_WAREHOUSE_IDS).map((s) => s.toLowerCase()));
  for (const w of allowBasis) if (!warehouseIds.includes(w)) errors.push(`ALLOW_BASIS_WAREHOUSE_IDS: "${w}" is not one of WAREHOUSE_IDS`);
  const planHashes = new Set(list(env.PLAN_HASHES).map((s) => s.toLowerCase()));
  for (const h of planHashes) if (!/^[0-9a-f]{12}$/.test(h)) errors.push(`PLAN_HASHES: "${h}" is not a 12-character plan hash`);
  return { errors, companyId, itemCode, variantKey, warehouseIds, allowBasis, planHashes };
}

/** The 32-bit xid Postgres stores in xmin, from a pg_current_xact_id() value
 *  (64-bit, epoch-extended). Rows this transaction wrote carry it until the
 *  next write to them, which is how the verification proves no other row moved. */
export function xminOf(fullXid) {
  return (BigInt(String(fullXid)) % 4294967296n).toString();
}

/** Compare the rows a committed transaction wrote (read back by xmin) with the
 *  rows the plan said it would write. Returns a list of problems; empty = exact. */
export function checkWrittenRows({ written, expected, companyId, warehouseId, itemCode }) {
  const problems = [];
  for (const r of written) {
    if (String(r.item_code) !== String(itemCode)) problems.push(`${r.t} ${r.id} is item "${r.item_code}", not "${itemCode}"`);
    if (String(r.warehouse_id).toLowerCase() !== String(warehouseId).toLowerCase()) problems.push(`${r.t} ${r.id} is in warehouse ${r.warehouse_id}, not ${warehouseId}`);
    if (Number(r.company_id) !== Number(companyId)) problems.push(`${r.t} ${r.id} is company ${r.company_id}, not ${companyId}`);
  }
  for (const t of ["lot", "consumption", "movement"]) {
    const got = new Set(written.filter((r) => r.t === t).map((r) => String(r.id)));
    const want = new Set((expected[t] ?? []).map(String));
    for (const id of got) if (!want.has(id)) problems.push(`${t} ${id} was written but is not in the plan`);
    for (const id of want) if (!got.has(id)) problems.push(`${t} ${id} is in the plan but does not carry this transaction's xid (not written, or touched again since)`);
  }
  return problems;
}
