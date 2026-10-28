/* The deferred, MRP-derived half of a Purchase-Order / Goods-Received list row —
   fetched a beat after the list renders and merged into the already-shown rows.

   WHY IT IS DEFERRED. Opening the PO list (and the GRN list) used to run a
   company-wide `computeMrp` on the critical path: the list resolved the
   "Assigned SO" / "Delivered" columns through the coverage engine, and THAT runs
   the global MRP engine once per load (~4s, the list's dominant cost). The list
   now paints immediately WITHOUT those columns, and this overlay heals them once
   the enrichment fetch lands — the same shape #2433 gave the Sales-Orders list
   and the PI list got before it (see piListEnrichment.ts).

   Shared by the PO and GRN lists because the four MRP-derived columns are
   identical on both surfaces. */

import type { OriginAssignment, DeliveredDo } from '../vendor/scm/lib/flow-queries';

export type ListMrpEnrichment = {
  assigned_sos: OriginAssignment[];
  assigned_so_linked: boolean;
  assigned_so_provenance: OriginAssignment[];
  delivered_dos: DeliveredDo[];
};

/** The subset of a list row this overlay reads/writes. Row types are wider. */
export type EnrichableMrpRow = {
  id?: string;
  assigned_sos?: OriginAssignment[];
  assigned_so_linked?: boolean;
  assigned_so_provenance?: OriginAssignment[];
  delivered_dos?: DeliveredDo[];
};

/* C16 GUARD (Hookka frontend bug class: "a field that heals on one surface via
   enrichment but stays stored-only elsewhere"). The SINGLE source of truth for
   which list-row fields the deferred MRP enrichment heals. Its backend twin is
   LIST_MRP_ENRICHMENT_KEYS in each module's *-list-enrichment.ts route; a parity
   test asserts the sets are equal, so a new MRP-derived list field added on only
   one side fails CI with the drifting key named. */
export const LIST_MRP_DERIVED_FIELDS = [
  'assigned_sos',
  'assigned_so_linked',
  'assigned_so_provenance',
  'delivered_dos',
] as const satisfies ReadonlyArray<keyof ListMrpEnrichment & keyof EnrichableMrpRow>;

export type MrpDerivedListField = (typeof LIST_MRP_DERIVED_FIELDS)[number];

/**
 * Overlay one row's deferred enrichment. The four MRP-derived columns are
 * REPLACED wholesale — the list sends none of them (omit not blank). A row with
 * no enrichment yet is returned unchanged, so its columns stay absent and the
 * cells render empty until the fetch lands.
 */
export function applyListMrpEnrichment<T extends EnrichableMrpRow>(
  row: T,
  e: ListMrpEnrichment | undefined,
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
