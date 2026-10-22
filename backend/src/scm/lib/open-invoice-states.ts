// ----------------------------------------------------------------------------
// open-invoice-states — the invoice statuses that still OWE, one home for the
// readers that ask "is this bill still open?" (owner 2026-10-02: Supplier
// Maintenance's open bills; the formal AR / AP Aging's count of AutoCount bills
// outside the books). A paid, draft, cancelled or void invoice owes nothing.
// ----------------------------------------------------------------------------

/** A purchase invoice still owing a supplier: posted, part paid, or held. */
export const OPEN_PI_STATUSES = ['POSTED', 'PARTIALLY_PAID', 'ON_HOLD'] as const;

/** A sales invoice still owed by a customer: sent, part paid, or overdue. */
export const OPEN_SI_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'] as const;
