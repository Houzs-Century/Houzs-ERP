// ----------------------------------------------------------------------------
// ship-commitment — the two halves of "this shipment already owns those units".
//
// THE FACT, in the owner's words (2026-07-31): "Before raising the DO you
// already know which PO this order matched. When they pick ship-anyway, that
// matched PO should be bound and go negative against it."
//
// Binding used to hang off the drop-ship DIALOG: only a confirmed `dropShip`
// stamped the expected batch onto the OUT, and only `delivery_orders.is_dropship`
// let scm.fn_reconcile_dropship_batch claim it on receipt. A plain "Ship anyway"
// on a line that HAS a resolvable incoming PO therefore shipped un-bound — the
// receipt could never net it, and the units stayed at RM0 forever.
//
// This module holds the two PURE decisions that follow from the fact, with no
// database in either:
//
//   1. planShipCommitments — per DO line, does shipping it right now COMMIT an
//      incoming PO batch? (writes delivery_order_items.committed_po_batch_no)
//   2. outstandingCommitments + applyCommittedSupply — the MRP side: units a
//      shipment already owns must not be offered to a second Sales Order.
//
// They MUST agree on what "still committed" means, which is why they live in
// one file: the definition is `ABS(out.qty) - SUM(qty_consumed) > 0` on a
// claimable OUT — byte-for-byte the shortfall the SQL reconcile recomputes. As
// the receipt nets a shipment, the same subtraction drops it out of the MRP
// deduction. Nothing has to be un-set.
// ----------------------------------------------------------------------------

/* ── 1. SHIP TIME — does this line bind an incoming PO? ────────────────────── */

export type ShipCommitmentReason =
  /** qty <= 0 (a cancelled / zeroed line) — nothing ships, nothing binds. */
  | 'no_qty'
  /** No SO line behind it (ad-hoc manual line) — there is no PO to resolve. */
  | 'no_so_link'
  /** The allocator already locked a PHYSICALLY RECEIVED batch: a normal ship. */
  | 'allocated_batch'
  /** No single live bound PO (none, or >1 so the batch is ambiguous — audit H3). */
  | 'no_po'
  /** Non-sofa line with stock on hand: plain FIFO must keep costing those units. */
  | 'stock_on_hand'
  /** Sofa with no received batch — a supplier-direct ship against the bound PO. */
  | 'sofa_before_arrival'
  /** Nothing on hand at all: every shipped unit comes from the bound PO. */
  | 'short_before_arrival';

export type ShipLineFact = {
  /** Caller's handle for this line (DO line index, or its id on an edit). */
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  variantKey: string;
  warehouseId: string | null;
  /** Sofa (or any batch-regime SKU): its OUT is batch-scoped by construction. */
  isSofa: boolean;
  /** mfg_sales_order_items.allocated_batch_no — set ONLY once a covering batch
   *  is physically received, so a non-null value means this is a normal ship. */
  allocatedBatchNo: string | null;
  /** The single live bound PO number (= the batch_no the GRN will stamp), from
   *  resolveExpectedBatchBySoItem in 'block' mode. null = none, or ambiguous. */
  expectedBatchNo: string | null;
  /** Live on-hand qty in this (warehouse, item, variant) bucket at ship time. */
  availableQty: number;
  shipQty: number;
};

export type ShipCommitmentDecision = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  bind: boolean;
  /** The committed incoming-PO batch; null whenever bind is false. */
  batchNo: string | null;
  reason: ShipCommitmentReason;
};

/** Decide, per line, whether shipping it now commits an incoming PO's batch.
 *
 *  BINDING IS A CONSEQUENCE, NOT A QUESTION. The operator answers "the goods
 *  are not here — ship anyway?" once; whether that shipment binds a PO is a
 *  property of the line, decided here.
 *
 *  The one case deliberately NOT bound is a PARTIAL short on a plain-FIFO line
 *  (availableQty between 1 and shipQty-1). Stamping a batch on that OUT would
 *  route the whole row through fn_consume_fifo_batch, which sees no lot for a
 *  batch that has not arrived — so the units that WERE on hand would stop being
 *  costed at ship time. Its shortfall is still repaired by the oversell
 *  retro-cost (fn_reconcile_uncosted_out, 0154), which is batch-agnostic and now
 *  runs on every stock-IN path. Losing real ship-time cost to gain a batch stamp
 *  is a bad trade; a full short (nothing on hand) loses nothing. */
export function planShipCommitments(lines: ShipLineFact[]): ShipCommitmentDecision[] {
  return lines.map((l) => {
    const base = { lineRef: l.lineRef, soItemId: l.soItemId, itemCode: l.itemCode };
    const no = (reason: ShipCommitmentReason): ShipCommitmentDecision =>
      ({ ...base, bind: false, batchNo: null, reason });

    if (!(Number(l.shipQty) > 0)) return no('no_qty');
    if (!l.soItemId) return no('no_so_link');
    if (l.allocatedBatchNo) return no('allocated_batch');
    if (!l.expectedBatchNo) return no('no_po');
    if (l.isSofa) {
      return { ...base, bind: true, batchNo: l.expectedBatchNo, reason: 'sofa_before_arrival' };
    }
    if (Number(l.availableQty) > 0) return no('stock_on_hand');
    return { ...base, bind: true, batchNo: l.expectedBatchNo, reason: 'short_before_arrival' };
  });
}

/* ── 2. MRP TIME — units a shipment already owns are not free supply ───────── */

/** One OUT movement that carries an incoming-PO batch stamp, plus everything
 *  needed to decide whether the receipt-time reconcile can still claim it. */
export type CommittedShipmentRow = {
  /** `${warehouseId}|${itemCode}|${variantKey}` — the MRP bucket the OUT sits in. */
  bucketKey: string;
  /** = the PO number the GRN will stamp. */
  batchNo: string;
  /** ABS(inventory_movements.qty). */
  outQty: number;
  /** SUM(inventory_lot_consumptions.qty_consumed) for this movement. */
  consumedQty: number;
  /** The source DO is CANCELLED — its OUT was reversed, it owns nothing. */
  cancelled: boolean;
  /** delivery_orders.is_dropship (the legacy whole-header claim signal). */
  headerDropship: boolean;
  /** A delivery_order_items row on this DO carries committed_po_batch_no =
   *  batchNo for this product (the per-LINE claim signal this change adds). */
  lineCommitted: boolean;
};

/** `${bucketKey}|${batchNo}` — the identity a commitment and a PO line share. */
export const commitmentKey = (bucketKey: string, batchNo: string): string =>
  `${bucketKey}|${batchNo}`;

/** Fold OUT movements into "units still owed to a shipment", keyed by
 *  (bucket, batch).
 *
 *  CLAIMABILITY IS THE SAME TEST THE SQL USES. scm.fn_reconcile_dropship_batch
 *  claims an OUT when the source DO is not cancelled AND (is_dropship OR one of
 *  its lines is committed to this batch). An OUT the reconcile can never claim
 *  is not a commitment — it is a plain oversell, and deducting it here would
 *  take supply away from MRP that nothing will ever hand back.
 *
 *  The outstanding figure is `ABS(qty) - consumed`, recomputed from the ledger
 *  exactly like the reconcile: the moment the receipt nets a shipment the
 *  consumptions land, the difference goes to 0, and the deduction disappears on
 *  its own. That is what makes double-deduction structurally impossible rather
 *  than merely avoided. */
export function outstandingCommitments(rows: CommittedShipmentRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.cancelled) continue;
    if (!r.headerDropship && !r.lineCommitted) continue;
    const short = Math.max(0, Number(r.outQty ?? 0) - Number(r.consumedQty ?? 0));
    if (short <= 0) continue;
    const k = commitmentKey(r.bucketKey, r.batchNo);
    out.set(k, (out.get(k) ?? 0) + short);
  }
  return out;
}

/** One open PO line's remaining supply, as MRP pools it. */
export type PoSupplyEntry = {
  bucketKey: string;
  poNumber: string;
  eta: string | null;
  qtyLeft: number;
  supplierId: string | null;
};

export type CommittedSupplyResult = {
  /** Entries with the committed units removed; fully-committed entries dropped. */
  entries: PoSupplyEntry[];
  /** Units to ADD BACK to the bucket's on-hand figure, per bucketKey. */
  stockAddBack: Map<string, number>;
  /** Committed units with no open PO line left to deduct from (already fully
   *  received, or the PO went dead). Reported, never silently dropped. */
  unmatched: Map<string, number>;
};

/** Remove already-committed units from the incoming-PO pool — and ADD THE SAME
 *  UNITS BACK to on-hand stock.
 *
 *  ⚠ THE ADD-BACK IS NOT A NICETY, IT IS WHAT KEEPS THE TOTAL HONEST. A
 *  ship-before-arrival writes a real OUT movement, so scm.inventory_balances
 *  (SUM of IN - OUT, migration 0084) has ALREADY gone down by those units — the
 *  ledger deducts the commitment on the STOCK side. Deducting it a second time
 *  from PO supply would understate total availability by exactly the committed
 *  qty and invent a shortage that does not exist. So this pairs the two: the
 *  units leave the PO pool (where they were free supply the reconcile is going
 *  to take) and return to the stock figure (where the ledger had already taken
 *  them). Net availability is unchanged; what changes is that the commitment is
 *  now ATTRIBUTED to the PO that owes it instead of being a nameless negative
 *  that silently taxes whichever Sales Order happens to sort first in the bucket.
 *
 *  Add-back and deduction are always the SAME number in the SAME bucket, so the
 *  pairing cannot drift. A commitment whose PO has no open units left is
 *  reported in `unmatched` and changes nothing. */
export function applyCommittedSupply(
  entries: PoSupplyEntry[],
  committed: Map<string, number>,
): CommittedSupplyResult {
  const pool = new Map(committed);
  const stockAddBack = new Map<string, number>();
  const out: PoSupplyEntry[] = [];

  for (const e of entries) {
    const k = commitmentKey(e.bucketKey, e.poNumber);
    const owed = pool.get(k) ?? 0;
    if (owed <= 0) {
      if (e.qtyLeft > 0) out.push(e);
      continue;
    }
    const take = Math.min(owed, e.qtyLeft);
    pool.set(k, owed - take);
    if (take > 0) {
      stockAddBack.set(e.bucketKey, (stockAddBack.get(e.bucketKey) ?? 0) + take);
    }
    const left = e.qtyLeft - take;
    if (left > 0) out.push({ ...e, qtyLeft: left });
  }

  const unmatched = new Map<string, number>();
  for (const [k, v] of pool) if (v > 0) unmatched.set(k, v);
  return { entries: out, stockAddBack, unmatched };
}
