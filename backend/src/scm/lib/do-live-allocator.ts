// ----------------------------------------------------------------------------
// do-live-allocator — the DO-time incoming-batch pick, by the MRP rules.
//
// Decision (owner, 2026-08-06 — docs/modules/purchase-order.md §Decision):
// soft until DO, hard from DO. Before a Delivery Order exists, matching belongs
// to the floating allocator; at DO creation the allocator decides the binding
// LIVE and mig-0230 anchors it. This lib is that live decision for the
// ship-before-arrival case: WHICH incoming PO batch a shipping line commits to.
//
// The owner's tiebreak rules, verbatim:
//   supply side : earliest effective ETA first; equal ETA -> smaller PO number
//   demand side : delivery date first; equal date -> smaller doc number
//   ties are PICKED automatically and CONFIRMED by the operator in the existing
//   short-stock dialog — never a new refusal ("方案一…自动挑一张…确认").
//
// LIVE SINCE PR-4 (owner-gated flip; shadow first was the AUTOCOUNT_WRITES_
// DISABLED soak discipline). resolveShipCommitments (delivery-orders-mfg.ts)
// now binds the ALLOCATOR's pick: allocateExpectedBatches below decides, per
// shipping line, WHICH incoming PO batch a ship-before-arrival commits to —
// pooled supply minus what earlier shipments already own (subtractOutstanding
// over lib/committed-shipments' loader), demand walked in the owner's order.
// The stored PO→SO link (purchase_order_items.so_item_id / mig-0235 slices)
// is procurement provenance only and decides NOTHING here — it is compared
// and logged (BIND_SHADOW evidence rows) but never consulted for the pick.
//
// Same-batch-per-set is SOFA-ONLY (owner: "bedframe 是不需要的").
// ----------------------------------------------------------------------------

import { computeVariantKey, effectiveDelivery } from '../shared';
import type { OutstandingCommitment } from './ship-commitment';

/** One open PO line's remaining supply, bucketed the way MRP pools it. */
export type IncomingLine = {
  poNumber: string;
  itemCode: string;
  variantKey: string;
  warehouseId: string | null;
  qtyLeft: number;
  /** Effective ETA: MAX over the line's own dates, else the header's. */
  eta: string | null;
};

const bucketKey = (itemCode: string, variantKey: string) => `${itemCode}::${variantKey}`;

/* Supply-side order: earliest ETA first (null ETA LAST — an undated promise
   never outranks a dated one), then smaller PO number. Deterministic so two
   concurrent resolvers agree without talking to each other. */
const supplyOrder = (a: { eta: string | null; poNumber: string }, b: { eta: string | null; poNumber: string }): number => {
  if (a.eta !== b.eta) {
    if (a.eta == null) return 1;
    if (b.eta == null) return -1;
    return a.eta < b.eta ? -1 : 1;
  }
  return a.poNumber < b.poNumber ? -1 : a.poNumber > b.poNumber ? 1 : 0;
};

/** Pick the covering PO for ONE bucket: the first PO (by the supply order)
 *  whose remaining qty in this bucket covers `need`. Falls back to the first
 *  PO with ANY qty when none covers alone — partial cover is still a pick;
 *  the decision table's short/partial branches handle the remainder. */
export function pickIncomingForBucket(
  lines: IncomingLine[],
  itemCode: string,
  variantKey: string,
  need: number,
): { poNumber: string; eta: string | null; qtyLeft: number } | null {
  const pool = lines
    .filter((l) => l.itemCode === itemCode && l.variantKey === variantKey && l.qtyLeft > 0);
  if (pool.length === 0) return null;
  /* Aggregate per PO first — one PO can carry the bucket across several lines. */
  const byPo = new Map<string, { poNumber: string; eta: string | null; qtyLeft: number }>();
  for (const l of pool) {
    const cur = byPo.get(l.poNumber);
    if (cur) {
      cur.qtyLeft += l.qtyLeft;
      // The PO's ETA for ordering = the EARLIEST of its lines in this bucket.
      if (supplyOrder({ eta: l.eta, poNumber: l.poNumber }, { eta: cur.eta, poNumber: cur.poNumber }) < 0) cur.eta = l.eta;
    } else {
      byPo.set(l.poNumber, { poNumber: l.poNumber, eta: l.eta, qtyLeft: l.qtyLeft });
    }
  }
  const ordered = [...byPo.values()].sort(supplyOrder);
  return ordered.find((p) => p.qtyLeft >= need) ?? ordered[0];
}

/** Pick ONE PO covering a whole SOFA set (one dye lot per set — sofa only).
 *  `needs` is the set's demand per bucket. A candidate PO must cover EVERY
 *  bucket's need on its own lines; among candidates, earliest ETA (the
 *  earliest of its covering lines), then smaller PO number. Null when no
 *  single PO covers the set — the caller's conflict/dialog path takes over.
 *
 *  `preferPoNumber` (PR-4): when SOME modules of the set already hold a
 *  PHYSICALLY RECEIVED batch (allocated_batch_no), the remaining modules must
 *  ship under THAT batch or the set splits its dye lot — one PO IS one batch
 *  number (owner, 2026-07-31). So a preferred PO that fully covers the needs
 *  wins over an earlier-ETA alternative; a preferred PO that does NOT cover
 *  falls back to the normal order, and the sofa-set conflict gate stays the
 *  backstop for the split that produces. */
export function pickIncomingForSofaSet(
  lines: IncomingLine[],
  needs: Map<string, number>, // bucketKey -> qty
  preferPoNumber?: string | null,
): { poNumber: string; eta: string | null } | null {
  if (needs.size === 0) return null;
  const byPo = new Map<string, Map<string, number>>(); // po -> bucket -> qty
  const etaByPo = new Map<string, string | null>();
  for (const l of lines) {
    if (l.qtyLeft <= 0) continue;
    const k = bucketKey(l.itemCode, l.variantKey);
    if (!needs.has(k)) continue;
    const buckets = byPo.get(l.poNumber) ?? new Map<string, number>();
    buckets.set(k, (buckets.get(k) ?? 0) + l.qtyLeft);
    byPo.set(l.poNumber, buckets);
    const cur = etaByPo.has(l.poNumber) ? etaByPo.get(l.poNumber) ?? null : undefined;
    if (cur === undefined || supplyOrder({ eta: l.eta, poNumber: l.poNumber }, { eta: cur, poNumber: l.poNumber }) < 0) {
      etaByPo.set(l.poNumber, l.eta);
    }
  }
  const candidates: Array<{ poNumber: string; eta: string | null }> = [];
  for (const [po, buckets] of byPo) {
    let covers = true;
    for (const [k, need] of needs) {
      if ((buckets.get(k) ?? 0) < need) { covers = false; break; }
    }
    if (covers) candidates.push({ poNumber: po, eta: etaByPo.get(po) ?? null });
  }
  if (candidates.length === 0) return null;
  if (preferPoNumber) {
    const preferred = candidates.find((c) => c.poNumber === preferPoNumber);
    if (preferred) return preferred;
  }
  candidates.sort(supplyOrder);
  return candidates[0];
}

/* ── The fold (PR-4): units earlier shipments already own are not supply ─────
   A ship-before-arrival wrote a real OUT bound to a PO batch; the receipt is
   going to hand those units to THAT shipment (fn_reconcile_dropship_batch),
   not to this one. Subtract every outstanding commitment from the pool BEFORE
   picking, matched on the same (warehouse, itemCode, variantKey, batchNo)
   identity the SQL reconcile claims on, so committing the same incoming unit
   twice is structurally impossible rather than merely unlikely. The
   commitment map comes from lib/committed-shipments.loadCommittedShipments —
   the SAME loader computeMrp deducts with (one definition of "still
   committed", not two). A commitment that finds no pool line to subtract from
   (PO fully received / dead / other bucket) subtracts nothing — that is
   applyCommittedSupply's `unmatched` shape, and MRP already reports it. */
export function subtractOutstanding(
  lines: IncomingLine[],
  committed: Iterable<OutstandingCommitment>,
): IncomingLine[] {
  const out = lines.map((l) => ({ ...l }));
  for (const c of committed) {
    let left = Number(c.qty ?? 0);
    for (const l of out) {
      if (left <= 0) break;
      if (l.poNumber !== c.batchNo || l.itemCode !== c.itemCode || l.variantKey !== c.variantKey) continue;
      if ((l.warehouseId ?? null) !== (c.warehouseId ?? null)) continue;
      const take = Math.min(l.qtyLeft, left);
      l.qtyLeft -= take;
      left -= take;
    }
  }
  return out;
}

/* ── The pick itself (PR-4): one walk decides every line's expected batch ─── */

export type AllocatorDemandLine = {
  lineRef: string;
  itemCode: string;
  variantKey: string;
  shipQty: number;
  /** Sofa modules resolve as a whole SET (one dye lot); everything else per bucket. */
  isSofa: boolean;
  /** mfg_sales_order_items.doc_no — the sofa SET's identity AND the demand
   *  tiebreak (owner: "SO1 比 SO2 优先"). */
  soDocNo: string | null;
  /** A PHYSICALLY RECEIVED batch the stock allocator already locked. The line
   *  ships normally (it draws no incoming supply and gets NO pick here), but
   *  it anchors its sofa set's batch preference — the un-received siblings
   *  must follow it or the set splits. */
  allocatedBatchNo: string | null;
  /** Effective demand date: line delivery date, else the SO header's
   *  (mrp.ts §4 demand order — delivery date ascending, nulls LAST). */
  deliveryDate: string | null;
};

export type AllocatorPick = { poNumber: string; eta: string | null };

/* Demand-side order, the owner's rule verbatim: delivery date first (nulls
   last — an undated line never outranks a dated one), then smaller doc number,
   then lineRef for a stable total order. */
const demandOrder = (a: AllocatorDemandLine, b: AllocatorDemandLine): number => {
  if (a.deliveryDate !== b.deliveryDate) {
    if (a.deliveryDate == null) return 1;
    if (b.deliveryDate == null) return -1;
    return a.deliveryDate < b.deliveryDate ? -1 : 1;
  }
  const ad = a.soDocNo ?? '';
  const bd = b.soDocNo ?? '';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.lineRef < b.lineRef ? -1 : a.lineRef > b.lineRef ? 1 : 0;
};

/** Draw `qty` units of one bucket from one PO's pool lines (post-pick), so a
 *  later line in the same write sees only what is genuinely left. */
const drawFromPool = (
  pool: IncomingLine[],
  poNumber: string,
  itemCode: string,
  variantKey: string,
  qty: number,
): void => {
  let left = qty;
  for (const l of pool) {
    if (left <= 0) break;
    if (l.poNumber !== poNumber || l.itemCode !== itemCode || l.variantKey !== variantKey) continue;
    const take = Math.min(l.qtyLeft, left);
    l.qtyLeft -= take;
    left -= take;
  }
};

/** The DO-time binding decision, whole-write: which incoming PO batch does
 *  each shipping line commit to?
 *
 *  - Lines walk in the owner's DEMAND order (delivery date, then doc number),
 *    so when the pool is tight the earlier order gets the covering PO — the
 *    same priority computeMrp gives it.
 *  - A SOFA set resolves ONCE, as a whole, at its first module's turn:
 *    pickIncomingForSofaSet over the set's pooled needs (modules already
 *    holding a received allocated_batch_no contribute no need but set the
 *    batch PREFERENCE — one PO is one batch number). Every un-received module
 *    of the set gets the SAME pick; no single covering PO -> no pick, and the
 *    existing sofa guards (sofa_no_batch dialog / set-conflict gate) take
 *    over. Never a per-module fallback pick: that is the split the set rule
 *    exists to prevent.
 *  - Every pick DRAWS DOWN the pool before the next line looks, so two lines
 *    of one write cannot both count the same incoming unit — the intra-write
 *    twin of the subtractOutstanding fold.
 *  - Ties auto-pick deterministically (supply order); the operator confirms
 *    in the existing short-stock dialog. No new refusal lives here. */
export function allocateExpectedBatches(
  incoming: IncomingLine[],
  demand: AllocatorDemandLine[],
): Map<string, AllocatorPick> {
  const pool = incoming.map((l) => ({ ...l }));
  const out = new Map<string, AllocatorPick>();
  const setDone = new Set<string>();
  const ordered = [...demand].sort(demandOrder);

  for (const d of ordered) {
    if (!(Number(d.shipQty) > 0)) continue;

    if (d.isSofa && d.soDocNo) {
      if (setDone.has(d.soDocNo)) continue;
      setDone.add(d.soDocNo);
      const modules = ordered.filter((m) => m.isSofa && m.soDocNo === d.soDocNo);
      const needs = new Map<string, number>();
      for (const m of modules) {
        if (m.allocatedBatchNo || !(Number(m.shipQty) > 0)) continue;
        const k = bucketKey(m.itemCode, m.variantKey);
        needs.set(k, (needs.get(k) ?? 0) + Number(m.shipQty));
      }
      if (needs.size === 0) continue; // fully received set — nothing to bind
      const anchors = [...new Set(modules.map((m) => m.allocatedBatchNo).filter((b): b is string => !!b))];
      const preferPo = anchors.length === 1 ? anchors[0] : null;
      const pick = pickIncomingForSofaSet(pool, needs, preferPo);
      if (!pick) continue;
      for (const m of modules) {
        if (m.allocatedBatchNo || !(Number(m.shipQty) > 0)) continue;
        out.set(m.lineRef, { poNumber: pick.poNumber, eta: pick.eta ?? null });
        drawFromPool(pool, pick.poNumber, m.itemCode, m.variantKey, Number(m.shipQty));
      }
      continue;
    }

    if (d.allocatedBatchNo) continue; // received stock ships; nothing to bind
    const pick = pickIncomingForBucket(pool, d.itemCode, d.variantKey, Number(d.shipQty));
    if (!pick) continue;
    out.set(d.lineRef, { poNumber: pick.poNumber, eta: pick.eta ?? null });
    drawFromPool(pool, pick.poNumber, d.itemCode, d.variantKey, Number(d.shipQty));
  }

  return out;
}

/* ── Loader — the open-PO pool for a set of item codes, MRP's read shape ─────
   (mrp.ts §4: line warehouse falls back to the header's purchase_location_id;
   dead POs excluded; effective ETA = line dates else header dates). Kept
   deliberately small: the ship path calls this once per DO write with only the
   DO's own item codes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadIncomingLines(sb: any, itemCodes: string[], warehouseId: string | null): Promise<IncomingLine[]> {
  if (itemCodes.length === 0) return [];
  const { data, error } = await sb
    .from('purchase_order_items')
    .select(`
      material_code, item_group, variants, qty, received_qty, delivery_date,
      supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4,
      warehouse_id,
      po:purchase_orders!inner ( po_number, status, expected_at, supplier_delivery_date_2, supplier_delivery_date_3, supplier_delivery_date_4, purchase_location_id )
    `)
    .in('material_code', itemCodes)
    .not('po.status', 'in', '("CANCELLED","DRAFT")');
  if (error) throw new Error(`incoming_load_failed: ${error.message}`);
  const out: IncomingLine[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const po = r.po as Record<string, unknown> | null;
    if (!po) continue;
    const left = Number(r.qty ?? 0) - Number(r.received_qty ?? 0);
    if (left <= 0) continue;
    const lineWh = (r.warehouse_id as string | null) ?? (po.purchase_location_id as string | null) ?? null;
    if (warehouseId && lineWh !== warehouseId) continue;
    const lineEta = effectiveDelivery(
      r.delivery_date as string | null,
      r.supplier_delivery_date_2 as string | null,
      r.supplier_delivery_date_3 as string | null,
      r.supplier_delivery_date_4 as string | null,
    );
    const headerEta = effectiveDelivery(
      po.expected_at as string | null,
      po.supplier_delivery_date_2 as string | null,
      po.supplier_delivery_date_3 as string | null,
      po.supplier_delivery_date_4 as string | null,
    );
    out.push({
      poNumber: String(po.po_number ?? ''),
      itemCode: String(r.material_code ?? ''),
      variantKey: computeVariantKey(
        (r.item_group as string | null) ?? null,
        (r.variants as Record<string, unknown> | null) ?? null,
      ),
      warehouseId: lineWh,
      qtyLeft: left,
      eta: lineEta ?? headerEta ?? null,
    });
  }
  return out;
}

export const incomingBucketKey = bucketKey;
