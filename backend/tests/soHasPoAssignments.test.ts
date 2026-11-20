/* Owner 2026-11-19: Assigned SO follows MRP's record, and the "PO already
   generated" prompt names where each PO is going now. HC-PO-2611-143 / -256
   were raised for HC-SO-003726; MRP gave them to HC-SO-012294 / HC-SO-2611-174. */
import { describe, expect, it } from 'vitest';
import { ASSIGNED_FOLLOWS_MRP, mergeAssignments } from '../src/scm/routes/po-so-coverage';
import { assignmentOf } from '../src/scm/lib/so-has-po-assignments';

const stored = new Map([['AK-ULTIMATE MATT (SK)', [{ soDocNo: 'HC-SO-003726', deliveryDate: '2027-01-14', locked: true, source: 'linked' as const }]]]);
const mrp = new Map([['AK-ULTIMATE MATT (SK)', [{ soDocNo: 'HC-SO-012294', deliveryDate: '2026-12-14', locked: false, source: 'mrp' as const }]]]);

describe('Assigned SO follows MRP in both companies', () => {
  it('MRP outranks the raise-link; the raise-link stays as provenance', () => {
    const [o] = mergeAssignments(['AK-ULTIMATE MATT (SK)'], new Map(), stored, mrp, new Set(['AK-ULTIMATE MATT (SK)']), ASSIGNED_FOLLOWS_MRP);
    expect(o!.assignments.map((a) => a.soDocNo)).toEqual(['HC-SO-012294']);
    expect(o!.provenance.map((a) => a.soDocNo)).toEqual(['HC-SO-003726']);
  });
  it('with no MRP answer (received, in stock) the raise-link still names the SO', () => {
    const [o] = mergeAssignments(['AK-ULTIMATE MATT (SK)'], new Map(), stored, new Map(), new Set(), ASSIGNED_FOLLOWS_MRP);
    expect(o!.assignments.map((a) => a.soDocNo)).toEqual(['HC-SO-003726']);
  });
});

describe('the prompt line: where the PO is going', () => {
  const hit = { soItemId: 'x', soDocNo: 'HC-SO-003726', itemCode: 'AK-ULTIMATE MATT (SK)', poNumber: 'HC-PO-2611-143' };
  it('given to another order', () => {
    const origins = mergeAssignments(['AK-ULTIMATE MATT (SK)'], new Map(), stored, mrp, new Set(), true);
    expect(assignmentOf(origins, hit)).toEqual({ assignedTo: ['HC-SO-012294'], coversThisSo: false });
  });
  it('still covering this order', () => {
    const origins = mergeAssignments(['AK-ULTIMATE MATT (SK)'], new Map(), stored, new Map(), new Set(), true);
    expect(assignmentOf(origins, hit)).toEqual({ assignedTo: ['HC-SO-003726'], coversThisSo: true });
  });
  it('no origin for the SKU: assigned to nobody', () => {
    expect(assignmentOf([], hit)).toEqual({ assignedTo: [], coversThisSo: false });
  });
});
