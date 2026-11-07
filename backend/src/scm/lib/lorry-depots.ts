/* Each lorry's home: the warehouse it starts and ends the day at (its home warehouse,
   else the first it serves), geocoded cache-first, so a Penang lorry's route leaves
   Penang (owner 2026-11-07). A lorry absent here uses the day's depot.
   company-scope: the lorry fleet is one shared master across companies, read whole like
   GET /trips/day's masters. */
import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { composeAddress, geocodeAddressCached } from './geocode';
import { normalizePlate } from './plate-normalize';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema-parameterised scm client, same alias as geocode.ts
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export type LorryDepot = { warehouseId: string; name: string; lat: number; lng: number };

/** The home warehouse id of each lorry, by normalized plate. PURE. */
export function lorryHomes(rows: ReadonlyArray<{ plate: unknown; warehouse_id: unknown; warehouse_ids: unknown }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of rows) {
    const ids = Array.isArray(l.warehouse_ids) ? (l.warehouse_ids as unknown[]).map(String) : [];
    const home = (typeof l.warehouse_id === 'string' && l.warehouse_id) || ids[0] || null;
    const plate = normalizePlate(typeof l.plate === 'string' ? l.plate : null);
    if (home && plate) out.set(plate, home);
  }
  return out;
}

export async function loadLorryDepots(sb: SupabaseClient, env: { GOOGLE_MAPS_API_KEY?: string }): Promise<{ lorryDepots: Record<string, LorryDepot>; lorryDepotsReason: string | null }> {
  const { data: lorryRows, error: lErr } = await sb.from('lorries').select('plate, warehouse_id, warehouse_ids');
  if (lErr) return { lorryDepots: {}, lorryDepotsReason: `lorries could not be read: ${lErr.message}` };
  const homeOf = lorryHomes(lorryRows ?? []);
  const whIds = [...new Set(homeOf.values())];
  if (whIds.length === 0) return { lorryDepots: {}, lorryDepotsReason: null };
  const { data: whRows, error: wErr } = await sb.from('warehouses').select('id, name, location, city, state, postcode, latitude, longitude').in('id', whIds);
  if (wErr) return { lorryDepots: {}, lorryDepotsReason: `warehouses could not be read: ${wErr.message}` };
  const point = new Map<string, { name: string; lat: number; lng: number }>();
  for (const w of (whRows ?? []) as Array<Record<string, unknown>>) {
    const addr = composeAddress({
      address1: (w.location ?? null) as string | null, address2: (w.city ?? null) as string | null,
      postcode: (w.postcode ?? null) as string | null, state: (w.state ?? null) as string | null,
    });
    /* The map position the owner set wins; an address is only a fallback. */
    const pinned = w.latitude != null && w.longitude != null ? { lat: Number(w.latitude), lng: Number(w.longitude) } : null;
    const hit = pinned ?? (addr ? await geocodeAddressCached(sb, env, addr) : null);
    if (hit) point.set(String(w.id), { name: String(w.name ?? ''), lat: hit.lat, lng: hit.lng });
  }
  const depots: Record<string, LorryDepot> = {};
  for (const [plate, wh] of homeOf) {
    const p = point.get(wh);
    if (p) depots[plate] = { warehouseId: wh, ...p };
  }
  return { lorryDepots: depots, lorryDepotsReason: null };
}
