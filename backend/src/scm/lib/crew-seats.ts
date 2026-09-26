// ----------------------------------------------------------------------------
// crew-seats — which master id sits on each seat after PUT /:id/crew.
//
// The crew row is a single UPSERT, so "keep this seat" cannot be expressed by
// omitting it — it has to be written back from what was there. This resolves the
// five seats from the request body against the crew row BEFORE the write:
//   - a seat NAMED in the body is set to that value (an explicit null / '' clears it),
//   - a seat the body does NOT mention keeps whoever the DO already had.
// So the delivery board can edit one seat at a time without wiping the rest,
// while FleetDay — which always sends all five — re-assigns the whole crew as
// before. Pure and side-effect free (owner 2026-09-26).
// ----------------------------------------------------------------------------

export type CrewSeatIds = {
  driver1Id: string | null;
  driver2Id: string | null;
  helper1Id: string | null;
  helper2Id: string | null;
  lorryId: string | null;
};

const asId = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export function resolveCrewSeats(
  body: Record<string, unknown>,
  before: Record<string, unknown>,
): CrewSeatIds {
  const seat = (key: string, beforeCol: string): string | null =>
    (key in body ? asId(body[key]) : ((before[beforeCol] as string | null) ?? null));
  return {
    driver1Id: seat('driver1Id', 'driver_1_id'),
    driver2Id: seat('driver2Id', 'driver_2_id'),
    helper1Id: seat('helper1Id', 'helper_1_id'),
    helper2Id: seat('helper2Id', 'helper_2_id'),
    lorryId: seat('lorryId', 'lorry_id'),
  };
}
