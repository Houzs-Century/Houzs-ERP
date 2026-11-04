/* Copy one board row's crew and paste it onto other rows (HC-0191: "fill the
   driver details once, paste to the other 5 bills"). The board row carries crew
   NAMES; the writes need ids, so names are resolved against the masters. A name
   that is not in the master, or is shared by two people, is left out and reported
   rather than guessed. Only seats the source row has filled are pasted. */
import type { PlanningOrder } from './delivery-planning-queries';

export type CrewSeats = {
  lorryId?: string; driver1Id?: string; driver2Id?: string; helper1Id?: string; helper2Id?: string;
};
type Named = { id: string; name: string };
type Plated = { id: string; plate: string };

const idByName = (list: Named[], name: string | null | undefined): string | undefined | null => {
  const n = (name ?? '').trim();
  if (!n) return undefined;
  const hits = list.filter((x) => x.name === n);
  return hits.length === 1 ? hits[0]!.id : null;
};

/** The source row's crew as ids, and the seat labels that could not be resolved. */
export function crewToCopy(
  order: PlanningOrder, drivers: Named[], lorries: Plated[], helpers: Named[],
): { seats: CrewSeats; unresolved: string[] } {
  const c = order.crew;
  const seats: CrewSeats = {}; const unresolved: string[] = [];
  const take = (key: keyof CrewSeats, label: string, id: string | undefined | null) => {
    if (id === undefined) return;
    if (id === null) unresolved.push(label); else seats[key] = id;
  };
  const plate = (c?.lorry_plate ?? '').trim();
  take('lorryId', 'Lorry', plate ? (lorries.filter((l) => l.plate === plate).length === 1 ? lorries.find((l) => l.plate === plate)!.id : null) : undefined);
  take('driver1Id', 'Driver', idByName(drivers, c?.driver_1_name));
  take('driver2Id', 'Driver 2', idByName(drivers, c?.driver_2_name));
  take('helper1Id', 'Helper 1', idByName(helpers, c?.helper_1_name));
  take('helper2Id', 'Helper 2', idByName(helpers, c?.helper_2_name));
  return { seats, unresolved };
}

/** Driver 2 exists only on a delivery order's crew: a DP run has one driver and a
 *  service-case leg has no second-driver seat, so it is dropped for those rows. */
export const seatsForTarget = (seats: CrewSeats, order: Pick<PlanningOrder, 'row_type'>): CrewSeats => {
  if (order.row_type === 'dp' || order.row_type === 'assr') { const { driver2Id: _d2, ...rest } = seats; return rest; }
  return seats;
};
