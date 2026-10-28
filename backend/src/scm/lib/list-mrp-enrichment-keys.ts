// The MRP-DERIVED list-row columns that the PO and GRN lists no longer compute on
// their critical path — the deferred enrichment endpoints
// (routes/mfg-purchase-orders-list-enrichment.ts, routes/grns-list-enrichment.ts)
// fill them a beat after render. C16 twin of frontend/src/lib/listMrpEnrichment.ts's
// LIST_MRP_DERIVED_FIELDS; backend/tests/listMrpEnrichmentKeys.test.ts pins the two
// literal sets equal, so a new MRP-derived list field added on only one side fails CI.
export const LIST_MRP_ENRICHMENT_KEYS = [
  'assigned_sos',
  'assigned_so_linked',
  'assigned_so_provenance',
  'delivered_dos',
] as const;
