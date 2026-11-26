import type { writeMovements } from './inventory-movements';

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
