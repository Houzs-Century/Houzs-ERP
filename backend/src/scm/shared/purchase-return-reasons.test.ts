/* Owner 2026-09-28: 「when raise purchase return need input reason and put in
   remark」 and 「purchase return - 是可以退货维修，然后supplier再送回来」.

   The reason is now a CODE from this catalogue and the REPAIR code is also what
   makes a return a repair — goods coming back, no credit note. The pairing is
   the part worth pinning: a document that promises a credit note for goods the
   supplier is fixing is the confusion this replaces. */

import { describe, expect, it } from 'vitest';
import {
  PURCHASE_RETURN_REASONS,
  PURCHASE_RETURN_REASON_CODES,
  REPAIR_REASON_CODE,
  isPurchaseReturnKind,
  isPurchaseReturnReasonCode,
  kindMatchesReason,
  purchaseReturnReasonLabel,
} from './purchase-return-reasons';

describe('the catalogue', () => {
  it('offers the owner-approved list, Send for repair among it', () => {
    expect(PURCHASE_RETURN_REASON_CODES).toEqual([
      'DAMAGED', 'WRONG_COLOUR', 'WRONG_ITEM', 'OVER_SUPPLY', 'QUALITY', 'REPAIR', 'OTHER',
    ]);
    expect(PURCHASE_RETURN_REASONS.find((r) => r.code === REPAIR_REASON_CODE)?.label)
      .toBe('Send for repair');
  });

  it('accepts a code and refuses anything else, including free text', () => {
    expect(isPurchaseReturnReasonCode('DAMAGED')).toBe(true);
    expect(isPurchaseReturnReasonCode('damaged')).toBe(false);
    expect(isPurchaseReturnReasonCode('broken leg')).toBe(false);
    expect(isPurchaseReturnReasonCode(null)).toBe(false);
  });

  /* Rows raised before 2026-09-28 hold free text. Showing it verbatim keeps the
     history readable; hiding it would lose the only thing those rows say. */
  it('labels a code, and prints an older row\'s free text as it stands', () => {
    expect(purchaseReturnReasonLabel('WRONG_COLOUR')).toBe('Wrong colour');
    expect(purchaseReturnReasonLabel('supplier sent the wrong fabric')).toBe('supplier sent the wrong fabric');
    expect(purchaseReturnReasonLabel(null)).toBe('—');
    expect(purchaseReturnReasonLabel('')).toBe('—');
  });
});

describe('kind and reason are one decision', () => {
  it('knows the two kinds and nothing else', () => {
    expect(isPurchaseReturnKind('CREDIT')).toBe(true);
    expect(isPurchaseReturnKind('REPAIR')).toBe(true);
    expect(isPurchaseReturnKind('RETURN')).toBe(false);
  });

  it('a repair return says REPAIR, and only a repair return may', () => {
    expect(kindMatchesReason('REPAIR', 'REPAIR')).toBe(true);
    expect(kindMatchesReason('CREDIT', 'DAMAGED')).toBe(true);
    // Would chase a credit note for goods the supplier is fixing.
    expect(kindMatchesReason('CREDIT', 'REPAIR')).toBe(false);
    // Would expect goods back that were sent for good.
    expect(kindMatchesReason('REPAIR', 'DAMAGED')).toBe(false);
  });

  it('every non-repair code is legal on a CREDIT return', () => {
    for (const code of PURCHASE_RETURN_REASON_CODES.filter((c) => c !== REPAIR_REASON_CODE)) {
      expect(kindMatchesReason('CREDIT', code), code).toBe(true);
      expect(kindMatchesReason('REPAIR', code), code).toBe(false);
    }
  });
});
