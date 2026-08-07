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
// SHADOW MODE FIRST. Money-critical binding follows this repo's soak
// discipline (AUTOCOUNT_WRITES_DISABLED precedent): the allocator runs beside
// the stored-link resolution, LOGS every divergence, and binds nothing until
// the one-line switch in delivery-orders-mfg.ts flips after the shadow data is
// reviewed. This file is pure + loader; it holds no switch itself.
//
// Same-batch-per-set is SOFA-ONLY (owner: "bedframe 是不需要的").
// ----------------------------------------------------------------------------

import { computeVariantKey, effectiveDelivery } from '../shared';

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
 *  single PO covers the set — the caller's conflict/dialog path takes over. */
export function pickIncomingForSofaSet(
  lines: IncomingLine[],
  needs: Map<string, number>, // bucketKey -> qty
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
  candidates.sort(supplyOrder);
  return candidates[0];
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
