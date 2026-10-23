// ----------------------------------------------------------------------------
// inventory-netting — Σ delivered / Σ returned per SO line id, for the
// Inventory page's Reserved / Available figures (GET /inventory/products).
//
// Only non-cancelled AND shipped DOs count as delivered (doCountsAsDelivered:
// a DRAFT or LOADED DO hasn't moved stock); only non-cancelled returns traced
// back through a counted DO line count as returned. Mirrors so-readiness's
// soDeliverableRemaining leak guard.
//
// Two ways to the same answer (HC-0002, 2026-10-22: this step took 13.6 s on
// prod, four serial uuid-chunked reads over thousands of open SO lines):
//   - nettingFromEmbedded: the DO lines, their DO status, their returns and the
//     return status come back EMBEDDED in the SO-demand read itself, so the
//     step costs no extra round trip;
//   - deliveredReturnedBySoItem: the original four reads, kept as the fallback
//     when the embedded read is refused.
// tests/inventoryNetting.test.ts pins that both give the same maps.
// ----------------------------------------------------------------------------

import { doCountsAsDelivered } from '../shared/do-shipped-states';
import { chunkIn } from './paginate-all';

export type Netting = { deliveredBySoItem: Map<string, number>; returnedBySoItem: Map<string, number> };

/** The embed the SO-demand read adds: each line's DO lines with their DO's status, and those lines' returns with the return's status. */
export const NETTING_EMBED =
  'do_lines:delivery_order_items(id, qty, delivery_order:delivery_orders(status), returns:delivery_return_items(qty_returned, delivery_return:delivery_returns(status)))';

type One<T> = T | T[] | null | undefined;
const one = <T>(x: One<T>): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));

export type EmbeddedDemandLine = {
  id: string;
  do_lines?: Array<{
    id: string;
    qty: number | null;
    delivery_order: One<{ status: string | null }>;
    returns?: Array<{ qty_returned: number | null; delivery_return: One<{ status: string | null }> }> | null;
  }> | null;
};

export function nettingFromEmbedded(lines: readonly EmbeddedDemandLine[]): Netting {
  const deliveredBySoItem = new Map<string, number>();
  const returnedBySoItem = new Map<string, number>();
  for (const line of lines) {
    for (const dl of line.do_lines ?? []) {
      const d = one(dl.delivery_order);
      if (!d || !doCountsAsDelivered(d.status)) continue;
      deliveredBySoItem.set(line.id, (deliveredBySoItem.get(line.id) ?? 0) + Number(dl.qty ?? 0));
      for (const rl of dl.returns ?? []) {
        const r = one(rl.delivery_return);
        if (!r || (r.status ?? '').toUpperCase() === 'CANCELLED') continue;
        returnedBySoItem.set(line.id, (returnedBySoItem.get(line.id) ?? 0) + Number(rl.qty_returned ?? 0));
      }
    }
  }
  return { deliveredBySoItem, returnedBySoItem };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js client every SCM read helper takes
export async function deliveredReturnedBySoItem(sb: any, soItemIds: string[]): Promise<Netting> {
  const deliveredBySoItem = new Map<string, number>();
  const returnedBySoItem = new Map<string, number>();
  if (soItemIds.length === 0) return { deliveredBySoItem, returnedBySoItem };

  const { data: doLines, error: doLinesErr } = await chunkIn<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>(soItemIds, (batch, from, to) => sb
    .from('delivery_order_items')
    .select('id, so_item_id, qty, delivery_order_id')
    .in('so_item_id', batch)
    .order('id')
    .range(from, to));
  // The old copy read these as empty on failure and netted nothing — a wrong
  // Available rather than an error. A failed read now fails the request.
  if (doLinesErr) throw new Error(`delivery order lines: ${doLinesErr.message}`);
  const doLineRows = (doLines ?? []) as Array<{ id: string; so_item_id: string | null; qty: number; delivery_order_id: string }>;
  const doIds = [...new Set(doLineRows.map((l) => l.delivery_order_id).filter(Boolean))];
  const activeDoIds = new Set<string>();
  const doLineToSoItem = new Map<string, string>();
  if (doIds.length > 0) {
    const { data: dos, error: dosErr } = await chunkIn<{ id: string; status: string | null }>(doIds, (batch, from, to) =>
      sb.from('delivery_orders').select('id, status').in('id', batch).order('id').range(from, to));
    if (dosErr) throw new Error(`delivery orders: ${dosErr.message}`);
    for (const d of (dos ?? []) as Array<{ id: string; status: string | null }>) {
      // A PRE-SHIP DO hasn't shipped and hasn't moved stock — excluding it
      // (like soDeliverableRemaining's LEAK GUARD) keeps its units in Reserved
      // so a free-to-sell KPI can't be inflated into over-sell. DRAFT *and*
      // LOADED: this read named only DRAFT until 2026-08-20. (DRs have no
      // DRAFT.)
      if (doCountsAsDelivered(d.status)) activeDoIds.add(d.id);
    }
  }
  for (const l of doLineRows) {
    if (!l.so_item_id || !activeDoIds.has(l.delivery_order_id)) continue;
    doLineToSoItem.set(l.id, l.so_item_id);
    deliveredBySoItem.set(l.so_item_id, (deliveredBySoItem.get(l.so_item_id) ?? 0) + Number(l.qty ?? 0));
  }

  const activeDoLineIds = [...doLineToSoItem.keys()];
  if (activeDoLineIds.length > 0) {
    const { data: drLines, error: drLinesErr } = await chunkIn<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>(activeDoLineIds, (batch, from, to) => sb
      .from('delivery_return_items')
      .select('do_item_id, qty_returned, delivery_return_id')
      .in('do_item_id', batch)
      .order('id')
      .range(from, to));
    if (drLinesErr) throw new Error(`delivery return lines: ${drLinesErr.message}`);
    const drLineRows = (drLines ?? []) as Array<{ do_item_id: string | null; qty_returned: number; delivery_return_id: string }>;
    const drIds = [...new Set(drLineRows.map((l) => l.delivery_return_id).filter(Boolean))];
    const activeDrIds = new Set<string>();
    if (drIds.length > 0) {
      const { data: drs, error: drsErr } = await chunkIn<{ id: string; status: string | null }>(drIds, (batch, from, to) =>
        sb.from('delivery_returns').select('id, status').in('id', batch).order('id').range(from, to));
      if (drsErr) throw new Error(`delivery returns: ${drsErr.message}`);
      for (const d of (drs ?? []) as Array<{ id: string; status: string | null }>) {
        if ((d.status ?? '').toUpperCase() !== 'CANCELLED') activeDrIds.add(d.id);
      }
    }
    for (const l of drLineRows) {
      if (!l.do_item_id || !activeDrIds.has(l.delivery_return_id)) continue;
      const soItemId = doLineToSoItem.get(l.do_item_id);
      if (!soItemId) continue;
      returnedBySoItem.set(soItemId, (returnedBySoItem.get(soItemId) ?? 0) + Number(l.qty_returned ?? 0));
    }
  }

  return { deliveredBySoItem, returnedBySoItem };
}
