import { describe, expect, it } from 'vitest';
import { PI_LIST_MRP_ENRICHMENT_KEYS, pickPiListMrpEnrichment } from '../src/scm/lib/pi-assigned-sos';

/* C16 twin of frontend/src/lib/piListEnrichment.ts's PI_MRP_DERIVED_LIST_FIELDS.
   The two literal arrays must stay equal — a new MRP-derived PI-list field added
   on only one side fails one of these two tests. */
describe('PI list MRP enrichment keys', () => {
  it('is EXACTLY the four MRP-derived columns', () => {
    expect([...PI_LIST_MRP_ENRICHMENT_KEYS].sort()).toEqual(
      ['assigned_so_linked', 'assigned_so_provenance', 'assigned_sos', 'delivered_dos'].sort(),
    );
  });

  it('pickPiListMrpEnrichment projects ONLY those keys off an attachPiAssignedSos row', () => {
    const row = {
      id: 'pi-1',
      invoice_number: 'PI-1',
      grn_id: 'g1',
      assigned_sos: [{ soDocNo: 'SO-1' }],
      assigned_so_linked: true,
      assigned_so_provenance: [],
      delivered_dos: [{ doNo: 'DO-1', qty: 2 }],
    };
    const picked = pickPiListMrpEnrichment(row);
    expect(Object.keys(picked).sort()).toEqual([...PI_LIST_MRP_ENRICHMENT_KEYS].sort());
    expect(picked.assigned_sos).toEqual([{ soDocNo: 'SO-1' }]);
    // The non-enrichment columns (identity, money, etc.) are NOT carried into the payload.
    expect((picked as Record<string, unknown>).invoice_number).toBeUndefined();
    expect((picked as Record<string, unknown>).grn_id).toBeUndefined();
  });
});
