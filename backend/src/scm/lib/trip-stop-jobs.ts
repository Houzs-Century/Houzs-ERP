// ---------------------------------------------------------------------------
// trip-stop-jobs.ts — the jobs on a trip that are NOT delivery orders, read into
// rate-card facts. PURE.
//
// Owner 2026-11-18: "the rate card is bound to all my jobs to compute my cost".
// The trip reconciliation priced a trip's delivery orders alone; a setup, a
// supplier pickup or an ASSR leg on the same trip was dispatched, billed by the
// 3PL, and priced at nothing. Each such stop is now one occurrence of its job
// (setupCount, pickupCount, …) and one address the outstation surcharge may
// reach, tagged with its job so an outstation rule's Applies to decides.
// ---------------------------------------------------------------------------
import type { DeliveryFacts, DeliveryStop } from './delivery-rate-card';
import type { BillableJobType } from './rate-rule-taxonomy';

export interface TripStopRow {
  stopType: string | null;
  doId: string | null;
  assrCaseId: string | null;
  address: string | null;
}

type JobCount = 'setupCount' | 'dismantleCount' | 'serviceCount' | 'pickupCount'
  | 'inspectionCount' | 'supplierPickupCount' | 'transferCount';

/** The fact each non-delivery job fills. */
export const JOB_COUNT_FACT: Record<Exclude<BillableJobType, 'DELIVERY'>, JobCount> = {
  SETUP: 'setupCount',
  DISMANTLE: 'dismantleCount',
  SUPPLIER_PICKUP: 'supplierPickupCount',
  TRANSFER: 'transferCount',
  INSPECTION: 'inspectionCount',
  PICKUP: 'pickupCount',
  SERVICE: 'serviceCount',
};

/**
 * The non-delivery job a stop is, or null. A DELIVERY stop with a DO is the
 * delivery order the caller already prices from its lines; a DELIVERY stop of a
 * Service Case with no DO is the ASSR delivery back, which DP calls ASSR -
 * Service and the SERVICE rule prices (assr-board-scope ASSR_LEG_BY_STOP). A
 * DELIVERY stop with neither carries nothing to price, as before. LORRY_SERVICE
 * is ours to pay the workshop for, never a carrier's charge.
 */
export function stopJob(st: TripStopRow): Exclude<BillableJobType, 'DELIVERY'> | null {
  const t = String(st.stopType ?? '').toUpperCase();
  if (t === 'DELIVERY') return !st.doId && st.assrCaseId ? 'SERVICE' : null;
  return t in JOB_COUNT_FACT ? (t as Exclude<BillableJobType, 'DELIVERY'>) : null;
}

/** A trip's non-delivery stops as occurrence counts and job-tagged addresses.
 *  `zoneOf` reads an address's postcode zone (Delivery Zones). */
export function jobStopFacts(
  rows: readonly TripStopRow[],
  zoneOf: (address: string | null) => string | null,
): { counts: Partial<Pick<DeliveryFacts, JobCount>>; stops: DeliveryStop[] } {
  const counts: Partial<Pick<DeliveryFacts, JobCount>> = {};
  const stops: DeliveryStop[] = [];
  for (const r of rows) {
    const job = stopJob(r);
    if (!job) continue;
    const k = JOB_COUNT_FACT[job];
    counts[k] = (counts[k] ?? 0) + 1;
    stops.push({ zone: zoneOf(r.address), addressText: r.address ?? '', jobType: job });
  }
  return { counts, stops };
}
