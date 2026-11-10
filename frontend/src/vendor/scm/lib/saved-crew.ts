// The crew a Delivery Planning save got back, kept on screen until the board
// read agrees with it.
//
// The board GET is slow (production 2026-11: p95 ~14 s, some calls over 3 min,
// browser timeouts). A crew save that SUCCEEDED was then followed by a reload
// that timed out, or by a reload that had started before the save and came back
// with the old crew, and the row fell back to "— none —". Staff read that as
// "filled the driver, it went missing". So the save's own answer (the crew row
// the server just wrote, with the driver's IC / phone) is laid over every board
// read of that DO until a read returns the same people, or it is TTL_MS old.
import type { PlanningOrder } from './delivery-planning-queries';

type RowCrew = NonNullable<PlanningOrder['crew']>;

/** The crew row PUT /delivery-orders-mfg/:id/crew answers with (crewSnapshotCols). */
export type CrewSnapshot = {
  driver_1_name?: string | null; driver_1_ic?: string | null; driver_1_contact?: string | null;
  driver_2_name?: string | null; helper_1_name?: string | null; helper_2_name?: string | null;
  lorry_plate?: string | null;
};

const TTL_MS = 5 * 60_000;
const saved = new Map<string, { crew: RowCrew; at: number }>();

export function crewFromSnapshot(s: CrewSnapshot): RowCrew {
  const n = (v: string | null | undefined) => v ?? null;
  return {
    driver: [s.driver_1_name, s.driver_2_name].filter(Boolean).join(' / ') || null,
    helper: [s.helper_1_name, s.helper_2_name].filter(Boolean).join(' / ') || null,
    lorry: n(s.lorry_plate),
    driver_1_name: n(s.driver_1_name), driver_1_ic: n(s.driver_1_ic), driver_1_contact: n(s.driver_1_contact),
    driver_2_name: n(s.driver_2_name), helper_1_name: n(s.helper_1_name), helper_2_name: n(s.helper_2_name),
    lorry_plate: n(s.lorry_plate),
  };
}

export function rememberSavedCrew(doId: string, snapshot: CrewSnapshot, now = Date.now()): void {
  saved.set(doId, { crew: crewFromSnapshot(snapshot), at: now });
}

/** Test-only reset. */
export function forgetSavedCrew(): void { saved.clear(); }

const samePeople = (a: Partial<RowCrew> | null, b: RowCrew): boolean =>
  !!a && !a.driver_1_typed && a.driver_1_name === b.driver_1_name && a.driver_2_name === b.driver_2_name
  && a.helper_1_name === b.helper_1_name && a.helper_2_name === b.helper_2_name && a.lorry_plate === b.lorry_plate;

/** A board response with each row's just-saved crew laid over a stale one. The
 *  row's crew is its LAST delivery order's (the DO the crew cells write). Returns
 *  the same object when nothing changes, so it is safe as a react-query `select`. */
// Loose on purpose: the phone run-sheet types its rows with a narrower crew shape.
type CrewRow = { crew?: Partial<RowCrew> | null; delivery_orders?: ReadonlyArray<{ id?: string | null }> | null };
export function withSavedCrew<R extends CrewRow, T extends { orders?: R[] } | undefined>(data: T, now = Date.now()): T {
  if (!data || saved.size === 0 || !Array.isArray(data.orders)) return data;
  const before = data.orders;
  const orders = before.map((o): R => {
    const dos = o.delivery_orders ?? [];
    const doId = dos.length ? (dos[dos.length - 1]!.id ?? null) : null;
    const hit = doId ? saved.get(doId) : undefined;
    if (!doId || !hit) return o;
    if (now - hit.at > TTL_MS || samePeople(o.crew ?? null, hit.crew)) { saved.delete(doId); return o; }
    return { ...o, crew: hit.crew } as R;
  });
  return orders.some((o, i) => o !== before[i]) ? { ...data, orders } : data;
}
