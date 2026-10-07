/* Which stock INs a re-posted GRN is missing, and which original IN to copy.

   The shape this repairs: a POSTED GRN was cancelled (the cancel wrote one OUT
   per line, note GRN_CANCEL_NOTE), its status was then set back by hand in the
   database, and it was posted again. postGrnAndRollup's "already booked" guard
   counts IN rows only, saw the first post's INs and skipped the stock. The GRN
   reads POSTED and the PO received, but stock is short by the reversal.

   Pure: takes rows, returns a plan. Anything that is not exactly that shape is
   refused with a reason, never guessed at. */

export const GRN_CANCEL_NOTE = 'GRN cancelled — reversing receipt';

/**
 * @param {{ status: string, migrated_no_stock: boolean | null }} grn
 * @param {Array<{ item_code: string, qty_accepted: number, item_group: string | null }>} lines
 * @param {Array<{ id: string, movement_type: string, item_code: string, variant_key: string | null,
 *   warehouse_id: string, qty: number, unit_cost_sen: number | null, notes: string | null, created_at: string }>} movements
 *   every movement with source_doc_type GRN and this GRN's id
 */
export function planGrnStockRestore(grn, lines, movements) {
  if (String(grn.status).toUpperCase() !== 'POSTED') return { refuse: `GRN is ${grn.status}, not POSTED` };
  if (grn.migrated_no_stock) return { refuse: 'GRN is a migrated receipt that never booked stock' };

  const expected = new Map();
  for (const l of lines) {
    if (l.item_group === 'service' || !(l.qty_accepted > 0)) continue;
    expected.set(l.item_code, (expected.get(l.item_code) ?? 0) + l.qty_accepted);
  }

  const restore = [];
  const refused = [];
  for (const [code, want] of expected) {
    const mine = movements.filter((m) => m.item_code === code);
    const buckets = new Set(mine.map((m) => `${m.warehouse_id}|${m.variant_key ?? ''}`));
    const ins = mine.filter((m) => m.movement_type === 'IN');
    const outs = mine.filter((m) => m.movement_type === 'OUT');
    const net = ins.reduce((s, m) => s + m.qty, 0) - outs.reduce((s, m) => s + m.qty, 0);
    if (net === want) continue;
    if (buckets.size !== 1) { refused.push({ code, why: `${buckets.size} stock buckets, expected one` }); continue; }
    if (mine.some((m) => m.movement_type !== 'IN' && m.movement_type !== 'OUT')) {
      refused.push({ code, why: 'has movements other than IN/OUT' }); continue;
    }
    const cancelOut = outs.filter((m) => m.notes === GRN_CANCEL_NOTE).reduce((s, m) => s + m.qty, 0);
    const missing = want - net;
    if (missing <= 0 || cancelOut !== missing) {
      refused.push({ code, why: `net ${net} vs accepted ${want}, cancel reversal ${cancelOut}: not the re-post gap` }); continue;
    }
    const template = [...ins].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!template) { refused.push({ code, why: 'no original IN to copy' }); continue; }
    if (!(Number(template.unit_cost_sen) > 0)) { refused.push({ code, why: 'original IN has zero cost' }); continue; }
    restore.push({ code, qty: missing, templateId: template.id, unitCostSen: Number(template.unit_cost_sen), net, want });
  }
  return { restore, refused };
}
