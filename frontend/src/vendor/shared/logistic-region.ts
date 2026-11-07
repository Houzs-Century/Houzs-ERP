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

/** Our lorries run these regions. East Malaysia and the rest go out trip by trip on
 *  their own, so they stay out of the lorry figures (owner 2026-11-07). */
export const LORRY_REGIONS: readonly string[] = ['KL / Selangor', 'Southern', 'Northern'];
export const countsForLorry = (region: string): boolean => LORRY_REGIONS.includes(region);

/** A job a lorry did, by how it counts (owner 2026-11-07). */
export type LorryJobKind = 'delivery' | 'service' | 'setup' | 'transport';
export interface LorryJob { plate: string; date: string; kind: LorryJobKind }
/** The same job as a line in the lorry's list: every counted job is one of these. */
export interface LorryJobDetail extends LorryJob { type: string; ref: string | null; customer: string | null; assrId: string | null; doId: string | null }

/** Fewer orders than this on a delivery run (delivery orders and service jobs) count
 *  half a trip (owner 2026-11-07). */
export const FULL_RUN_ORDERS = 3;

/** A delivery run goes out once however many orders it carries, and service jobs ride
 *  on it; a run of fewer than three orders is half a trip. A set-up or a dismantle is a
 *  trip each. A supplier pickup or a stock transfer is half a trip. */
export function lorryTrips(doDays: ReadonlyArray<{ date: string; orders: number }>, jobs: readonly LorryJob[]) {
  const ordersOn = new Map<string, number>();
  for (const d of doDays) ordersOn.set(d.date, (ordersOn.get(d.date) ?? 0) + d.orders);
  for (const j of jobs) if (j.kind === 'service') ordersOn.set(j.date, (ordersOn.get(j.date) ?? 0) + 1);
  for (const j of jobs) if (j.kind === 'delivery' && !ordersOn.has(j.date)) ordersOn.set(j.date, 1);
  const deliveryTrips = [...ordersOn.values()].reduce((a, n) => a + (n < FULL_RUN_ORDERS ? 0.5 : 1), 0);
  const setups = jobs.filter((j) => j.kind === 'setup');
  const moves = jobs.filter((j) => j.kind === 'transport');
  return {
    deliveryDays: ordersOn.size,
    deliveryTrips,
    fairTrips: setups.length,
    stockTrips: moves.length * 0.5,
    usedDays: new Set([...ordersOn.keys(), ...jobs.map((j) => j.date)]).size,
    serviceOrders: jobs.filter((j) => j.kind === 'service').length,
    otherTrips: setups.length + moves.length * 0.5,
    trips: deliveryTrips + setups.length + moves.length * 0.5,
  };
}
