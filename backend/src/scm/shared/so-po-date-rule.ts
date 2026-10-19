// so-po-date-rule — what a Purchase Order freezes on a Sales Order's schedule.
//
// BUG-101 (Sim, 2026-10-10; owner rulings 2026-10-12). HC-SO-2609-395 was
// proceeded 30/9 and PO-2610-025 went to the supplier. An amendment that only
// meant to move the delivery then also moved the Processing Date to 10/10, and
// the Purchaser's signature applied it. The supplier works to the PO, so the
// SO's Processing Date no longer described anything real.
//
//   1. Once a live PO exists, the Processing Date is FROZEN: no move, no clear,
//      by amendment or by the header PATCH. Releasing it means cancelling the
//      PO (the same rule 2990's whole-SO PO lock already applies to the clear).
//      An order that never had a Processing Date may still get its first one.
//   2. Postponing the Delivery Date is Logistic's alone. Bringing it FORWARD on
//      an order with a live PO asks the supplier for the goods sooner, so the
//      Purchaser must OK it before Logistic can approve it.
//      HC-0114 (Syu, owner 2026-10-16): only while a PO is still waiting on the
//      supplier. Once every live PO is RECEIVED the goods are in the warehouse
//      and the date is Logistic's last mile alone (HC-SO-012039, READY_TO_SHIP).
//
// Pure: the caller resolves `hasLivePo` / `hasUnreceivedPo` (lib/so-po-lock)
// and the stored dates. Dates are compared as YYYY-MM-DD strings, '' for none.

/** The exception (Sim 2026-10-12): only the Purchaser handles a Processing Date
 *  change once a PO exists, never sales. Granted to the Purchaser role
 *  (20261012T1210); Owner holds it through `*`. On an amendment the holder is
 *  the REQUESTER (stamped as so_amendments.po_date_override_by) and the
 *  Purchaser lane approves as usual. */
export const PROCESSING_DATE_PO_OVERRIDE_KEY = 'scm.so.override_po_processing_date';

export const PROCESSING_DATE_PO_LOCKED = {
  error: 'processing_date_po_locked',
  message:
    'This Sales Order already has a Purchase Order, so only a Purchaser can change its Processing Date. '
    + 'You can still request the Delivery Date.',
} as const;

export const PURCHASER_OK_REQUIRED = {
  error: 'purchaser_ok_required',
  message:
    'This brings the Delivery Date forward on an order whose Purchase Order is not fully received yet. '
    + 'A Purchaser must OK it first.',
} as const;

/** Would writing `nextProc` over `storedProc` move or clear a Processing Date a PO holds? */
export function processingDateFrozenByPo(args: {
  storedProc: string;
  nextProc: string;
  hasLivePo: boolean;
}): boolean {
  return args.hasLivePo && args.storedProc !== '' && args.nextProc !== args.storedProc;
}

/** Is `nextDeliv` earlier than the order's current Delivery Date? A first date,
 *  or a cleared one, is not "earlier". */
export function deliveryBroughtForward(storedDeliv: string, nextDeliv: string): boolean {
  return storedDeliv !== '' && nextDeliv !== '' && nextDeliv < storedDeliv;
}

/** Is the supplier still owed goods on a PO in this status? */
export function poAwaitingSupplier(status: string | null | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s !== 'CANCELLED' && s !== 'RECEIVED';
}

/** Does this DELIVERY-lane request need the Purchaser's OK before Logistic signs? */
export function deliveryNeedsPurchaserOk(args: {
  storedDeliv: string;
  nextDeliv: string | null;
  hasUnreceivedPo: boolean;
}): boolean {
  return args.hasUnreceivedPo && args.nextDeliv != null && deliveryBroughtForward(args.storedDeliv, args.nextDeliv);
}
