/* ----------------------------------------------------------------------------
   so-photo-po-carry — keep a PO line's carried photos in step with its SO line.

   An SO line's photos are copied onto its PO lines when the PO is raised and
   when an amendment re-derives the line (mig 0274, po-line-rederive.ts). A
   photo added or removed on the SO line AFTER that never reached the PO:
   HC-SO-2610-400's drawing, uploaded on its STOOL line at 10:35, was missing
   from HC-PO-2610-438_R1, re-derived at 10:17 (HC-0184, Sim 2026-10-30).

   Every PO line bound to the SO line (so_item_id) takes the same add / remove,
   except on a CANCELLED PO. The PO's own `po-items/` uploads are never touched.
   Best-effort: the SO write has already landed, so a failure here is returned
   for the caller to log, never thrown.
   -------------------------------------------------------------------------- */

type Sb = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function carrySoPhotoToPoLines(
  sb: Sb,
  soItemId: string,
  change: { add: string } | { remove: string },
): Promise<string | null> {
  const { data: lines, error } = await sb
    .from('purchase_order_items')
    .select('id, purchase_order_id, photo_urls')
    .eq('so_item_id', soItemId);
  if (error) return error.message as string;
  const rows = (lines ?? []) as Array<{ id: string; purchase_order_id: string; photo_urls: string[] | null }>;
  if (rows.length === 0) return null;

  const { data: pos, error: poErr } = await sb
    .from('purchase_orders')
    .select('id, status')
    .in('id', [...new Set(rows.map((r) => r.purchase_order_id))]);
  if (poErr) return poErr.message as string;
  const cancelled = new Set(
    ((pos ?? []) as Array<{ id: string; status: string | null }>)
      .filter((p) => p.status === 'CANCELLED')
      .map((p) => p.id),
  );

  for (const r of rows) {
    if (cancelled.has(r.purchase_order_id)) continue;
    const keys = r.photo_urls ?? [];
    const next = 'add' in change
      ? (keys.includes(change.add) ? null : [...keys, change.add])
      : (keys.includes(change.remove) ? keys.filter((k) => k !== change.remove) : null);
    if (!next) continue;
    const { error: updErr } = await sb.from('purchase_order_items').update({ photo_urls: next }).eq('id', r.id);
    if (updErr) return updErr.message as string;
  }
  return null;
}
