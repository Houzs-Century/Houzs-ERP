// ----------------------------------------------------------------------------
// do-unlinked-coverage — count a shipment that lost its SO-line pointer but
// still NAMES the Sales Order on its header.
//
// WHY THIS EXISTS. Two engines decide whether an order still owes goods, and
// until now both read exactly one key — `delivery_order_items.so_item_id`:
//
//   · soDeliverableRemaining (delivery-orders-mfg.ts) — MRP subtracts its
//     delivered sum from demand;
//   · isSoFullyCovered (so-delivery-sync.ts) — decides CONFIRMED -> DELIVERED.
//
// That key is nullable and the FK is `ON DELETE SET NULL`, so deleting ONE
// Sales-Order line silently blanks the pointer on every downstream document
// that served it. When it blanks, a shipment that physically happened — stock
// deducted, OUT movement written, customer signed — becomes invisible to both
// engines at once: the order stays CONFIRMED and MRP asks Procurement to buy
// the goods a second time. On 2026-08-17 that was 26 lines across 8 live 2990
// DOs (owner: "已经出货了为什么 MRP 还叫我下单").
//
// THE POINT IS NOT THAT THE POINTER WENT MISSING — repair-do-so-item-links.mjs
// heals the rows, and the path that blanks them still has to be found and
// closed. The point is that the ENGINES had no second source of truth for a
// fact the database still held plainly: `delivery_orders.so_doc_no` says which
// order the shipment served. Reading only the per-line pointer made a single
// nullable column the sole evidence that goods had shipped, and one NULL flip
// a silent re-order. This module is that second reading.
//
// WHAT IT IS NOT. It is NOT a relaxation of the SO<->DO link, and it never
// writes one. Attribution is confined to the ONE order the DO header already
// names, matched on item code, and CAPPED by what the properly-linked
// deliveries left uncovered — so it can only ever fill a gap, never invent
// coverage beyond the ordered qty, and never move a unit between orders. A
// repaired (linked) line and its unlinked twin cannot double-count, because the
// cap is computed from the linked sum first.
//
// The decision is PURE (attributeUnlinkedDoLines) and unit-tested in
// backend/tests/doUnlinkedCoverage.test.ts; the async wrapper is the thin
// Supabase read around it.
// ----------------------------------------------------------------------------

import { chunkIn } from './paginate-all';

/** Same normalisation so-line-relink.ts and the repair script match on, so all
 *  three agree about what "the same SKU" means. */
const normCode = (code: string | null | undefined): string => String(code ?? '').trim().toUpperCase();

export type CoverageSoLine = { id: string; docNo: string; itemCode: string | null; qty: number };
export type UnlinkedDoLine = { id: string; docNo: string; itemCode: string | null; qty: number };
/** One synthesised delivery: DO line `doLineId` covers `qty` of SO line
 *  `soItemId`. Shaped like a linked row so callers just concatenate it. */
export type AttributedDelivery = { doLineId: string; soItemId: string; qty: number };

/**
 * PURE. Spread unlinked DO lines over the SO lines they can only have served.
 *
 * @param soLines               the orders' NON-CANCELLED lines.
 * @param linkedDeliveredBySoItem  net qty already credited via real so_item_id
 *                              links (delivered − returned, or just delivered;
 *                              the caller decides — this only reads it as
 *                              "how much of this line is already accounted
 *                              for", and a larger value simply attributes
 *                              less).
 * @param unlinked              DO lines with so_item_id IS NULL, each carrying
 *                              the so_doc_no its DO header names. Cancelled and
 *                              DRAFT deliveries must already be excluded.
 */
export function attributeUnlinkedDoLines(
  soLines: CoverageSoLine[],
  linkedDeliveredBySoItem: Map<string, number>,
  unlinked: UnlinkedDoLine[],
): AttributedDelivery[] {
  if (unlinked.length === 0) return [];

  /* Bucket by (SO doc, item code). The doc is half the key on purpose: a DO
     header names ONE order, so a line can never reach across to another
     customer's identical SKU. */
  const bucket = (docNo: string, itemCode: string | null) => `${docNo}::${normCode(itemCode)}`;
  const openBySlot = new Map<string, Array<{ id: string; open: number }>>();
  for (const s of soLines) {
    const already = linkedDeliveredBySoItem.get(s.id) ?? 0;
    const open = Number(s.qty ?? 0) - Math.max(0, already);
    if (!(open > 0)) continue; // fully covered by real links — nothing to fill
    const key = bucket(s.docNo, s.itemCode);
    const arr = openBySlot.get(key) ?? [];
    arr.push({ id: s.id, open });
    openBySlot.set(key, arr);
  }
  if (openBySlot.size === 0) return [];

  const out: AttributedDelivery[] = [];
  for (const d of unlinked) {
    let left = Number(d.qty ?? 0);
    if (!(left > 0)) continue;
    const slot = openBySlot.get(bucket(d.docNo, d.itemCode));
    if (!slot) continue; // no SO line of that SKU still open — attribute nothing

    /* Fill in the order the caller handed the SO lines over (their listing
       order), so the result is deterministic. A DO line bigger than one SO
       line's opening spills onto the next line of the SAME SKU — the shape a
       merged/multi-line order produces — and anything still left over after the
       whole bucket is exhausted is DROPPED, never forced onto an unrelated
       line. Dropping is the conservative direction: it under-counts coverage,
       which at worst leaves the old (wrong) "still owing" reading in place,
       instead of over-counting and hiding a genuine shortage. */
    for (const line of slot) {
      if (left <= 0) break;
      if (line.open <= 0) continue;
      const take = Math.min(line.open, left);
      line.open -= take;
      left -= take;
      out.push({ doLineId: d.id, soItemId: line.id, qty: take });
    }
  }
  return out;
}

/**
 * Σ delivered per SO line, BOTH ways — the linked sum and the header-attributed
 * one — plus the DO-line → SO-line map the caller needs to net returns.
 *
 * Lifted out of soDeliverableRemaining (delivery-orders-mfg.ts §2) when the
 * second reading was added: the route file is over its size ceiling and may
 * only shrink, and this is an ENGINE, not a route. The linked half below is the
 * original code and its original comments, moved verbatim.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any — untyped client.
 */
export async function netDeliveredBySoItem(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soDocNos: string[],
  soLines: CoverageSoLine[],
): Promise<{ deliveredBySoItem: Map<string, number>; doLineToSoItem: Map<string, string> }> {
  type LinkedRow = { id: string; so_item_id: string | null; qty: number; parent: { status: string | null } | null };
  // Σ delivered — DO lines linked by so_item_id whose parent DO is NOT
  // cancelled (nor DRAFT — a draft hasn't shipped). PERF: collapsed from a
  // two-step "pull DO lines, then re-fetch their parent DOs to read status"
  // into ONE round-trip by embedding the parent status (PostgREST to-one
  // embed → row count unchanged, so paginateAll stays exact). The
  // CANCELLED/DRAFT decision is still made HERE in JS with the same
  // .toUpperCase() compare, and a missing parent (orphan) is excluded exactly
  // as before (its id used to be absent from the delivery_orders lookup, so
  // it never entered activeDoIds) — the delivered sum is byte-identical.
  /* THE ERROR IS BOUND AND THROWN, which the version of this read that lived in
     the route was not. supabase-js does not throw: with only `data` destructured,
     "the query failed" and "nothing is delivered" arrive as the same empty array
     — and on THIS read that silence means every line reads as undelivered, which
     is the exact false reading (goods shipped, order still owing, MRP re-orders)
     this module exists to end. Failing loudly is the honest option: the callers
     are already wrapped, and a planning page that errors is recoverable in a way
     that a planning page confidently reporting phantom demand is not. */
  /* CHUNKED, because paginateAll bounds the wrong end of this read. It bounds
     the RESPONSE — the 1000-row page cap — while the SO-line ids go into the
     REQUEST, one uuid each, straight into `.in('so_item_id', …)`. Those are two
     different limits and only the first one was guarded: MRP hands this function
     ~1000 lines per batch, so the un-chunked filter built a ~39KB request line
     and PostgREST answered 400. Live on 2026-08-17, Houzs Century (2,726 sales
     orders): GET /api/scm/mrp?category=SOFA returned
     `delivered-sum read failed: Bad Request` while the same code answered 200 in
     the 100-order tenant next door. Invisible small, permanent large, and worse
     with every import.

     chunkIn is the repo's existing helper for exactly this and it PAGES each
     batch, so the response cap stays guarded too. Nothing about the answer
     changes: the rows of two batches are disjoint (the id list is de-duplicated
     first, so no row can match twice), and both things built below — a Σ per
     so_item_id and a DO-line → SO-line map — are order-independent, so a merged
     read and a single read produce byte-identical maps. */
  const soItemIds = [...new Set(soLines.map((l) => l.id))];
  const { data: doLines, error: linkedErr } = await chunkIn<LinkedRow>(soItemIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select('id, so_item_id, qty, parent:delivery_orders(status)')
    .in('so_item_id', batch)
    .order('id')
    .range(from, to));
  if (linkedErr) throw new Error(`delivered-sum read failed: ${linkedErr.message ?? String(linkedErr)}`);
  // DO line id → SO item id (only for active DOs), used to trace returns.
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of doLines) {
    if (!l.so_item_id || !l.parent) continue;
    /* LEAK GUARD (DRAFT): a DRAFT DO hasn't shipped — it must NOT consume the
       SO line's deliverable remaining (else the real DO can't be raised and
       the picker shows phantom-delivered qty). Treated like CANCELLED here. */
    const st = (l.parent.status ?? '').toUpperCase();
    if (st === 'CANCELLED' || st === 'DRAFT') continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  /* The second reading — see this module's header. Capped by the linked sum
     just built, so a repaired line and its unlinked twin can never both count.
     Attributed lines are registered in doLineToSoItem too, so a Delivery Return
     against one nets out exactly as it does for a linked line: a returned unit
     must re-open the order however its delivery was counted. */
  for (const a of await loadUnlinkedDoCoverage(sb, soDocNos, soLines, deliveredBySoItem)) {
    doLineToSoItem.set(a.doLineId, a.soItemId);
    deliveredBySoItem.set(a.soItemId, (deliveredBySoItem.get(a.soItemId) ?? 0) + a.qty);
  }
  return { deliveredBySoItem, doLineToSoItem };
}

type DoHeaderRow = { id: string; so_doc_no: string | null; status: string | null };
type UnlinkedRow = { id: string; delivery_order_id: string; item_code: string | null; qty: number };

/**
 * Read the unlinked DO lines sitting under the given Sales Orders and
 * attribute them. Returns [] on any read failure — the coverage engines must
 * degrade to their previous (link-only) answer rather than 500 a planning page.
 *
 * eslint-disable-next-line @typescript-eslint/no-explicit-any — `sb` is the
 * untyped Supabase client every module in this tree passes around.
 */
export async function loadUnlinkedDoCoverage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soDocNos: string[],
  soLines: CoverageSoLine[],
  linkedDeliveredBySoItem: Map<string, number>,
): Promise<AttributedDelivery[]> {
  const docs = [...new Set(soDocNos.filter(Boolean))];
  if (docs.length === 0 || soLines.length === 0) return [];
  try {
    /* TWO PLAIN READS, NOT ONE EMBEDDED-FILTER READ, deliberately. The elegant
       version is `.select('…, parent:delivery_orders!inner(so_doc_no, status)')`
       with `.in('parent.so_doc_no', docs)` — one round-trip. But an
       embedded-column filter is the one PostgREST shape this repo cannot
       exercise locally (the fake PostgREST in the route tests does not
       implement it), and this function's own best-effort contract turns a
       malformed query into `[]` — i.e. into "no unlinked coverage found",
       which is indistinguishable from a healthy system. A silent no-op is
       exactly the failure this whole module exists to end, so the read is
       written in the boring way that cannot have that bug. */
    const { data: headers, error: hErr } = await chunkIn<DoHeaderRow>(docs, (batch, from, to) => sb
      .from('delivery_orders')
      .select('id, so_doc_no, status')
      .in('so_doc_no', batch)
      .order('id')
      .range(from, to));
    if (hErr) throw hErr;

    const docByDoId = new Map<string, string>();
    for (const h of headers ?? []) {
      if (!h.so_doc_no) continue;
      /* The same gate the linked sum applies, in JS with the same compare: a
         CANCELLED delivery took nothing back out of stock and a DRAFT has not
         shipped at all. Wrong in the lenient direction, a draft would mark an
         order DELIVERED — the leak the linked path already documents. */
      const st = (h.status ?? '').toUpperCase();
      if (st === 'CANCELLED' || st === 'DRAFT') continue;
      docByDoId.set(h.id, h.so_doc_no);
    }
    if (docByDoId.size === 0) return [];

    const { data: rows, error: lErr } = await chunkIn<UnlinkedRow>([...docByDoId.keys()], (batch, from, to) => sb
      .from('delivery_order_items')
      .select('id, delivery_order_id, item_code, qty')
      .is('so_item_id', null)
      .in('delivery_order_id', batch)
      .order('id')
      .range(from, to));
    if (lErr) throw lErr;

    const unlinked: UnlinkedDoLine[] = [];
    for (const r of rows) {
      const docNo = docByDoId.get(r.delivery_order_id);
      if (!docNo) continue;
      unlinked.push({ id: r.id, docNo, itemCode: r.item_code, qty: Number(r.qty ?? 0) });
    }
    return attributeUnlinkedDoLines(soLines, linkedDeliveredBySoItem, unlinked);
  } catch (e) {
    /* Degrade to the previous link-only answer rather than 500 a planning page
       — but SAY SO. Swallowed silently, a broken read here reads as "this order
       has no lost shipments", which is the same sentence a healthy system
       produces and the reason the original defect went unnoticed for a month. */
    // eslint-disable-next-line no-console
    console.error('[do-unlinked-coverage] read failed; falling back to link-only coverage:', e);
    return [];
  }
}
