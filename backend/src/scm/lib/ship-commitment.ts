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

import { sofaSetKey } from '../shared/sofa-set-identity';


export type ShipCommitmentReason =
  | 'no_qty'
  | 'no_so_link'
  | 'allocated_batch'
  | 'no_po'
  | 'stock_on_hand'
  | 'prior_ship_other_batch'
  | 'sofa_before_arrival'
  | 'short_before_arrival';

export type ShipLineFact = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  variantKey: string;
  warehouseId: string | null;
  isSofa: boolean;
  allocatedBatchNo: string | null;
  expectedBatchNo: string | null;
  availableQty: number;
  shipQty: number;
  priorShippedQty?: number;
  priorBatchNo?: string | null;
};

export type ShipCommitmentDecision = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  bind: boolean;
  batchNo: string | null;
  strictBatch: boolean;
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
 *  is a bad trade; a full short (nothing on hand) loses nothing.
 *
 *  ⚠ BINDING A NON-SOFA LINE MUST NOT COST IT THE FALLBACK REPAIR. A mattress
 *  has no dye lot, so `strictBatch` is FALSE for it and migration 0230 leaves
 *  its OUT visible to fn_reconcile_uncosted_out. That matters because the bound
 *  PO can die in ways nothing here can see — cancelled, re-raised under a new
 *  number, or superseded by an inter-warehouse transfer or a stock take. On a
 *  strict-batch line (sofa) that is accepted: substituting another dye lot is
 *  the colour-mixing the whole batch regime exists to prevent, and 0154 has
 *  excluded is_dropship sofa OUTs since it shipped. On a plain-FIFO line it
 *  would be a NEW way to strand COGS at RM0 forever, which is the exact bug
 *  this change exists to end. */
export function planShipCommitments(lines: ShipLineFact[]): ShipCommitmentDecision[] {
  return lines.map((l) => {
    const base = { lineRef: l.lineRef, soItemId: l.soItemId, itemCode: l.itemCode };
    const no = (reason: ShipCommitmentReason): ShipCommitmentDecision =>
      ({ ...base, bind: false, batchNo: null, strictBatch: false, reason });
    const yes = (reason: ShipCommitmentReason): ShipCommitmentDecision => {
      if (Number(l.priorShippedQty ?? 0) > 0 && (l.priorBatchNo ?? null) !== l.expectedBatchNo) {
        return no('prior_ship_other_batch');
      }
      return { ...base, bind: true, batchNo: l.expectedBatchNo, strictBatch: l.isSofa, reason };
    };

    if (!(Number(l.shipQty) > 0)) return no('no_qty');
    if (!l.soItemId) return no('no_so_link');
    if (l.allocatedBatchNo) return no('allocated_batch');
    if (!l.expectedBatchNo) return no('no_po');
    if (l.isSofa) return yes('sofa_before_arrival');
    if (Number(l.availableQty) > 0) return no('stock_on_hand');
    return yes('short_before_arrival');
  });
}


/** One module of a sofa set, paired with the decision planShipCommitments made
 *  for it and the batch the allocator had already locked. */
export type SofaSetModule = {
  lineRef: string;
  soDocNo: string | null;
  itemCode: string;
  isSofa: boolean;
  allocatedBatchNo: string | null;
  boundBatchNo: string | null;
};

export type SofaSetPoConflict = {
  soDocNo: string;
  modules: Array<{ itemCode: string; lineRef: string; batchNo: string | null }>;
  batchNos: string[];
};

/** Refuse a sofa SET that would ship under MORE THAN ONE batch.
 *
 *  OWNER, 2026-07-31: "同一张 batch no 就是 PO" — one PO IS one batch number, and
 *  a sofa set is one dye lot. The pre-existing gate (`allHavePo`) only checked
 *  that every module has *a* PO; it never checked they are the SAME one, so two
 *  modules resolving two POs were stamped with two batch numbers and the set was
 *  silently split across dye lots — the precise thing the batch regime exists to
 *  prevent, arrived at through the door that was supposed to protect it.
 *
 *  SCOPE, DELIBERATELY NARROW. Only sets where THIS write would commit at least
 *  one module are examined. A set shipping normally out of one received batch
 *  binds nothing and is untouched, so this can only ever refuse a shipment that
 *  the change itself would have bound — it cannot break a flow that works today.
 *  A module with no batch at all counts as its own participant: shipping it
 *  un-batched means plain FIFO picks its lot, which is a split by another name. */
export function planSofaSetPoConflicts(modules: SofaSetModule[]): SofaSetPoConflict[] {
  const bySet = new Map<string, { soDocNo: string; set: SofaSetModule[] }>();
  for (const m of modules) {
    if (!m.isSofa || !m.soDocNo) continue;
    const key = sofaSetKey(m.soDocNo, m.itemCode);
    const entry = bySet.get(key) ?? { soDocNo: m.soDocNo, set: [] };
    entry.set.push(m);
    bySet.set(key, entry);
  }

  const out: SofaSetPoConflict[] = [];
  for (const { soDocNo, set } of bySet.values()) {
    if (!set.some((m) => m.boundBatchNo)) continue;
    const effective = set.map((m) => ({
      itemCode: m.itemCode,
      lineRef: m.lineRef,
      batchNo: m.boundBatchNo ?? m.allocatedBatchNo ?? null,
    }));
    const distinct = [...new Set(effective.map((e) => e.batchNo ?? ''))].sort();
    if (distinct.length <= 1) continue;
    out.push({
      soDocNo,
      modules: effective,
      batchNos: distinct.filter(Boolean),
    });
  }
  return out;
}


/** One OUT movement that carries an incoming-PO batch stamp, plus everything
 *  needed to decide whether the receipt-time reconcile can still claim it. */
export type CommittedShipmentRow = {
  bucketKey: string;
  warehouseId: string | null;
  itemCode: string;
  variantKey: string;
  batchNo: string;
  outQty: number;
  consumedQty: number;
  cancelled: boolean;
  headerDropship: boolean;
  lineCommitted: boolean;
};

/** `${bucketKey}|${batchNo}` — the identity a commitment and a PO line share.
 *  Opaque: never split it back apart (variant keys contain '|'). Everything a
 *  reader needs is carried in the VALUE, see OutstandingCommitment. */
export const commitmentKey = (bucketKey: string, batchNo: string): string =>
  `${bucketKey}|${batchNo}`;

/** Units one (bucket, batch) pair still owes a shipment, with the bucket spelled
 *  out so a caller can report it without parsing the key. */
export type OutstandingCommitment = {
  bucketKey: string;
  warehouseId: string | null;
  itemCode: string;
  variantKey: string;
  batchNo: string;
  qty: number;
};

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
export function outstandingCommitments(
  rows: CommittedShipmentRow[],
): Map<string, OutstandingCommitment> {
  const out = new Map<string, OutstandingCommitment>();
  for (const r of rows) {
    if (r.cancelled) continue;
    if (!r.headerDropship && !r.lineCommitted) continue;
    const short = Math.max(0, Number(r.outQty ?? 0) - Number(r.consumedQty ?? 0));
    if (short <= 0) continue;
    const k = commitmentKey(r.bucketKey, r.batchNo);
    const cur = out.get(k);
    if (cur) cur.qty += short;
    else out.set(k, {
      bucketKey: r.bucketKey,
      warehouseId: r.warehouseId ?? null,
      itemCode: r.itemCode,
      variantKey: r.variantKey,
      batchNo: r.batchNo,
      qty: short,
    });
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
  entries: PoSupplyEntry[];
  stockAddBack: Map<string, number>;
  unmatched: OutstandingCommitment[];
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
  committed: Map<string, OutstandingCommitment>,
): CommittedSupplyResult {
  const pool = new Map<string, OutstandingCommitment>();
  for (const [k, v] of committed) pool.set(k, { ...v });
  const stockAddBack = new Map<string, number>();
  const out: PoSupplyEntry[] = [];

  for (const e of entries) {
    const k = commitmentKey(e.bucketKey, e.poNumber);
    const owed = pool.get(k);
    if (!owed || owed.qty <= 0) {
      if (e.qtyLeft > 0) out.push(e);
      continue;
    }
    const take = Math.min(owed.qty, e.qtyLeft);
    owed.qty -= take;
    if (take > 0) {
      stockAddBack.set(e.bucketKey, (stockAddBack.get(e.bucketKey) ?? 0) + take);
    }
    const left = e.qtyLeft - take;
    if (left > 0) out.push({ ...e, qtyLeft: left });
  }

  const unmatched = [...pool.values()].filter((u) => u.qty > 0);
  return { entries: out, stockAddBack, unmatched };
}
