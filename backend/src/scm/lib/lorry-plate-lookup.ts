// ---------------------------------------------------------------------------
// lorry-plate-lookup.ts — resolve scm.trips.lorry_id → scm.lorries.plate for the
// delivery-scope lorry-plate arm (deliveryScope.ts).
//
// WHY. A `self` delivery scope now also matches a job by its LORRY plate, not
// only its assigned driver/helper id (owner, 2026-11-28: one phone per lorry).
// Board SO rows already carry delivery_order_crew.lorry_plate, but TRIP rows
// carry only trips.lorry_id — the plate lives on scm.lorries. This is the one
// cheap, best-effort id→plate batch read the trip-based call sites share.
//
// FAIL OPEN, like resolveDeliveryScope's own link lookup: a lorry lookup error
// (transient, or a bare test DB) returns an EMPTY map, never throws. An empty
// map means "no plate resolved", so the plate arm simply does not fire and the
// driver/helper-id arm still decides the row — a DB fault must not lock a driver
// out mid-shift, and it must not 500 a POD. Lorries are shared fleet across
// companies (no company predicate needed — the ids already came from
// company-scoped trips/crew), so this maps ids to plates and nothing more.
// ---------------------------------------------------------------------------

/**
 * Best-effort map of lorry id → plate for the given ids (deduped, blanks
 * dropped). Empty map on any error or when no ids are given.
 */
export async function lorryPlatesByIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the scm PostgREST client, untyped like every scm route
  sb: any,
  ids: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return out;
  try {
    const { data, error } = await sb.from("lorries").select("id, plate").in("id", unique);
    if (error) return out;
    for (const r of (data ?? []) as Array<{ id?: string; plate?: string | null }>) {
      const id = r.id == null ? "" : String(r.id);
      const plate = r.plate == null ? "" : String(r.plate);
      if (id && plate) out.set(id, plate);
    }
    return out;
  } catch {
    return out;
  }
}
