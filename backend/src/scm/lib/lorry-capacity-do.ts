// Lorry Capacity counts scm.trips, but on prod staff assign the lorry per DO on
// the Delivery Planning board (scm.delivery_order_crew) and build no trips, so
// every lorry showed 0 trips (HC-0031, 15 Oct 2026). One lorry on one delivery
// date = one trip; each DO on it = one delivery. A lorry-date that already has a
// real trip is skipped so the two sources never double count.

export type DoDay = { lorryId: string | null; lorryPlate: string | null; date: string | null };
export type DoTrips = { dates: Set<string>; deliveries: number };

export const plateKey = (p: string) => p.replace(/[\s-]/g, '').toUpperCase();

export function tripsFromDoCrew(
  dos: DoDay[],
  idByPlate: Map<string, string>,
  tripDatesByLorry: Map<string, Set<string>>,
): Map<string, DoTrips> {
  const out = new Map<string, DoTrips>();
  for (const d of dos) {
    const date = d.date?.slice(0, 10);
    const lorryId = d.lorryId ?? (d.lorryPlate ? idByPlate.get(plateKey(d.lorryPlate)) : undefined);
    if (!date || !lorryId || tripDatesByLorry.get(lorryId)?.has(date)) continue;
    const acc = out.get(lorryId) ?? { dates: new Set<string>(), deliveries: 0 };
    acc.dates.add(date);
    acc.deliveries += 1;
    out.set(lorryId, acc);
  }
  return out;
}
