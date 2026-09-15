// ----------------------------------------------------------------------------
// ac-payement-owner — who writes a sales order's AutoCount payment text
// (`SO.UDF_PAYEMENT`), the ERP or the office.
//
// An order the ERP made reaches the book under the ERP's own number (HC-...),
// and the ERP is the only writer of its payment text.
//
// An order carried over from AutoCount keeps the book's own number (SO-0...).
// Its payment text is the office's record, and the ERP holds it only in part:
// the cutover folded several book payments into one ERP row. Composing the text
// from the ERP rows therefore DROPS references. Between 2026-09-07 and 09-15, 69
// such orders lost a real reference, and 415 more would lose one on their next
// edit (book EventLog and a read-only comparison; docs/bugs/0934).
//
// STOPGAP until the ERP keeps the book's own text: on a carried-over order the
// ERP does not write the payment text at all, so the book keeps the office's.
// BALANCE still goes. The cost, accepted for now: a reference typed on a new ERP
// payment for such an order does not reach the book's text.
// ----------------------------------------------------------------------------

/** True when the ERP owns the payment text: not yet in the book (a create), or in it under an ERP number. */
export function erpOwnsPaymentText(linkedAcDocNo: unknown): boolean {
  const no = String(linkedAcDocNo ?? '').trim().toUpperCase();
  return no === '' || no.startsWith('HC-');
}
