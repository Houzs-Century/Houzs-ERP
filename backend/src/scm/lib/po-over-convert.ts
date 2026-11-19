// ----------------------------------------------------------------------------
// po-over-convert — the remaining-qty cap for SO-sourced lines on the generic
// PO-create path (POST /mfg-purchase-orders).
//
// The desktop "create new PO from SO" flow feeds picked SO lines through the
// generic create (New-PO-form), which — unlike /from-sos (convertSosToPosCore,
// which keeps 2990's cap) — had no server-side check that a line orders no more
// than the source SO still needs. This is the shared, testable core of that cap;
// see BUG-HISTORY 2026-07-24 and docs/2990-parity-allocation-costing.md.
//
// Manual lines (no soItemId) contribute nothing, so a purely-manual PO never
// trips the cap. MRP never routes through the generic create, so there is no
// fromMrp case here.
// ----------------------------------------------------------------------------

/* A company-1 bound line's cap also counts MRP-origin purchase orders; re-exported
   so the PO router (over its size ceiling) keeps one import line. */
export { loadBoundOrderedQty, boundAwarePicked, isBoundForCompany } from './bound-line-ordered';

export type OverConvertOffender = { soItemId: string; requested: number; remaining: number };

/** Headroom for ONE PO line binding to one SO line, i.e. the largest qty that
 *  line may order. The base is the same `qty - po_qty_picked` the batch cap uses.
 *
 *  `ownCurrentQty` is the qty THIS SAME PO line already contributes to that SO
 *  line's `po_qty_picked`, and it is added back. Without it a line already bound
 *  at qty 5 could not be edited to 5 (or to 4): its own 5 sits inside
 *  po_qty_picked, so the raw remaining reads 0 and a harmless no-op edit would
 *  409. Pass 0 whenever this line does not yet count toward that SO line —
 *  add-line, or a line-edit that REBINDS from one SO line to another (the new
 *  target has none of this line's qty in its counter yet).
 *
 *  Clamped at 0: an SO line already over-picked (picked > qty, possible on
 *  historical rows) yields no headroom rather than a negative ceiling. */
export function soLineHeadroom(
  soRow: { qty: number; po_qty_picked: number },
  ownCurrentQty = 0,
): number {
  const base = Number(soRow.qty ?? 0) - Number(soRow.po_qty_picked ?? 0);
  return Math.max(0, base + Math.max(0, Number(ownCurrentQty ?? 0)));
}

/** Sum the requested qty per source SO line across `items`, and return the FIRST
 *  SO line whose summed request exceeds its remaining (`qty - po_qty_picked`),
 *  or null when every SO-sourced line fits. One SO line split across several PO
 *  lines counts once, in full (mirrors recomputeSoPicked / loadDraftedQtyBySoItem). */
export function findOverConvertOffender(
  items: ReadonlyArray<Record<string, unknown>>,
  soRows: ReadonlyArray<{ id: string; qty: number; po_qty_picked: number }>,
): OverConvertOffender | null {
  const requestedBySoItem = new Map<string, number>();
  for (const it of items) {
    const sid = (it.soItemId as string | undefined) ?? null;
    if (!sid) continue;
    const q = Math.max(0, Number(it.qty ?? 0));
    if (q > 0) requestedBySoItem.set(sid, (requestedBySoItem.get(sid) ?? 0) + q);
  }
  for (const r of soRows) {
    const requested = requestedBySoItem.get(r.id) ?? 0;
    if (requested <= 0) continue;
    const remaining = Number(r.qty ?? 0) - Number(r.po_qty_picked ?? 0);
    if (requested > remaining) return { soItemId: r.id, requested, remaining };
  }
  return null;
}

/* ── SO-link remaining-qty cap (LINE level) ─────────────────────────────────
   soLinkTargetRefusal above proves a bind is POINTED at a legitimate SO line;
   it says nothing about HOW MUCH that line may order. The batch paths all cap
   it — /from-sos via `!fromMrp && p.qty > remaining`, the generic create via
   findOverConvertOffender, /:id/convert-from-so by deriving qty server-side as
   the unpicked remainder — but add-line and line-edit did not, so an operator
   could append (or edit up to) any qty against an SO line that was already
   fully converted. That is the same double-ordering the F1 audit closed on
   /:id/convert-from-so in 2026-06-10, reachable through the two paths that
   accept an operator-supplied qty.

   Repeat conversion stays legal — the business splits one SO across several POs
   on purpose. The ceiling is what is capped, never the second conversion.

   Overridable with confirmOverConvert, the SAME escape hatch the generic create
   documents, so a deliberate over-order is still one explicit flag away. */
export async function soLineOverConvertRefusal(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client is untyped
  sb: any,
  soItemId: string | null,
  requestedQty: number,
  ownCurrentQty: number,
): Promise<OverConvertOffender | null> {
  if (!soItemId) return null;
  const { data } = await sb
    .from('mfg_sales_order_items')
    .select('id, qty, po_qty_picked')
    .eq('id', soItemId)
    .maybeSingle();
  const row = data as { qty: number; po_qty_picked: number } | null;
  /* Unknown / cross-company line: soLinkTargetRefusal already refused it with a
     404 before we get here, so there is nothing left to cap. */
  if (!row) return null;
  const remaining = soLineHeadroom(row, ownCurrentQty);
  const requested = Math.max(0, Number(requestedQty ?? 0));
  return requested > remaining ? { soItemId, requested, remaining } : null;
}
