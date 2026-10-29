import { qtyCapRefusal } from './qty-cap';

/* Units sitting out on a live REPAIR return, per GRN line. returned_qty leaves
   them out on purpose (adjustGrnReturnedQty: a repair must not re-open the PO or
   the PI headroom), but they are NOT back on the shelf either: the OUT already
   ran, so a second return of the same unit takes stock out twice (HC-0139).
   Every "how much may still be returned" cap subtracts this on top of
   returned_qty. `excludeLineId` is the line being edited (its own units are not
   a second claim). null = a read failed; callers refuse, never assume 0. */
export async function repairHeldQty(sb: any, grnItemIds: string[], excludeLineId: string | null): Promise<Map<string, number> | null> {
  const held = new Map<string, number>();
  if (grnItemIds.length === 0) return held;
  const { data: lines, error: lErr } = await sb.from('purchase_return_items')
    .select('id, grn_item_id, qty_returned, purchase_return_id').in('grn_item_id', grnItemIds);
  if (lErr) { console.error('[repairHeldQty] PR line read failed:', lErr.message); return null; } // eslint-disable-line no-console
  const rows = ((lines ?? []) as Array<{ id: string; grn_item_id: string; qty_returned: number; purchase_return_id: string }>)
    .filter((r) => r.id !== excludeLineId);
  const prIds = [...new Set(rows.map((r) => r.purchase_return_id).filter(Boolean))];
  if (prIds.length === 0) return held;
  const { data: prs, error: pErr } = await sb.from('purchase_returns').select('id, status, kind').in('id', prIds);
  if (pErr) { console.error('[repairHeldQty] PR header read failed:', pErr.message); return null; } // eslint-disable-line no-console
  const live = new Set(((prs ?? []) as Array<{ id: string; status: string; kind: string | null }>)
    .filter((p) => p.kind === 'REPAIR' && (p.status ?? '').toUpperCase() !== 'CANCELLED').map((p) => p.id));
  for (const r of rows) {
    if (live.has(r.purchase_return_id)) held.set(r.grn_item_id, (held.get(r.grn_item_id) ?? 0) + Number(r.qty_returned ?? 0));
  }
  return held;
}

/* Cap for a qty edit on a GRN-linked return line. A REPAIR line is not in
   returned_qty, so its own prior qty is NOT given back; the OTHER live REPAIR
   lines are still held. Every read here fails closed: a failed header read must
   not fall through to "CREDIT" and hand a REPAIR line its own qty back. */
export async function editLineCapRefusal(
  sb: any,
  a: { prId: string; itemId: string; grnItemId: string; qtyReturned: number; prevQty: number },
) {
  const { data: prHead, error: headErr } = await sb.from('purchase_returns').select('kind').eq('id', a.prId).maybeSingle();
  const held = await repairHeldQty(sb, [a.grnItemId], a.itemId);
  if (headErr || !prHead || !held) return { error: 'cap_check_failed', reason: 'repair returns unreadable' };
  const isRepair = (prHead as { kind?: string | null }).kind === 'REPAIR';
  return qtyCapRefusal(sb, {
    table: 'grn_items', id: a.grnItemId,
    capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
    requested: a.qtyReturned, ownPriorDraw: isRepair ? 0 : a.prevQty, extraDrawn: held.get(a.grnItemId) ?? 0, what: 'GRN line',
  });
}

/* Cap for a new GRN-linked line: nothing of its own to give back, every live
   REPAIR line held. Fails closed like the edit cap. */
export async function addLineCapRefusal(sb: any, a: { grnItemId: string; qtyReturned: number }) {
  const held = await repairHeldQty(sb, [a.grnItemId], null);
  if (!held) return { error: 'cap_check_failed', reason: 'repair returns unreadable' };
  return qtyCapRefusal(sb, {
    table: 'grn_items', id: a.grnItemId,
    capColumn: 'qty_accepted', drawnColumns: ['returned_qty'],
    requested: a.qtyReturned, extraDrawn: held.get(a.grnItemId) ?? 0, what: 'GRN line',
  });
}
