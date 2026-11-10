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
import { rackSplitError, type RackSplit } from '../shared/rack-split';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses (grn-scan-load.ts)
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

// After the L / R only digits follow, so a handwritten digit read as a
// look-alike letter is that digit: 2990 DO-2610-077's "L16.2" came back "L1b-2".
const DIGIT_LOOKALIKE: Record<string, string> = { b: '6', G: '6', S: '5', s: '5', O: '0', o: '0', I: '1', l: '1', '|': '1', Z: '2', z: '2' };

/** "R7-2", "R:11-2", "L-19-2", "L1b-2", "R6·2", "Rack L19.2" -> "R7.2" style; anything else null. */
export function rackKey(text: string | null | undefined): string | null {
  const head = /^\s*(?:RACK\s*)?([LR])(.*)$/i.exec(text ?? '');
  if (!head) return null;
  const rest = head[2].replace(/[bGSsOoIl|Zz]/g, (ch) => DIGIT_LOOKALIKE[ch] ?? ch);
  const m = /^\s*[:.-]?\s*(\d{1,3})\s*[-./,_·•: ]\s*(\d{1,2})\s*$/.exec(rest);
  return m ? `${head[1].toUpperCase()}${Number(m[1])}.${Number(m[2])}` : null;
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

/**
 * Put each handwritten rack on its draft line. `racks` is poItemId -> rack as
 * written -> the qty its rows put there. One rack for the whole line sets the
 * line's rack, as before. Rows of one line written onto several racks (LH6-1,
 * LV6-1, LH6-1) become that line's rack split (scm.grn_item_racks), each rack
 * with its own qty, exactly as the GRN page saves a split. Best-effort.
 */
export async function applyScanRacks(
  svc: SupabaseClient,
  companyId: number | null,
  grnIds: string[],
  racks: Record<string, Record<string, number>>,
): Promise<ScanRackResult> {
  const out: ScanRackResult = { written: 0, filled: 0, unknown: [], failed: false };
  if (grnIds.length === 0 || Object.keys(racks).length === 0) return out;
  const scoped = <Q>(q: Q): Q => scopeToCompanyIdOrOpen(q, companyId);

  const { data: grns, error: grnErr } = await scoped(svc.from('grns').select('id, warehouse_id, status').in('id', grnIds));
  const { data: items, error: itemErr } = await scoped(svc.from('grn_items').select('id, company_id, grn_id, purchase_order_item_id, item_code, rack_id, qty_accepted').in('grn_id', grnIds));
  if (grnErr || itemErr) { console.error('[scan-gr racks] load failed:', grnErr?.message ?? itemErr?.message); return { ...out, failed: true }; }
  const whOf = new Map((grns as Array<{ id: string; warehouse_id: string | null; status: string }>)
    .filter((g) => g.status === 'DRAFT').map((g) => [g.id, g.warehouse_id]));
  const warehouseIds = [...new Set([...whOf.values()].filter((w): w is string => Boolean(w)))];
  const { data: rackRows, error: rackErr } = warehouseIds.length > 0
    ? await scoped(svc.from('warehouse_racks').select('id, rack, warehouse_id').in('warehouse_id', warehouseIds))
    : { data: [], error: null };
  if (rackErr) { console.error('[scan-gr racks] rack list failed:', rackErr.message); return { ...out, failed: true }; }
  const rackList = rackRows as Array<{ id: string; rack: string; warehouse_id: string }>;

  type Item = { id: string; company_id: number | null; grn_id: string; purchase_order_item_id: string | null; item_code: string; rack_id: string | null; qty_accepted: number | null };
  for (const it of items as Item[]) {
    const written = Object.entries((it.purchase_order_item_id ? racks[it.purchase_order_item_id] : undefined) ?? {}).filter(([w, q]) => w.trim() !== '' && q > 0);
    const wh = whOf.get(it.grn_id);
    if (written.length === 0 || !wh) continue;
    out.written += 1;
    const shares = new Map<string, number>(); // rack id -> qty
    let unknown = false;
    for (const [w, q] of written) {
      const rack = resolveRack(w, rackList.filter((r) => r.warehouse_id === wh));
      if (!rack) { out.unknown.push({ written: w, itemCode: it.item_code }); unknown = true; continue; }
      shares.set(rack.id, (shares.get(rack.id) ?? 0) + q);
    }
    if (shares.size === 0 || it.rack_id) continue;
    if (shares.size === 1 && !unknown) {
      const { error } = await scoped(svc.from('grn_items').update({ rack_id: [...shares.keys()][0] }).eq('id', it.id));
      if (error) { console.error('[scan-gr racks] set failed:', it.id, error.message); out.failed = true; continue; }
      out.filled += 1;
      continue;
    }
    // Never more on the racks than the line received.
    let left = Number(it.qty_accepted ?? 0);
    const split: RackSplit[] = [];
    for (const [rackId, q] of shares) { const take = Math.min(q, left); if (take > 0) split.push({ rackId, qty: take }); left -= take; }
    const company = it.company_id ?? companyId;
    if (split.length === 0 || company == null || rackSplitError(Number(it.qty_accepted ?? 0), split)) continue;
    const { error: insErr } = await svc.from('grn_item_racks').insert(split.map((s) => ({ company_id: company, grn_item_id: it.id, rack_id: s.rackId, qty: s.qty, created_by: null })));
    if (insErr) { console.error('[scan-gr racks] split failed:', it.id, insErr.message); out.failed = true; continue; }
    if (split.length === 1) {
      const { error } = await scoped(svc.from('grn_items').update({ rack_id: split[0].rackId }).eq('id', it.id));
      if (error) { console.error('[scan-gr racks] set failed:', it.id, error.message); out.failed = true; continue; }
    }
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
