// consignment-return-reversal.ts — which Consignment Note ship-out a return's stock-back IN undoes.
import type { writeMovements } from './inventory-movements';

/* A return's IN names the Consignment Note ship-out (CS_DO OUT) it brings back, so the FIFO trigger
   (20261123T0100) re-opens only what that ship-out took from the lots. A ship-out that found no stock
   took nothing, and its return used to open a full lot anyway, leaving lots above the balance.
   One OUT per (note, item, variant) — the CS_DO unique index — and each is named at most once.
   A free-entry return (no note) is unchanged. */
export async function nameTheShipOutsReturned(
  sb: Parameters<typeof writeMovements>[0],
  writes: Array<{ movement_type: string; item_code: string; variant_key?: string; reverses_movement_id?: string }>,
  noteId: string | null,
): Promise<void> {
  if (!noteId || !writes.some((w) => w.movement_type === 'IN')) return;
  const { data: outs, error } = await sb.from('inventory_movements')
    .select('id, item_code, variant_key')
    .eq('source_doc_type', 'CS_DO').eq('source_doc_id', noteId).eq('movement_type', 'OUT');
  // eslint-disable-next-line no-console
  if (error) { console.error('[consignment-return] ship-out read failed; the return re-opens its full qty:', error.message); return; }
  const outIds = ((outs ?? []) as Array<{ id: string }>).map((o) => o.id);
  if (outIds.length === 0) return;
  const { data: named, error: namedErr } = await sb.from('inventory_movements')
    .select('reverses_movement_id').in('reverses_movement_id', outIds);
  // eslint-disable-next-line no-console
  if (namedErr) { console.error('[consignment-return] reversal read failed; the return re-opens its full qty:', namedErr.message); return; }
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
