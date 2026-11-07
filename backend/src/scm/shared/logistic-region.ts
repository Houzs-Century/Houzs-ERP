/** The delivery region a customer state falls in (Delivery Planning's buckets). */
export function regionOf(state: string | null): string {
  const s = String(state ?? '').trim().toUpperCase();
  if (!s) return 'Unknown';
  if (/(KUALA LUMPUR|^KL$|SELANGOR|PUTRAJAYA|WILAYAH)/.test(s)) return 'KL / Selangor';
  if (/(PENANG|PULAU PINANG|KEDAH|PERLIS|PERAK|NORTH)/.test(s)) return 'Northern';
  if (/(JOHOR|MELAKA|MALACCA|NEGERI SEMBILAN|SINGAPORE)/.test(s)) return 'Southern';
  if (/(PAHANG|TERENGGANU|KELANTAN|EAST)/.test(s)) return 'East Coast';
  if (/(SABAH|SARAWAK|LABUAN)/.test(s)) return 'East Malaysia';
  return 'Other';
}

/** A job a lorry did, by how it counts (owner 2026-11-07). */
export type LorryJobKind = 'delivery' | 'service' | 'setup' | 'transport';
export interface LorryJob { plate: string; date: string; kind: LorryJobKind }

/** A delivery run goes out once however many orders it carries, and service jobs ride
 *  on it. A set-up or a dismantle is a trip each. A supplier pickup or a stock transfer
 *  is half a trip. */
export function lorryTrips(doDates: Iterable<string>, jobs: readonly LorryJob[]) {
  const deliveryDates = new Set(doDates);
  for (const j of jobs) if (j.kind === 'delivery' || j.kind === 'service') deliveryDates.add(j.date);
  const setups = jobs.filter((j) => j.kind === 'setup');
  const moves = jobs.filter((j) => j.kind === 'transport');
  return {
    deliveryDays: deliveryDates.size,
    fairTrips: setups.length,
    stockTrips: moves.length * 0.5,
    usedDays: new Set([...deliveryDates, ...jobs.map((j) => j.date)]).size,
    serviceOrders: jobs.filter((j) => j.kind === 'service').length,
    otherTrips: setups.length + moves.length * 0.5,
    trips: deliveryDates.size + setups.length + moves.length * 0.5,
  };
}
