/* ---------------------------------------------------------------------------
   source-po-trace — the ONE resolver for "which purchase order did these goods
   come from", in BOTH directions, shared by every surface (owner 2026-08-01:
   "在我的 SO、DO、SI 里，应该看到的数据都是一致的…只对应同一张 SO"). Before this
   file the consumption→lot→batch chain lived in four near-copies
   (soLineShippedSourcePos / resolveDoLineSourcePos / resolveDoSourcePosForDos in
   delivery-orders-mfg.ts, plus po-so-coverage.ts's deliveredLedger + DO-lock
   bucket builds); a fix to one silently missed the others. Now:

     FORWARD  (sales side: SO line / DO line / DO row → source PO chips)
       traceDoShipmentSources() — one ledger read per DO set:
         OUT movements' batch_no (sofa / drop-ship carry the batch on the OUT)
         ∪ FIFO lot consumptions → consumed lots' batch_no (plain-FIFO bed
           frame / mattress / accessories: the OUT is un-batched but the lots
           are, GRN-stamped per mig 0120).
       NULL-batch lots are not dropped blindly any more — they CLASSIFY:
         · source GRN  → the PO is resolved LIVE via grns.purchase_order_id
           (the same evidence backfill-lot-batch-from-docs.mjs stamps durably;
           resolving it at read time means the UI heals before the backfill runs)
         · source ADJUSTMENT → counted as adjustment-shipped units. Free gifts /
           cancel add-backs are legitimately PO-less; the UI shows "STOCK ADJ"
           instead of a dash (owner rule: READY/DELIVERED must never be blank).
         · anything else (pre-import receipts, seeded lots pre-backfill) → no
           chip; the check-so-source-trace.mjs report counts them per class.

     READY    (the new rule, owner verbatim: "系统里只要显示 Ready，肯定就代表
       有货；既然有货，Inventory 里就绝对会有记录，写明这批货对应的是哪一个 PO")
       soLineReadySourcePos() — a READY (allocated, un-shipped) line resolves
       the PO(s) it WILL draw from by projecting the SAME deterministic order
       the engine consumes at DO time: open lots received_at ASC, id ASC
       (fn_consume_fifo's ORDER BY, 0057→0230), earlier claims first (the MRP
       allocation order — sku.lines array order, delivery date then doc_no).
       Read-time derivation only; nothing is written. Sofa lines skip the
       projection: the batch allocator already stored the answer
       (mfg_sales_order_items.allocated_batch_no, mig 0121).

     REVERSE  (purchase side: PO number → the DOs that shipped its goods)
       tracePoDeliveredLedger() — the same batch linkage read from the PO end:
       consumptions of this PO's lots (primary qty source) ∪ batched OUT
       movements (drop-ship gap only — a batched movement whose bucket a
       consumption already covered is SKIPPED, or a sofa ship would count 2x).
       Returns qty per (po, do) and per (po, do, code) PLUS the
       (do::code::variant) bucket keys, so po-so-coverage's Assigned-SO DO-lock
       and its Delivered column read ONE ledger pass and can never disagree.

   Everything here is read-only and best-effort: an absent table / column
   yields empty results, never a 500. All Maps key on trimmed strings.
--------------------------------------------------------------------------- */

import { computeVariantKey, type VariantAttrs } from '../shared';
import type { MrpResult } from '../routes/mrp';

/* One bucket's forward trace: the source PO numbers (sorted, GRN-healed) plus
   how many of its shipped units came out of a PO-less stock ADJUSTMENT. */
export type BucketTrace = { pos: string[]; adjQty: number };

export type ReadySourceChip = {
  po: string | null;          // PO number (batch_no / GRN-resolved / sofa allocated batch)
  qty: number;                // units of the line this chip covers
  kind: 'po' | 'adjustment';  // adjustment → the UI renders "STOCK ADJ"
};

const CHUNK = 300;

const bucketKey = (doId: string, code: string, vk: string | null): string =>
  `${doId}::${code}::${vk ?? ''}`;

type MutableTrace = { pos: Set<string>; adjQty: number };
const traceOf = (m: Map<string, MutableTrace>, k: string): MutableTrace => {
  const cur = m.get(k);
  if (cur) return cur;
  const fresh: MutableTrace = { pos: new Set<string>(), adjQty: 0 };
  m.set(k, fresh);
  return fresh;
};

const freeze = (m: Map<string, MutableTrace>): Map<string, BucketTrace> => {
  const out = new Map<string, BucketTrace>();
  for (const [k, v] of m.entries()) {
    if (v.pos.size === 0 && v.adjQty <= 0) continue;
    out.set(k, {
      pos: [...v.pos].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
      adjQty: v.adjQty,
    });
  }
  return out;
};

/* Resolve GRN ids → their PO numbers (the read-time twin of the durable
   backfill). Company is NOT filtered here: the caller's DO set already scopes
   the lots, and a lot's GRN is by construction the same company's. */
async function poNumbersByGrnId(sb: any, grnIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(grnIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const poIdByGrn = new Map<string, string>();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data } = await sb.from('grns')
        .select('id, purchase_order_id')
        .in('id', ids.slice(i, i + CHUNK));
      for (const g of (data ?? []) as Array<{ id: string; purchase_order_id: string | null }>) {
        if (g.purchase_order_id) poIdByGrn.set(g.id, g.purchase_order_id);
      }
    }
    const poIds = [...new Set(poIdByGrn.values())];
    const poNoById = new Map<string, string>();
    for (let i = 0; i < poIds.length; i += CHUNK) {
      const { data } = await sb.from('purchase_orders')
        .select('id, po_number')
        .in('id', poIds.slice(i, i + CHUNK));
      for (const p of (data ?? []) as Array<{ id: string; po_number: string | null }>) {
        if (p.po_number) poNoById.set(p.id, p.po_number);
      }
    }
    for (const [grnId, poId] of poIdByGrn.entries()) {
      const poNo = poNoById.get(poId);
      if (poNo) out.set(grnId, poNo);
    }
  } catch { /* grns/purchase_orders unreadable — lots stay unresolved */ }
  return out;
}

type LotClassRow = {
  id: string;
  batch_no: string | null;
  source_doc_type: string | null;
  source_doc_id: string | null;
};

/* Classify a set of lots for the forward trace: batch_no verbatim where
   present; NULL-batch GRN lots healed via grns→PO; NULL-batch ADJUSTMENT lots
   flagged. Returns lotId → { po, adjustment }. */
async function classifyLots(
  sb: any,
  lotIds: string[],
): Promise<Map<string, { po: string | null; adjustment: boolean }>> {
  const out = new Map<string, { po: string | null; adjustment: boolean }>();
  const ids = [...new Set(lotIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const rows: LotClassRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await sb.from('inventory_lots')
      .select('id, batch_no, source_doc_type, source_doc_id')
      .in('id', ids.slice(i, i + CHUNK));
    for (const l of (data ?? []) as LotClassRow[]) rows.push(l);
  }
  const grnIds = rows
    .filter((l) => !l.batch_no && (l.source_doc_type ?? '').toUpperCase() === 'GRN' && l.source_doc_id)
    .map((l) => l.source_doc_id as string);
  const poByGrn = await poNumbersByGrnId(sb, grnIds);
  for (const l of rows) {
    const srcType = (l.source_doc_type ?? '').toUpperCase();
    const po = l.batch_no
      ?? (srcType === 'GRN' && l.source_doc_id ? (poByGrn.get(l.source_doc_id) ?? null) : null);
    out.set(l.id, { po, adjustment: !po && srcType === 'ADJUSTMENT' });
  }
  return out;
}

/* ── FORWARD core: one ledger pass for a set of Delivery Orders ────────────── */
export type DoShipmentTrace = {
  /* `${doId}::${product_code}::${variant_key}` → trace (the ship's bucket key) */
  byBucket: Map<string, BucketTrace>;
  /* delivery_order_id → rolled-up trace (the DO / SI list cells) */
  byDo: Map<string, BucketTrace>;
};

export async function traceDoShipmentSources(
  sb: any,
  doIds: Array<string | null | undefined>,
): Promise<DoShipmentTrace> {
  const byBucket = new Map<string, MutableTrace>();
  const byDo = new Map<string, MutableTrace>();
  const ids = [...new Set(doIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return { byBucket: new Map(), byDo: new Map() };

  const addPo = (doId: string, code: string, vk: string | null, po: string | null): void => {
    if (!po) return;
    traceOf(byBucket, bucketKey(doId, code, vk)).pos.add(po);
    traceOf(byDo, doId).pos.add(po);
  };
  const addAdj = (doId: string, code: string, vk: string | null, qty: number): void => {
    if (!(qty > 0)) return;
    traceOf(byBucket, bucketKey(doId, code, vk)).adjQty += qty;
    traceOf(byDo, doId).adjQty += qty;
  };

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    // 1. Batched OUT movements (sofa allocated batch / drop-ship expected batch).
    try {
      const { data: movs } = await sb.from('inventory_movements')
        .select('source_doc_id, product_code, variant_key, batch_no')
        .eq('source_doc_type', 'DO')
        .eq('movement_type', 'OUT')
        .in('source_doc_id', chunk)
        .not('batch_no', 'is', null);
      for (const m of (movs ?? []) as Array<{ source_doc_id: string | null; product_code: string | null; variant_key: string | null; batch_no: string | null }>) {
        if (m.source_doc_id && m.product_code) addPo(m.source_doc_id, m.product_code, m.variant_key, m.batch_no);
      }
    } catch { /* column/table absent — the consumption path still contributes */ }
    // 2. FIFO lot consumptions → consumed lots, classified (batch / GRN-heal / adjustment).
    try {
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('source_doc_id, lot_id, product_code, variant_key, qty_consumed')
        .eq('source_doc_type', 'DO')
        .in('source_doc_id', chunk);
      const consRows = (cons ?? []) as Array<{ source_doc_id: string | null; lot_id: string; product_code: string | null; variant_key: string | null; qty_consumed: number | null }>;
      const lotClass = await classifyLots(sb, consRows.map((r) => r.lot_id));
      for (const r of consRows) {
        if (!r.source_doc_id || !r.product_code) continue;
        const cls = lotClass.get(r.lot_id);
        if (!cls) continue;
        if (cls.po) addPo(r.source_doc_id, r.product_code, r.variant_key, cls.po);
        else if (cls.adjustment) addAdj(r.source_doc_id, r.product_code, r.variant_key, Math.abs(Number(r.qty_consumed ?? 0)));
      }
    } catch { /* consumption table absent — movement batches stand alone */ }
  }
  return { byBucket: freeze(byBucket), byDo: freeze(byDo) };
}

/* ── FORWARD adapters (the shapes each surface consumes) ───────────────────── */

/* DO list / SI list rollup: delivery_order_id → trace. */
export async function resolveDoSources(
  sb: any,
  doIds: Array<string | null | undefined>,
): Promise<Map<string, BucketTrace>> {
  return (await traceDoShipmentSources(sb, doIds)).byDo;
}

/* DO / SI detail per line: `${product_code}::${variant_key}` → trace, one DO. */
export async function resolveDoLineSources(
  sb: any,
  deliveryOrderId: string,
): Promise<Map<string, BucketTrace>> {
  const { byBucket } = await traceDoShipmentSources(sb, [deliveryOrderId]);
  const out = new Map<string, BucketTrace>();
  const prefix = `${deliveryOrderId}::`;
  for (const [k, v] of byBucket.entries()) {
    if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  }
  return out;
}

/* SO line: mfg_sales_order_items.id → trace. Walk SO line → its DO line(s) →
   the SAME (product_code, variant_key) bucket the ship wrote them under
   (movements are not keyed by so_item_id). */
export async function soLineShippedSources(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, BucketTrace>> {
  const out = new Map<string, MutableTrace>();
  const ids = [...new Set(soItemIds.filter((x): x is string => Boolean(x)))];
  if (ids.length === 0) return new Map();
  try {
    const { data: doItems } = await sb.from('delivery_order_items')
      .select('so_item_id, delivery_order_id, item_code, item_group, variants')
      .in('so_item_id', ids);
    const doLines = (doItems ?? []) as Array<{
      so_item_id: string | null; delivery_order_id: string; item_code: string;
      item_group: string | null; variants: VariantAttrs | null;
    }>;
    if (doLines.length === 0) return new Map();
    const { byBucket } = await traceDoShipmentSources(sb, doLines.map((r) => r.delivery_order_id));
    for (const dl of doLines) {
      if (!dl.so_item_id) continue;
      const vk = computeVariantKey(dl.item_group ?? null, dl.variants ?? null);
      const trace = byBucket.get(bucketKey(dl.delivery_order_id, dl.item_code, vk));
      if (!trace) continue;
      const acc = traceOf(out, dl.so_item_id);
      for (const po of trace.pos) acc.pos.add(po);
      acc.adjQty += trace.adjQty;
    }
  } catch { /* ledger unreadable — no shipped source (falls back to coverage PO) */ }
  return freeze(out);
}

/* ── Legacy-shaped wrappers (kept so existing callers/import sites survive) ── */

export async function soLineShippedSourcePosImpl(
  sb: any,
  soItemIds: string[],
): Promise<Map<string, string[]>> {
  const rich = await soLineShippedSources(sb, soItemIds);
  return new Map([...rich.entries()].map(([k, v]) => [k, v.pos]));
}

export async function resolveDoLineSourcePosImpl(
  sb: any,
  deliveryOrderId: string,
): Promise<Map<string, string[]>> {
  const rich = await resolveDoLineSources(sb, deliveryOrderId);
  return new Map([...rich.entries()].map(([k, v]) => [k, v.pos]));
}

export async function resolveDoSourcePosForDosImpl(
  sb: any,
  doIds: Array<string | null | undefined>,
): Promise<Map<string, string[]>> {
  const rich = await resolveDoSources(sb, doIds);
  const out = new Map<string, string[]>();
  for (const [k, v] of rich.entries()) {
    if (v.pos.length > 0) out.set(k, v.pos);
  }
  return out;
}

/* ── READY projection (pure core) ──────────────────────────────────────────
   One (warehouse, code, variant) bucket: claims in ALLOCATION order (MRP's
   sku.lines array — delivery date then doc_no, the exact order computeMrp
   consumed the stock pool in), lots in CONSUMPTION order (received_at ASC,
   id ASC — fn_consume_fifo's ORDER BY). Claim N's stock slice occupies
   [sum of earlier claims' stockQty, +stockQty) of the bucket's pooled stock,
   so spreading the slices across the lots FIFO answers "which lot — and so
   which PO — will THIS line draw when it ships". Deterministic, no writes;
   agrees with the reservations drawer's spread (distributeAssignedToLots) by
   construction because both walk the same orders. A lot tail beyond the open
   lots (balances drift) yields no chip — honest, never a guess. */
export function projectReadyFifo(
  claims: Array<{ soItemId: string; stockQty: number }>,
  lots: Array<{ qty: number; po: string | null; adjustment: boolean }>,
): Map<string, ReadySourceChip[]> {
  const out = new Map<string, ReadySourceChip[]>();
  let lotIdx = 0;
  let lotUsed = 0; // units of lots[lotIdx] already claimed by earlier claims
  for (const claim of claims) {
    let need = Math.max(0, Math.floor(claim.stockQty));
    const chips = new Map<string, ReadySourceChip>(); // key: po ?? '::adj'
    while (need > 0 && lotIdx < lots.length) {
      const lot = lots[lotIdx];
      if (!lot) break;
      const avail = Math.max(0, Math.floor(lot.qty) - lotUsed);
      if (avail <= 0) { lotIdx += 1; lotUsed = 0; continue; }
      const take = Math.min(avail, need);
      need -= take;
      lotUsed += take;
      if (lot.po || lot.adjustment) {
        const key = lot.po ?? '::adj';
        const cur = chips.get(key);
        if (cur) cur.qty += take;
        else chips.set(key, { po: lot.po, qty: take, kind: lot.po ? 'po' : 'adjustment' });
      }
      if (lotUsed >= Math.floor(lot.qty)) { lotIdx += 1; lotUsed = 0; }
    }
    // need > 0 here = the MRP stock figure exceeded the open lots (drift) — the
    // uncovered tail simply carries no chip.
    if (chips.size > 0) {
      const arr = [...chips.values()].sort((a, b) =>
        (a.po ?? '￿').localeCompare(b.po ?? '￿', undefined, { numeric: true }));
      const prev = out.get(claim.soItemId);
      if (prev) {
        // Same SO line split across buckets cannot happen (one line = one
        // bucket), but merge defensively rather than drop.
        for (const ch of arr) {
          const hit = prev.find((p) => p.po === ch.po && p.kind === ch.kind);
          if (hit) hit.qty += ch.qty;
          else prev.push(ch);
        }
      } else {
        out.set(claim.soItemId, arr);
      }
    }
  }
  return out;
}

/* ── READY projection (query wrapper) ──────────────────────────────────────
   items: the SO's item rows (id / item_group / qty / stock_status /
   allocated_batch_no). mrp: the SAME computeMrp result the caller already ran
   for coverage (null → sofa-only resolution). Sofa lines surface their stored
   allocated_batch_no directly (mig 0121 — the batch allocator's hard answer);
   non-sofa lines project over open lots. Fail-soft: any read error resolves to
   an empty map, never a 500. */
export async function soLineReadySourcePos(
  sb: any,
  companyId: number | null,
  mrp: MrpResult | null,
  items: Array<{
    id: string;
    item_group?: string | null;
    qty?: number | null;
    stock_status?: string | null;
    allocated_batch_no?: string | null;
  }>,
): Promise<Map<string, ReadySourceChip[]>> {
  const out = new Map<string, ReadySourceChip[]>();
  const wanted = new Set(items.map((it) => it.id).filter(Boolean));
  if (wanted.size === 0) return out;

  // SOFA: the allocator already bound ONE batch (= one PO) per READY set.
  for (const it of items) {
    const isSofa = String(it.item_group ?? '').toUpperCase().includes('SOFA');
    const batch = (it.allocated_batch_no ?? '').trim();
    if (isSofa && batch && String(it.stock_status ?? '').toUpperCase() === 'READY') {
      out.set(it.id, [{ po: batch, qty: Math.max(1, Number(it.qty ?? 1)), kind: 'po' }]);
    }
  }
  if (!mrp) return out;

  try {
    // Buckets that hold at least one of OUR lines with a stock slice.
    type Bucket = {
      warehouseId: string | null;
      itemCode: string;
      variantKey: string;
      claims: Array<{ soItemId: string; stockQty: number }>;
    };
    const buckets: Bucket[] = [];
    for (const sku of mrp.skus) {
      let ours = false;
      const claims: Array<{ soItemId: string; stockQty: number }> = [];
      for (const l of sku.lines) {
        if (!(l.stockQty > 0)) continue;
        claims.push({ soItemId: l.soItemId, stockQty: l.stockQty });
        if (wanted.has(l.soItemId)) ours = true;
      }
      if (ours && claims.length > 0) {
        buckets.push({ warehouseId: sku.warehouseId, itemCode: sku.itemCode, variantKey: sku.variantKey, claims });
      }
    }
    if (buckets.length === 0) return out;

    // Open lots for those buckets — FIFO order (received_at ASC, id ASC), the
    // exact ORDER BY fn_consume_fifo walks. A WH_NONE bucket has no physical
    // warehouse, so it can match no lot — honest empty.
    const codes = [...new Set(buckets.map((b) => b.itemCode))];
    const whIds = [...new Set(buckets.map((b) => b.warehouseId).filter((x): x is string => Boolean(x)))];
    if (whIds.length === 0) return out;
    type LotRow = {
      id: string; warehouse_id: string; product_code: string; variant_key: string | null;
      qty_remaining: number | null; batch_no: string | null;
      source_doc_type: string | null; source_doc_id: string | null;
      received_at: string | null;
    };
    const lots: LotRow[] = [];
    for (let i = 0; i < codes.length; i += CHUNK) {
      let q = sb.from('inventory_lots')
        .select('id, warehouse_id, product_code, variant_key, qty_remaining, batch_no, source_doc_type, source_doc_id, received_at')
        .in('product_code', codes.slice(i, i + CHUNK))
        .in('warehouse_id', whIds)
        .gt('qty_remaining', 0)
        .order('received_at', { ascending: true })
        .order('id', { ascending: true });
      if (companyId != null) q = q.eq('company_id', companyId);
      const { data } = await q;
      for (const l of (data ?? []) as LotRow[]) lots.push(l);
    }
    if (lots.length === 0) return out;

    // Classify NULL-batch lots once (GRN-heal + adjustment), reusing the same
    // rules the shipped side applies — the two traces must speak one language.
    const nullBatch = lots.filter((l) => !l.batch_no);
    const grnIds = nullBatch
      .filter((l) => (l.source_doc_type ?? '').toUpperCase() === 'GRN' && l.source_doc_id)
      .map((l) => l.source_doc_id as string);
    const poByGrn = await poNumbersByGrnId(sb, grnIds);

    const lotsByBucket = new Map<string, LotRow[]>();
    for (const l of lots) {
      const k = `${l.warehouse_id}::${l.product_code}::${l.variant_key ?? ''}`;
      const arr = lotsByBucket.get(k) ?? [];
      arr.push(l);
      lotsByBucket.set(k, arr);
    }

    for (const b of buckets) {
      if (!b.warehouseId) continue;
      const bucketLots = lotsByBucket.get(`${b.warehouseId}::${b.itemCode}::${b.variantKey}`) ?? [];
      if (bucketLots.length === 0) continue;
      const projected = projectReadyFifo(
        b.claims,
        bucketLots.map((l) => {
          const srcType = (l.source_doc_type ?? '').toUpperCase();
          const po = l.batch_no
            ?? (srcType === 'GRN' && l.source_doc_id ? (poByGrn.get(l.source_doc_id) ?? null) : null);
          return {
            qty: Number(l.qty_remaining ?? 0),
            po,
            adjustment: !po && srcType === 'ADJUSTMENT',
          };
        }),
      );
      for (const [soItemId, chips] of projected.entries()) {
        if (!wanted.has(soItemId)) continue; // competing claims are walked, not shown
        if (!out.has(soItemId)) out.set(soItemId, chips); // sofa direct answer wins
      }
    }
  } catch { /* projection is display-only — degrade to no chips */ }
  return out;
}

/* ── REVERSE core: PO numbers → the DOs that shipped their goods ───────────
   Moved VERBATIM in behaviour from po-so-coverage.ts (deliveredLedger…), plus
   the (do::code::variant) bucket keys per PO so the Assigned-SO DO-lock and
   the Delivered column derive from ONE ledger pass.

   Qty MUST NOT double-count: a sofa/allocated-batch OUT writes BOTH a batched
   movement AND a consumption of that same batched lot, so consumptions are the
   PRIMARY qty source and a batched OUT only fills the DROP-SHIP gap (its
   bucket has no consumption — it shipped before receipt). Plain-FIFO OUTs are
   un-batched so the movement filter never matches them; their consumed lots
   ARE batched and carry them. */
export type PoDeliveredLedger = {
  qtyByPoDo: Map<string, Map<string, number>>;
  qtyByPoDoCode: Map<string, Map<string, Map<string, number>>>;
  /* poNumber → `${doId}::${code}::${variantKey}` bucket keys (the DO-lock's input) */
  bucketsByPo: Map<string, Set<string>>;
  doIds: Set<string>;
};

export async function tracePoDeliveredLedger(
  sb: any,
  poNumbers: string[],
): Promise<PoDeliveredLedger> {
  const qtyByPoDo = new Map<string, Map<string, number>>();
  const qtyByPoDoCode = new Map<string, Map<string, Map<string, number>>>();
  const bucketsByPo = new Map<string, Set<string>>();
  const doIds = new Set<string>();
  const consumedBuckets = new Set<string>();
  const bump = (poNum: string | null, doId: string | null, code: string | null, qty: number): void => {
    if (!poNum || !doId) return;
    const q = Math.abs(Number(qty) || 0);
    const inner = qtyByPoDo.get(poNum) ?? new Map<string, number>();
    inner.set(doId, (inner.get(doId) ?? 0) + q);
    qtyByPoDo.set(poNum, inner);
    if (code) {
      const byDo = qtyByPoDoCode.get(poNum) ?? new Map<string, Map<string, number>>();
      const byCode = byDo.get(doId) ?? new Map<string, number>();
      byCode.set(code, (byCode.get(code) ?? 0) + q);
      byDo.set(doId, byCode);
      qtyByPoDoCode.set(poNum, byDo);
    }
    doIds.add(doId);
  };
  const addBucket = (poNum: string | null, doId: string | null, code: string | null, vk: string | null): void => {
    if (!poNum || !doId || !code) return;
    const set = bucketsByPo.get(poNum) ?? new Set<string>();
    set.add(`${doId}::${code}::${vk ?? ''}`);
    bucketsByPo.set(poNum, set);
    doIds.add(doId);
  };
  if (poNumbers.length === 0) return { qtyByPoDo, qtyByPoDoCode, bucketsByPo, doIds };
  // 1. Consumptions FIRST (the primary qty source, no double count).
  try {
    const { data: lots } = await sb.from('inventory_lots').select('id, batch_no').in('batch_no', poNumbers);
    const lotPo = new Map<string, string>();
    for (const l of (lots ?? []) as Array<{ id: string; batch_no: string | null }>) {
      if (l.id && l.batch_no) lotPo.set(l.id, l.batch_no);
    }
    const lotIds = [...lotPo.keys()];
    for (let k = 0; k < lotIds.length; k += CHUNK) {
      const chunk = lotIds.slice(k, k + CHUNK);
      if (chunk.length === 0) continue;
      const { data: cons } = await sb.from('inventory_lot_consumptions')
        .select('source_doc_id, lot_id, product_code, variant_key, qty_consumed')
        .eq('source_doc_type', 'DO').in('lot_id', chunk);
      for (const r of (cons ?? []) as Array<{ source_doc_id: string | null; lot_id: string; product_code: string | null; variant_key: string | null; qty_consumed: number | null }>) {
        const poNum = lotPo.get(r.lot_id) ?? null;
        if (poNum && r.source_doc_id && r.product_code) {
          consumedBuckets.add(`${poNum}::${r.source_doc_id}::${r.product_code}`);
        }
        bump(poNum, r.source_doc_id, r.product_code, Number(r.qty_consumed ?? 0));
        addBucket(poNum, r.source_doc_id, r.product_code, r.variant_key);
      }
    }
  } catch { /* consumption / lot table absent — movement batches stand alone */ }
  // 2. Batched OUT movements — buckets always (the ship DID come from this PO);
  //    qty only where NO consumption covered the bucket (drop-ship).
  try {
    const { data: movs } = await sb.from('inventory_movements')
      .select('source_doc_id, product_code, variant_key, batch_no, qty')
      .eq('source_doc_type', 'DO').eq('movement_type', 'OUT').in('batch_no', poNumbers);
    for (const m of (movs ?? []) as Array<{ source_doc_id: string | null; product_code: string | null; variant_key: string | null; batch_no: string | null; qty: number | null }>) {
      addBucket(m.batch_no, m.source_doc_id, m.product_code, m.variant_key);
      if (m.batch_no && m.source_doc_id && m.product_code
        && consumedBuckets.has(`${m.batch_no}::${m.source_doc_id}::${m.product_code}`)) {
        continue; // already counted via its lot consumption — skip to avoid 2x
      }
      bump(m.batch_no, m.source_doc_id, m.product_code, Number(m.qty ?? 0));
    }
  } catch { /* movements shape differs — consumption path still contributes */ }
  return { qtyByPoDo, qtyByPoDoCode, bucketsByPo, doIds };
}
