/* Which goods receipts belong to ONE purchase order — by the header FK AND by
 * the line link (sister review G5; Hookka #1221).
 *
 * A receipt converted from several POs (`grns POST /from-pos`) or a supplier
 * multi-receive (`/from-po-items`) names only the FIRST order in
 * `grns.purchase_order_id`; its lines name their own PO lines. Reading the
 * header alone made the 2nd and later orders look unreceived: no receipt in
 * Linked documents, and supplier and other locked columns still editable
 * although stock was posted against them. The PO list already took the union
 * (`stampPoListGrns`); the lock and the detail screens now take the same one.
 *
 * The PO id is the caller's, already proven in company; every row read here is
 * keyed off that PO's own lines. A failed read is reported, never an absence. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkIn } from './paginate-all';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = SupabaseClient<any, any, any>;

export type PoGrnIds = { ok: true; ids: string[] } | { ok: false; reason: string };

/** Ids of every GRN (any status) holding a line drawn from this PO's lines. */
export async function readPoLineLinkedGrnIds(sb: Sb, poId: string): Promise<PoGrnIds> {
  const { data: items, error: iErr } = await sb.from('purchase_order_items').select('id').eq('purchase_order_id', poId);
  if (iErr) return { ok: false, reason: `purchase_order_items: ${iErr.message}` };
  const itemIds = (items as Array<{ id: string }>).map((r) => r.id);
  if (itemIds.length === 0) return { ok: true, ids: [] };
  const { data: lines, error: gErr } = await chunkIn<{ grn_id: string | null }>(itemIds, (batch, from, to) =>
    sb.from('grn_items').select('grn_id').in('purchase_order_item_id', batch).order('grn_id', { ascending: true }).range(from, to));
  if (gErr) return { ok: false, reason: `grn_items: ${gErr.message}` };
  return { ok: true, ids: [...new Set(lines.map((l) => l.grn_id).filter((x): x is string => !!x))] };
}

export type PoLinkedGrn = { id: string; grn_number: string | null; status: string | null; received_at: string | null };

/** Every GRN of this PO (header FK or line link, any status), newest first —
 *  the Linked documents list. */
export async function readPoLinkedGrns(
  sb: Sb,
  poId: string,
): Promise<{ ok: true; grns: PoLinkedGrn[] } | { ok: false; reason: string }> {
  const { data: byHeader, error: hErr } = await sb.from('grns')
    .select('id, grn_number, status, received_at').eq('purchase_order_id', poId);
  if (hErr) return { ok: false, reason: `grns: ${hErr.message}` };
  const out = new Map<string, PoLinkedGrn>();
  for (const g of byHeader as PoLinkedGrn[]) out.set(g.id, g);
  const linked = await readPoLineLinkedGrnIds(sb, poId);
  if (!linked.ok) return linked;
  const missing = linked.ids.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const { data: byLine, error: lErr } = await chunkIn<PoLinkedGrn>(missing, (batch, from, to) =>
      sb.from('grns').select('id, grn_number, status, received_at').in('id', batch).order('id', { ascending: true }).range(from, to));
    if (lErr) return { ok: false, reason: `grns: ${lErr.message}` };
    for (const g of byLine) out.set(g.id, g);
  }
  const grns = [...out.values()].sort((a, b) => String(b.received_at ?? '').localeCompare(String(a.received_at ?? '')));
  return { ok: true, grns };
}
