/* hard-bound-cost-check — the pure half of check-hard-bound-cost-vs-lot.mjs.
 *
 * Company 1 binds a bedframe / sofa / fabric accessory / dining / (SP) mattress
 * sales line to the purchase line raised for it (isHardBoundLine,
 * src/scm/lib/so-stock-allocation.ts). Readiness follows that binding. Cost does
 * not: a non-sofa DO OUT is written with no batch_no, so the FIFO trigger
 * (fn_inventory_movement_fifo -> fn_consume_fifo) and the uncosted-OUT reconcile
 * (fn_reconcile_uncosted_out) take the oldest open lot of the same warehouse +
 * item + variant_key, whichever purchase order it came from. This module answers,
 * per DO line, whether the lot that costed it belongs to the line's bound PO.
 *
 * Nothing here reads a database or prints money: costs come in as numbers and
 * leave only as a ratio.
 */

export const DEFAULT_REF_PREFIX = 'CUTOVER-NOSPEC-';

/* A cutover layer's movement note names the AutoCount document it was relayered
   from: `AC GR GR-004679 2026-05-28` (import-ac-stock-layers.mjs). */
export function parseAcDoc(notes) {
  const m = /^\s*AC\s+([A-Z]+)\s+(\S+)/.exec(String(notes ?? ''));
  if (!m || m[1] === 'layer') return null;
  return { src: m[1], doc: m[2] };
}

/* A migrated GRN mirrors one AutoCount GR and is numbered after it:
   HC-GR-005313-PO-010005 or HC-GR-005233 (its linked_ac_docno holds the AC PO). */
export function acGrOfMigratedGrn(grnNumber) {
  const m = /^HC-(GR-\d+)(?:-|$)/.exec(String(grnNumber ?? ''));
  return m ? m[1] : null;
}

/* The repair opened one lot per source lot it moved, at the source lot's cost,
   with received_at = source received_at + i microseconds (i = its order within
   the fix). The pairing is not stored, so it is re-derived from that shape:
   same warehouse + item + repair document, same qty, same unit cost, received
   within 1 ms after the source. `receivedUs` are microsecond epochs as strings. */
export function originCandidates(minted, fromSide) {
  const at = BigInt(minted.receivedUs);
  return fromSide.filter((c) => {
    if (c.warehouseId !== minted.warehouseId || c.itemCode !== minted.itemCode || c.refDocNo !== minted.refDocNo) return false;
    if (Number(c.qtyConsumed) !== Number(minted.qtyReceived)) return false;
    if (Number(c.unitCostSen) !== Number(minted.unitCostSen)) return false;
    const d = at - BigInt(c.receivedUs);
    return d >= 0n && d < 1000n;
  });
}

/* The POs a costing lot belongs to.
   - a GRN lot: its batch_no (= the source PO number since migration 0120), else
     the GRN header's PO;
   - an AutoCount cutover layer: the PO of the migrated GRN that mirrors the AC
     GR its note names (acGrOfMigratedGrn);
   - anything else (stock-take adjustment, return): no PO. */
export function lotPos(lot, poByGrnId, poByAcDoc) {
  const pos = new Set();
  const type = String(lot.sourceDocType ?? '').toUpperCase();
  if (lot.batchNo) pos.add(lot.batchNo);
  if (type === 'GRN' && lot.sourceDocId && poByGrnId.get(lot.sourceDocId)) pos.add(poByGrnId.get(lot.sourceDocId));
  if (type === 'AC_CUTOVER') {
    const ac = parseAcDoc(lot.movementNotes);
    for (const po of (ac ? poByAcDoc.get(ac.doc) ?? [] : [])) pos.add(po);
  }
  return [...pos].sort();
}

export const VERDICTS = [
  ['match', 'every costed unit came from a lot of the bound PO'],
  ['partial', 'some costed units came from the bound PO, some from other lots'],
  ['mismatch', 'the costing lot belongs to another PO'],
  ['lot-po-unknown', 'the costing lot names no PO (unlinked cutover layer, stock take, return)'],
  ['no-bound-po', 'hard-bound line with no live received PO bound to its SO line'],
  ['uncosted', 'hard-bound line whose OUT consumed no lot'],
  ['pooled-fifo', 'not a hard-bound line: FIFO from any lot is the rule, no binding to check'],
];

/* costing: [{ qty, pos: string[] }] — one per consumed lot. */
export function classifyLine({ hardBound, boundPoNos, costing }) {
  if (!hardBound) return { verdict: 'pooled-fifo', matchQty: 0, otherQty: 0, unknownQty: 0 };
  const bound = new Set(boundPoNos);
  let matchQty = 0; let otherQty = 0; let unknownQty = 0;
  for (const c of costing) {
    const q = Number(c.qty);
    if (c.pos.some((p) => bound.has(p))) matchQty += q;
    else if (c.pos.length) otherQty += q;
    else unknownQty += q;
  }
  const total = matchQty + otherQty + unknownQty;
  let verdict;
  if (bound.size === 0) verdict = 'no-bound-po';
  else if (total === 0) verdict = 'uncosted';
  else if (matchQty === total) verdict = 'match';
  else if (matchQty > 0) verdict = 'partial';
  else if (otherQty > 0) verdict = 'mismatch';
  else verdict = 'lot-po-unknown';
  return { verdict, matchQty, otherQty, unknownQty };
}

/* What hard binding says one unit should cost, first source with quantity wins:
   the bound PO's own GRN lots (already recosted to the PI price by recost.ts),
   then the cutover layers relayered from the bound PO's AutoCount receipt, then
   the PO line price. Each source: [{ qty, unitCostSen }]. */
export function expectedUnitCost({ grnLots, cutoverLayers, poLines }) {
  for (const [source, rows] of [['grn-lot', grnLots], ['cutover-layer', cutoverLayers], ['po-price', poLines]]) {
    let q = 0; let amt = 0;
    for (const r of rows ?? []) {
      const n = Number(r.qty); const c = Number(r.unitCostSen);
      if (!(n > 0) || !(c > 0)) continue;
      q += n; amt += n * c;
    }
    if (q > 0) return { source, unitSen: amt / q };
  }
  return { source: 'none', unitSen: null };
}

/* Actual over expected, as a percentage with one decimal ("100.0%"), never an
   amount. A two-decimal plain number would also be hidden by public-log-guard. */
export function costRatio(actualTotalSen, actualQty, expectedUnitSen) {
  const q = Number(actualQty);
  if (!(q > 0) || !(Number(expectedUnitSen) > 0)) return '-';
  return `${((Number(actualTotalSen) / q / Number(expectedUnitSen)) * 100).toFixed(1)}%`;
}

/* Whole-percent comparison: within 0.5% reads as the same cost. */
export function sameCost(ratio) {
  if (ratio === '-') return null;
  return Math.abs(Number.parseFloat(ratio) - 100) < 0.5;
}

export function tally(items, keyFn) {
  const m = new Map();
  for (const it of items) { const k = keyFn(it); m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

export function parseDocNos(raw) {
  return [...new Set(String(raw ?? '').split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9][A-Z0-9-]*$/.test(s)))];
}
