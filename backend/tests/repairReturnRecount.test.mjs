// repair-repair-return-received.mjs decisions, on the 2990-PRT-2610-001 shape:
// one XAMMAR-2A(RHF) sent to HOOKKA for repair, its GRN line counted as returned,
// so 2990-PO-2607-018 read received 0 of 1.
import { describe, expect, it } from 'vitest';
import { planPoReceived, planReturnedQty } from '../scripts/lib/repair-return-recount.mjs';

const grn = { grnItemId: 'gi-1', poItemId: 'poi-1', grnNumber: '2990-GRN-x', grnStatus: 'POSTED', qtyAccepted: 1, returnedQty: 1 };
const po = { poItemId: 'poi-1', poId: 'po-1', poNumber: '2990-PO-2607-018', poStatus: 'SUBMITTED', linkedAcDocno: null, itemCode: 'XAMMAR-2A(RHF)', qty: 1, receivedQty: 0 };

describe('repair return recount', () => {
  it('releases a GRN line consumed only by a REPAIR return, and re-receives its PO line', () => {
    const g = planReturnedQty([grn], [{ grnItemId: 'gi-1', qtyReturned: 1, prKind: 'REPAIR', prStatus: 'POSTED' }]);
    expect(g.map((f) => f.newReturnedQty)).toEqual([0]);
    expect(planPoReceived([po], [grn], g).map((f) => f.newReceivedQty)).toEqual([1]);
  });

  it('keeps a CREDIT return counted, and ignores a cancelled one', () => {
    const prs = [
      { grnItemId: 'gi-1', qtyReturned: 1, prKind: 'CREDIT', prStatus: 'POSTED' },
      { grnItemId: 'gi-1', qtyReturned: 1, prKind: 'CREDIT', prStatus: 'CANCELLED' },
      { grnItemId: 'gi-1', qtyReturned: 1, prKind: 'REPAIR', prStatus: 'POSTED' },
    ];
    expect(planReturnedQty([grn], prs)).toEqual([]);
  });

  it('leaves an AutoCount cutover PO alone', () => {
    const g = planReturnedQty([grn], [{ grnItemId: 'gi-1', qtyReturned: 1, prKind: 'REPAIR', prStatus: 'POSTED' }]);
    expect(planPoReceived([{ ...po, linkedAcDocno: 'PO-123' }], [grn], g)).toEqual([]);
  });
});
