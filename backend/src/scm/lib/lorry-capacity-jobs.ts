// Lorry Capacity counts scm.trips, but on prod staff assign the lorry on the
// Delivery Planning board instead and build no trips, so every lorry showed 0
// trips (HC-0031, 15 Oct 2026). Two board sources become jobs here: a DO's crew
// lorry (scm.delivery_order_crew) and a PMS project's setup / dismantle lorry
// (projects.*_lorry_id). One lorry on one date = one trip, whatever mix of jobs
// it carries; each job counts in its own bucket. A lorry-date that already has a
// real trip is skipped whole: that trip's stops already counted its work.

export type JobKind = 'delivery' | 'setupDismantle';
export type LorryJob = { lorryId: string | null; lorryPlate: string | null; date: string | null; kind: JobKind };
export type LorryJobDays = { dates: Set<string>; deliveryDates: Set<string>; delivery: number; setupDismantle: number };

export const plateKey = (p: string) => p.replace(/[\s-]/g, '').toUpperCase();

export function tripsFromJobs(
  jobs: LorryJob[],
  idByPlate: Map<string, string>,
  realTripDatesByLorry: Map<string, Set<string>>,
): Map<string, LorryJobDays> {
  const out = new Map<string, LorryJobDays>();
  for (const j of jobs) {
    const date = j.date?.slice(0, 10);
    const lorryId = j.lorryId ?? (j.lorryPlate ? idByPlate.get(plateKey(j.lorryPlate)) : undefined);
    if (!date || !lorryId || realTripDatesByLorry.get(lorryId)?.has(date)) continue;
    const acc = out.get(lorryId) ?? { dates: new Set<string>(), deliveryDates: new Set<string>(), delivery: 0, setupDismantle: 0 };
    acc.dates.add(date);
    acc[j.kind] += 1;
    if (j.kind === 'delivery') acc.deliveryDates.add(date);
    out.set(lorryId, acc);
  }
  return out;
}
