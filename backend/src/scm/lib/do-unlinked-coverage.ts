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

import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { chunkIn, paginateAll } from './paginate-all';
import { readFailureError } from './read-failure';

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

  const bucket = (docNo: string, itemCode: string | null) => `${docNo}::${normCode(itemCode)}`;
  const openBySlot = new Map<string, Array<{ id: string; open: number }>>();
  for (const s of soLines) {
    const already = linkedDeliveredBySoItem.get(s.id) ?? 0;
    const open = Number(s.qty ?? 0) - Math.max(0, already);
    if (!(open > 0)) continue;
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
    if (!slot) continue;

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
  const soItemIds = [...new Set(soLines.map((l) => l.id))];
  const { data: doLines, error: linkedErr } = await chunkIn<LinkedRow>(soItemIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select('id, so_item_id, qty, parent:delivery_orders(status)')
    .in('so_item_id', batch)
    .order('id')
    .range(from, to));
  if (linkedErr) {
    throw readFailureError('delivered_sum', linkedErr, {
      table: 'delivery_order_items',
      filter: 'so_item_id',
      in_list_size: soLines.length,
      so_docs: soDocNos.length,
    });
  }
  const doLineToSoItem = new Map<string, string>();
  const deliveredBySoItem = new Map<string, number>();
  for (const l of doLines) {
    if (!l.so_item_id || !l.parent) continue;
    if (!doCountsAsDelivered(l.parent.status)) continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

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
  if (soLines.length === 0) return [];
  return attributeUnlinkedDoLines(soLines, linkedDeliveredBySoItem, await readUnlinkedDoLinesUnder(sb, soDocNos));
}

/**
 * The READ half of loadUnlinkedDoCoverage: the shipped `so_item_id IS NULL` DO
 * lines whose DO header names one of `soDocNos`, in read order (attribution
 * fills in that order). [] on any read failure, logged. Split out so
 * soDeliverableRemaining can START it beside its own reads — it needs only the
 * doc numbers, not the linked sum it is later attributed against.
 */
export async function readUnlinkedDoLinesUnder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  soDocNos: string[],
): Promise<UnlinkedDoLine[]> {
  const docs = [...new Set(soDocNos.filter(Boolean))];
  if (docs.length === 0) return [];
  try {
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
      if (!doCountsAsDelivered(h.status)) continue;
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
    return unlinked;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[do-unlinked-coverage] read failed; falling back to link-only coverage:', e);
    return [];
  }
}
