// ---------------------------------------------------------------------------
// grn-scan-racks — the rack the warehouse handwrote beside a delivery-order row
// ("R11-2"), put on the scanned DRAFT's line when it names a rack of that GRN's
// warehouse ("Rack R11.2"). A draft's rack is placement only (grn-line-rack.ts
// row_only), so this moves no stock; posting places the goods. Unreadable or
// unknown racks are left blank for the warehouse to pick. Sim, 2026-10-20.
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { scopeToCompanyIdOrOpen } from './companyScope';
import { normalizeCode } from './grn-scan-match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses (grn-scan-load.ts)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

/** "R7-2", "R:11-2", "L-19-2", "Rack L19.2", "r 7.2" -> "R7.2"; anything else null. */
export function rackKey(text: string | null | undefined): string | null {
  const m = /^\s*(?:RACK\s*)?([LR])\s*[:.-]?\s*(\d{1,3})\s*[-./,_ ]\s*(\d{1,2})\s*$/i.exec(text ?? '');
  return m ? `${m[1].toUpperCase()}${Number(m[2])}.${Number(m[3])}` : null;
}

/**
 * The one rack of `racks` a handwritten value names, or null. Our L/R shelf
 * labels compare by rackKey; any other label only on an exact match of letters
 * and digits, and never when two labels would fit.
 */
export function resolveRack<T extends { rack: string }>(written: string, racks: T[]): T | null {
  const key = rackKey(written);
  const hits = key
    ? racks.filter((r) => rackKey(r.rack) === key)
    : racks.filter((r) => normalizeCode(r.rack.replace(/^\s*rack\s*/i, '')) === normalizeCode(written) && normalizeCode(written) !== '');
  return hits.length === 1 ? hits[0] : null;
}

export type ScanRackResult = { written: number; filled: number; unknown: Array<{ written: string; itemCode: string }>; failed: boolean };

/** Put each handwritten rack on its draft line (`racks` is poItemId -> as written). Best-effort. */
export async function applyScanRacks(
  svc: SupabaseClient,
  companyId: number | null,
  grnIds: string[],
  racks: Record<string, string>,
): Promise<ScanRackResult> {
  const out: ScanRackResult = { written: 0, filled: 0, unknown: [], failed: false };
  if (grnIds.length === 0 || Object.keys(racks).length === 0) return out;
  const scoped = <Q>(q: Q): Q => scopeToCompanyIdOrOpen(q, companyId);

  const { data: grns, error: grnErr } = await scoped(svc.from('grns').select('id, warehouse_id, status').in('id', grnIds));
  const { data: items, error: itemErr } = await scoped(svc.from('grn_items').select('id, grn_id, purchase_order_item_id, item_code, rack_id').in('grn_id', grnIds));
  if (grnErr || itemErr) { console.error('[scan-gr racks] load failed:', grnErr?.message ?? itemErr?.message); return { ...out, failed: true }; }
  const whOf = new Map((grns as Array<{ id: string; warehouse_id: string | null; status: string }>)
    .filter((g) => g.status === 'DRAFT').map((g) => [g.id, g.warehouse_id]));
  const warehouseIds = [...new Set([...whOf.values()].filter((w): w is string => Boolean(w)))];
  const { data: rackRows, error: rackErr } = warehouseIds.length > 0
    ? await scoped(svc.from('warehouse_racks').select('id, rack, warehouse_id').in('warehouse_id', warehouseIds))
    : { data: [], error: null };
  if (rackErr) { console.error('[scan-gr racks] rack list failed:', rackErr.message); return { ...out, failed: true }; }
  const rackList = rackRows as Array<{ id: string; rack: string; warehouse_id: string }>;

  for (const it of items as Array<{ id: string; grn_id: string; purchase_order_item_id: string | null; item_code: string; rack_id: string | null }>) {
    const written = it.purchase_order_item_id ? racks[it.purchase_order_item_id] : undefined;
    const wh = whOf.get(it.grn_id);
    if (!written || !wh) continue;
    out.written += 1;
    const rack = resolveRack(written, rackList.filter((r) => r.warehouse_id === wh));
    if (!rack) { out.unknown.push({ written, itemCode: it.item_code }); continue; }
    if (it.rack_id) continue;
    const { error } = await scoped(svc.from('grn_items').update({ rack_id: rack.id }).eq('id', it.id));
    if (error) { console.error('[scan-gr racks] set failed:', it.id, error.message); out.failed = true; continue; }
    out.filled += 1;
  }
  return out;
}

/** The operator note for what was filled, or null when no rack was written. */
export function scanRackNote(r: ScanRackResult): string | null {
  if (r.written === 0) return null;
  const head = `Racks from the delivery order: ${r.filled} of ${r.written} ${r.written === 1 ? 'line' : 'lines'} filled, check them before posting.`;
  const why = r.unknown.length > 0
    ? ` Not a rack of this warehouse, please pick: ${r.unknown.slice(0, 10).map((u) => `${u.written} (${u.itemCode})`).join('; ')}${r.unknown.length > 10 ? `; and ${r.unknown.length - 10} more` : ''}.`
    : '';
  return head + why;
}
