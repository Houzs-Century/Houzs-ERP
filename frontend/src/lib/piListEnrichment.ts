/* The deferred, MRP-derived half of a Purchase-Invoice list row — fetched a beat
   after the list renders (GET /purchase-invoices/list-mrp-enrichment) and merged
   into the already-shown rows.

   WHY IT IS DEFERRED. Opening the PI list used to run a company-wide `computeMrp`
   on the critical path — the list's dominant cost (~4s). The backend's
   attachPiAssignedSos resolves the "Assigned SO" and "Delivered" columns through
   resolvePoSoCoveragePerSkuForPos, and THAT runs the global MRP engine once per
   load. The list now paints immediately WITHOUT those four columns, and this
   overlay heals them once the enrichment fetch lands — the same shape #2433 gave
   the Sales-Orders list (see soListEnrichment.ts). */

import type { OriginAssignment, DeliveredDo } from '../vendor/scm/lib/flow-queries';

export type PiListMrpEnrichment = {
  assigned_sos: OriginAssignment[];
  assigned_so_linked: boolean;
  assigned_so_provenance: OriginAssignment[];
  delivered_dos: DeliveredDo[];
};

/** The subset of a PI list row this overlay reads/writes. Row types are wider. */
export type EnrichablePiRow = {
  id?: string;
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  assigned_so_provenance?: OriginAssignment[];
  delivered_dos?: DeliveredDo[];
};

export const PI_MRP_DERIVED_LIST_FIELDS = [
  'assigned_sos',
  'assigned_so_linked',
  'assigned_so_provenance',
  'delivered_dos',
] as const satisfies ReadonlyArray<keyof PiListMrpEnrichment & keyof EnrichablePiRow>;

export type PiMrpDerivedListField = (typeof PI_MRP_DERIVED_LIST_FIELDS)[number];

/**
 * Overlay one row's deferred enrichment. The four MRP-derived columns are
 * REPLACED wholesale — unlike the SO overlay there is no cheap inline arm to
 * union with, because the PI list sends none of these fields (omit not blank).
 * A row with no enrichment yet is returned unchanged, so its columns stay absent
 * and the cells render empty until the fetch lands.
 */
export function applyPiListMrpEnrichment<T extends EnrichablePiRow>(
  row: T,
  e: PiListMrpEnrichment | undefined,
): T {
  if (!e) return row;
  return {
    ...row,
    assigned_sos: e.assigned_sos,
    assigned_so_linked: e.assigned_so_linked,
    assigned_so_provenance: e.assigned_so_provenance,
    delivered_dos: e.delivered_dos,
  };
}
