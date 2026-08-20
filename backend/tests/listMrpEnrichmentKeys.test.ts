import { describe, expect, it } from 'vitest';
import { LIST_MRP_ENRICHMENT_KEYS } from '../src/scm/lib/list-mrp-enrichment-keys';

/* C16 twin of frontend/src/lib/listMrpEnrichment.ts's LIST_MRP_DERIVED_FIELDS.
   The PO + GRN enrichment endpoints (which re-export this) and the frontend
   overlay must all pin the SAME four keys — a new MRP-derived list field added
   on only one side fails this test or its frontend twin. */
const EXPECTED = ['assigned_so_linked', 'assigned_so_provenance', 'assigned_sos', 'delivered_dos'];

describe('PO/GRN list MRP enrichment keys', () => {
  it('pins exactly the four MRP-derived columns', () => {
    expect([...LIST_MRP_ENRICHMENT_KEYS].sort()).toEqual([...EXPECTED].sort());
  });
});
