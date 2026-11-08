// Coverage & Fleet, lorries (owner 2026-11-07): the pure rules behind the lorry cards
// and drawer, so the screen only renders. A lorry's home warehouse is where it starts
// and ends the day; the warehouses it also picks up from are grouped by region.
import type { LorryRow } from "../../../vendor/scm/lib/lorries-queries";

export type WarehouseLite = { id: string; code: string; name: string };

export const REGIONS = ["Klang Valley", "Showrooms", "Penang", "Sabah", "Sarawak", "China", "Other"] as const;
export type Region = (typeof REGIONS)[number];

/** The region a warehouse sits in, from its code and name. A display or showroom is a
 *  showroom wherever it is, except a Penang, Sabah or Sarawak display, which belongs to
 *  that state so its lorries find it. */
export function warehouseRegion(w: WarehouseLite): Region {
  const s = `${w.code} ${w.name}`.toUpperCase();
  if (/\bPG\b|PENANG/.test(s)) return "Penang";
  if (/\bSBH\b|SABAH/.test(s)) return "Sabah";
  if (/\bSRW\b|SARAWAK/.test(s)) return "Sarawak";
  if (/CHINA|GUANGZHOU/.test(s)) return "China";
  if (/SHOWROOM|DISPLAY|STUDIO|SUITE|C&C|CASH & CARRY/.test(s)) return "Showrooms";
  if (/\bKL\b|KUALA|BALAKONG|KELANA|HQ|HEADQUARTER|SELANGOR/.test(s)) return "Klang Valley";
  return "Other";
}

export function groupWarehouses(ws: readonly WarehouseLite[]): Array<{ region: Region; items: WarehouseLite[] }> {
  return REGIONS.map((region) => ({ region, items: ws.filter((w) => warehouseRegion(w) === region).sort((a, b) => a.name.localeCompare(b.name)) }))
    .filter((g) => g.items.length > 0);
}

/** Home warehouse id: the one chosen, else the first it serves. */
export const lorryHome = (l: LorryRow): string | null => l.warehouse_id ?? l.warehouse_ids?.[0] ?? null;

/** The other warehouses it picks up from (its home left out). */
export const alsoServes = (l: LorryRow): string[] => (l.warehouse_ids ?? []).filter((id) => id !== lorryHome(l));

const num = (v: number | string | null | undefined): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
};

/** Cargo box in feet, or null when any side is missing. */
export function boxOf(l: LorryRow): { length: number; width: number; height: number; m3: number } | null {
  const length = num(l.length_ft), width = num(l.width_ft), height = num(l.height_ft);
  if (length == null || width == null || height == null) return null;
  return { length, width, height, m3: Math.round(length * width * height * 0.0283168 * 10) / 10 };
}

/** Lorries under their home warehouse, homes in name order, a lorry with none last. */
export function byHome(lorries: readonly LorryRow[], ws: readonly WarehouseLite[]): Array<{ homeId: string | null; label: string; lorries: LorryRow[] }> {
  const name = new Map(ws.map((w) => [w.id, w.name]));
  const groups = new Map<string | null, LorryRow[]>();
  for (const l of lorries) { const h = lorryHome(l); groups.set(h, [...(groups.get(h) ?? []), l]); }
  return [...groups.entries()]
    .map(([homeId, list]) => ({ homeId, label: homeId ? name.get(homeId) ?? "Unknown warehouse" : "No home warehouse set", lorries: [...list].sort((a, b) => a.plate.localeCompare(b.plate)) }))
    .sort((a, b) => Number(a.homeId == null) - Number(b.homeId == null) || a.label.localeCompare(b.label));
}

/** A lorry matches the search on its plate, model or usual driver's name. */
export function lorryMatches(l: LorryRow, q: string, driverName: string | null): boolean {
  const s = q.trim().toLowerCase();
  return !s || `${l.plate} ${l.model ?? ""} ${driverName ?? ""}`.toLowerCase().includes(s);
}
