/* ----------------------------------------------------------------------------
   so-line-po-duplicate — is this sales-order line already on a purchase order?

   2990-0065 (Sim, 2026-11-19): 2990-SO-2608-042's two sofa lines were raised on
   2990-PO-2611-036 and again on 2990-PO-2611-044, two days apart, and nothing
   said so. A custom sofa / bedframe / dining / SP-SK mattress ordered twice is
   a second set of goods nobody can use.

   A PROMPT, NOT A BLOCK. Repeat conversion is legal on purpose — one SO line can
   be split across several POs (soLineOverConvertRefusal's header). So the server
   answers 409 `so_has_po` naming the POs, and the client replays with
   `confirmDuplicatePo: true` once the operator says Continue.

   PER LINE, not per SO: `purchase_order_items.so_item_id` is the stored link
   (so-po-raised.ts), and one SO is routinely converted in pieces (sofa per-SO,
   mattress merged by window — po-grouping.ts). Asking per SO would stop the
   second, legitimate half of every split order.

   Counts every non-cancelled PO, DRAFT and MRP-origin lines included: MRP-origin
   lines are left out of `po_qty_picked`, which is exactly how a second PO for
   the same line gets past the quantity cap.
   -------------------------------------------------------------------------- */
import { chunkIn } from './paginate-all';

export type SoLineRef = { id: string; doc_no: string | null; item_code: string | null };
export type SoLinePoHit = { soItemId: string; soDocNo: string | null; itemCode: string | null; poNumber: string };

/** Live PO lines already raised for these SO lines. THROWS on a failed read —
 *  "could not tell" must not read as "no PO yet", the permissive direction. */
export async function soLinesOnLivePo(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped
  sb: any,
  rows: readonly SoLineRef[],
): Promise<SoLinePoHit[]> {
  const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
  if (byId.size === 0) return [];
  const { data, error } = await chunkIn<{ so_item_id: string; po: { po_number: string; status: string } | null }>(
    [...byId.keys()],
    (batch, from, to) => sb
      .from('purchase_order_items')
      .select('so_item_id, po:purchase_orders!inner(po_number, status)')
      .in('so_item_id', batch)
      .order('id')
      .range(from, to),
  );
  if (error) throw new Error(`so_line_po_read_failed: ${error.message}`);
  const seen = new Set<string>();
  const out: SoLinePoHit[] = [];
  for (const r of data) {
    const status = String(r.po?.status ?? '').toUpperCase();
    if (!r.po?.po_number || status === 'CANCELLED') continue;
    const key = `${r.so_item_id}|${r.po.po_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const src = byId.get(r.so_item_id);
    out.push({ soItemId: r.so_item_id, soDocNo: src?.doc_no ?? null, itemCode: src?.item_code ?? null, poNumber: r.po.po_number });
  }
  return out;
}

/** The 409 body for a pick that re-orders lines already on a PO, or null. */
export function soHasPoRefusal(hits: readonly SoLinePoHit[]) {
  if (hits.length === 0) return null;
  const poNumbers = [...new Set(hits.map((h) => h.poNumber))].sort();
  return {
    error: 'so_has_po' as const,
    reason: `This Sales Order already has PO(s): ${poNumbers.join(', ')}.`,
    poNumbers,
    lines: hits,
  };
}

/** One call per route. Not yet confirmed: the 409 body when a line is already on
 *  a live PO. Confirmed (`confirmDuplicatePo: true`): the SO line ids the operator
 *  said Continue for, so the New PO form's quantity prompt does not ask again. */
export async function soHasPoGate(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped
  sb: any,
  rows: readonly SoLineRef[],
  confirmDuplicatePo: unknown,
): Promise<{ refusal: ReturnType<typeof soHasPoRefusal>; confirmed: Set<string> }> {
  const hits = await soLinesOnLivePo(sb, rows);
  if (confirmDuplicatePo === true) return { refusal: null, confirmed: new Set(hits.map((h) => h.soItemId)) };
  return { refusal: soHasPoRefusal(hits), confirmed: new Set() };
}
