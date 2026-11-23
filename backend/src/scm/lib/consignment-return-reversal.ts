// consignment-return-reversal.ts — which Consignment Note ship-out a return's stock-back IN undoes.
import type { writeMovements } from './inventory-movements';

/* A return's IN names the Consignment Note ship-out (CS_DO OUT) it brings back, so the FIFO trigger
   (20261123T0100) re-opens only what that ship-out took from the lots. A ship-out that found no stock
   took nothing, and its return used to open a full lot anyway, leaving lots above the balance.
   One OUT per (note, item, variant) — the CS_DO unique index — and each is named at most once.
   A free-entry return (no note on the header or its lines) is unchanged. */
export async function nameTheShipOutsReturned(
  sb: Parameters<typeof writeMovements>[0],
  writes: Array<{ movement_type: string; item_code: string; variant_key?: string; reverses_movement_id?: string }>,
  returnId: string,
  headerNoteId: string | null,
): Promise<void> {
  if (!writes.some((w) => w.movement_type === 'IN')) return;
  const fail = (what: string, message: string) => {
    // eslint-disable-next-line no-console
    console.error(`[consignment-return] ${what} read failed; the return re-opens its full qty:`, message);
  };
  /* The note is named per LINE (consignment_do_item_id); the header's consignment_do_id is often empty. */
  const { data: lines, error: linesErr } = await sb.from('consignment_delivery_return_items')
    .select('consignment_do_item_id').eq('consignment_delivery_return_id', returnId);
  if (linesErr) { fail('return line', linesErr.message); return; }
  const noteItemIds = [...new Set(((lines ?? []) as Array<{ consignment_do_item_id: string | null }>)
    .map((l) => l.consignment_do_item_id).filter((x): x is string => !!x))];
  const noteIds = new Set<string>(headerNoteId ? [headerNoteId] : []);
  if (noteItemIds.length > 0) {
    const { data: noteLines, error: noteErr } = await sb.from('consignment_delivery_order_items')
      .select('consignment_delivery_order_id').in('id', noteItemIds);
    if (noteErr) { fail('note line', noteErr.message); return; }
    for (const n of (noteLines ?? []) as Array<{ consignment_delivery_order_id: string | null }>) {
      if (n.consignment_delivery_order_id) noteIds.add(n.consignment_delivery_order_id);
    }
  }
  if (noteIds.size === 0) return;
  const { data: outs, error } = await sb.from('inventory_movements')
    .select('id, item_code, variant_key')
    .eq('source_doc_type', 'CS_DO').in('source_doc_id', [...noteIds]).eq('movement_type', 'OUT');
  if (error) { fail('ship-out', error.message); return; }
  const outIds = ((outs ?? []) as Array<{ id: string }>).map((o) => o.id);
  if (outIds.length === 0) return;
  const { data: named, error: namedErr } = await sb.from('inventory_movements')
    .select('reverses_movement_id').in('reverses_movement_id', outIds);
  if (namedErr) { fail('reversal', namedErr.message); return; }
  const taken = new Set(((named ?? []) as Array<{ reverses_movement_id: string }>).map((r) => r.reverses_movement_id));
  for (const w of writes) {
    if (w.movement_type !== 'IN') continue;
    const o = ((outs ?? []) as Array<{ id: string; item_code: string; variant_key: string | null }>)
      .find((x) => !taken.has(x.id) && x.item_code === w.item_code && (x.variant_key ?? '') === (w.variant_key ?? ''));
    if (!o) continue;
    w.reverses_movement_id = o.id;
    taken.add(o.id);
  }
}
