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
  /** The allocator found no incoming supply for this bucket (pre-PR-4: no
   *  single live bound PO, or >1 so the batch was ambiguous — audit H3). */
  | 'no_po'
  /** Non-sofa line with stock on hand: plain FIFO must keep costing those units. */
  | 'stock_on_hand'
  /** This line ALREADY shipped units into a different batch bucket (a PATCH
   *  qty-increase on a DO whose earlier units went out un-batched, or under
   *  another batch). Stamping now would re-bucket the whole line and force the
   *  resync to reverse a costed OUT — the temporal form of a partial short. */
  | 'prior_ship_other_batch'
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
  /** The incoming PO number the LIVE ALLOCATOR picked for this line (= the
   *  batch_no the GRN will stamp) — allocateExpectedBatches in
   *  do-live-allocator.ts, since the PR-4 flip (Decision 2026-08-06: soft
   *  until DO, hard from DO). null = no incoming supply resolves. The stored
   *  PO→SO raise-link (resolveExpectedBatchBySoItem) no longer feeds this
   *  field: it is procurement provenance, compared and logged only. */
  expectedBatchNo: string | null;
  /** Live on-hand qty in this (warehouse, item, variant) bucket at ship time. */
  availableQty: number;
  shipQty: number;
  /** Units of THIS DO line already moved OUT before this write. 0 (the default)
   *  on every create path; > 0 only on a PATCH qty-increase against a shipped
   *  DO, where the line's earlier units are already costed in some bucket. */
  priorShippedQty?: number;
  /** The batch those earlier units were stamped with, or null if un-batched. */
  priorBatchNo?: string | null;
};

export type ShipCommitmentDecision = {
  lineRef: string;
  soItemId: string | null;
  itemCode: string;
  bind: boolean;
  /** The committed incoming-PO batch; null whenever bind is false. */
  batchNo: string | null;
  /** Does this commitment carry a BATCH REGIME — i.e. is the batch a dye lot
   *  that must never be substituted (sofa)? It is the flag migration 0230
   *  stores as delivery_order_items.committed_batch_strict, and the ONLY thing
   *  that excludes an OUT from the batch-agnostic oversell retro-cost. False
   *  for a mattress / bedframe / accessory: those have no dye lot, so any later
   *  stock-IN may still repair their COGS exactly as it did before 0230. */
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
      /* A line that already shipped units elsewhere cannot be re-bucketed: the
         resync keys its delta on (warehouse, code, variant, BATCH), so a stamp
         added now would reverse the earlier costed OUT and re-issue the whole
         line against a batch that has not arrived. Binding to the SAME batch the
         earlier units carry is not a move, so it stays allowed. */
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

/* ── 1b. A SOFA SET BINDS ONE PO, NEVER ONE PER MODULE ─────────────────────── */

/** One module of a sofa set, paired with the decision planShipCommitments made
 *  for it and the batch the allocator had already locked. */
export type SofaSetModule = {
  lineRef: string;
  /** mfg_sales_order_items.doc_no — the SET's identity. A sofa set is "all the
   *  READY sofa lines of ONE Sales Order" (sofa-batch-guard.findIncompleteSofaSets),
   *  and the DO's own sofa lines for that doc_no are the modules being shipped. */
  soDocNo: string | null;
  itemCode: string;
  isSofa: boolean;
  /** mfg_sales_order_items.allocated_batch_no — a PHYSICALLY RECEIVED batch. */
  allocatedBatchNo: string | null;
  /** The batch this write would COMMIT the module to (planShipCommitments). */
  boundBatchNo: string | null;
};

export type SofaSetPoConflict = {
  soDocNo: string;
  /** Every module of the set, with the batch it would ship under (null = none,
   *  i.e. it would go out un-batched and be costed from any lot). */
  modules: Array<{ itemCode: string; lineRef: string; batchNo: string | null }>;
  /** The distinct batches the set is being split across, sorted. */
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
  const bySet = new Map<string, SofaSetModule[]>();
  for (const m of modules) {
    if (!m.isSofa || !m.soDocNo) continue;
    const arr = bySet.get(m.soDocNo) ?? [];
    arr.push(m);
    bySet.set(m.soDocNo, arr);
  }

  const out: SofaSetPoConflict[] = [];
  for (const [soDocNo, set] of bySet) {
    if (!set.some((m) => m.boundBatchNo)) continue; // nothing being bound here
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

/* ── 2. MRP TIME — units a shipment already owns are not free supply ───────── */

/** One OUT movement that carries an incoming-PO batch stamp, plus everything
 *  needed to decide whether the receipt-time reconcile can still claim it. */
export type CommittedShipmentRow = {
  /** `${warehouseId}|${itemCode}|${variantKey}` — the MRP bucket the OUT sits in. */
  bucketKey: string;
  /** The bucket's parts, carried alongside the key because the key CANNOT be
   *  parsed back: a variant key legitimately contains '|'
   *  ("fabriccode=bf-16|gap=16"), so splitting it is a bug waiting to happen. */
  warehouseId: string | null;
  itemCode: string;
  variantKey: string;
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
  /** Entries with the committed units removed; fully-committed entries dropped. */
  entries: PoSupplyEntry[];
  /** Units to ADD BACK to the bucket's on-hand figure, per bucketKey. */
  stockAddBack: Map<string, number>;
  /** Committed units with no open PO line left to deduct from — the PO is fully
   *  received, went CANCELLED/DRAFT, or the shipment landed in a different
   *  warehouse / variant bucket from the PO line that was supposed to cover it.
   *
   *  ⚠ THESE ARE THE ROWS MOST WORTH LOOKING AT, so they are RETURNED AS DATA,
   *  not merely "not silently dropped". Each one is a shipment the receipt-time
   *  reconcile is never going to net: the units left the shelf, nothing is
   *  arriving under that batch, and the COGS will sit at the fallback (or at
   *  RM0, if the line is strict-batch) until somebody looks. computeMrp surfaces
   *  them on the MRP payload and check-hard-committed-po.mjs prints them. */
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
