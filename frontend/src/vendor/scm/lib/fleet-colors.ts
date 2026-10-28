// ----------------------------------------------------------------------------
// fleet-colors.ts — the per-lorry route COLOUR assignment for the A4 day map.
//
// Each trip on the day map draws its own route in a distinct colour, and the
// side panel + run-sheet swatch must match. PURE + deterministic: the same set
// of trip ids always yields the same colours, so a reload never reshuffles them
// and the map, the panel and the printed sheet always agree.
// ----------------------------------------------------------------------------

/** A hand-picked, high-contrast palette. Distinct hues that stay legible as a
 *  circle marker + a polyline on a raster map, and print acceptably. Cycles when
 *  a day has more trips than colours (rare — a depot rarely runs >10 lorries). */
export const FLEET_ROUTE_COLORS: readonly string[] = [
  '#2563eb', // blue
  '#dc2626', // red
  '#059669', // green
  '#d97706', // amber
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#db2777', // pink
  '#65a30d', // lime
  '#ea580c', // orange
  '#4f46e5', // indigo
];

/**
 * Assign a stable colour to each trip id, in the ORDER given (the backend already
 * orders trips by trip_no deterministically). PURE. Returns a Map so a lookup is
 * O(1) for the map overlay, the panel and the run-sheet alike.
 */
export function assignRouteColors(tripIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  for (const id of tripIds) {
    if (out.has(id)) continue; // a duplicate id keeps its first colour
    out.set(id, FLEET_ROUTE_COLORS[i % FLEET_ROUTE_COLORS.length]);
    i += 1;
  }
  return out;
}

/** The colour for one trip, falling back to the first palette entry when the id
 *  is unknown (never undefined — a marker always has a colour). */
export function routeColorFor(colors: Map<string, string>, tripId: string): string {
  return colors.get(tripId) ?? FLEET_ROUTE_COLORS[0];
}
