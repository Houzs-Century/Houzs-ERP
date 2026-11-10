/* Reopen (un-cancel) of a Sales Order — who may.
   Policy (owner 2026-09-18, routes/mfg-sales-orders.ts PATCH /:docNo/status):
   only an order carried over from AutoCount (linked_ac_docno) comes back. A
   cancel the ERP ran itself released stock and voided PWP vouchers, and the
   reopen path does not undo those, so it is final. The list stamps
   `reopenable` from soReopenable so the screens offer Reopen only where the
   PATCH will take it. */

export function soReopenable(status: string | null, linkedAcDocno: string | null): boolean {
  return String(status ?? '').toUpperCase() === 'CANCELLED' && String(linkedAcDocno ?? '').trim() !== '';
}

/* The status PATCH's so_cancelled_final sentence. Under 200 characters: the
   client (authed-fetch.ts isPlain) drops a longer reason and shows a generic
   409 instead, which is how "Reopen" came to fail with no explanation. */
export const SO_CANCELLED_FINAL_REASON =
  'Cancelled in the ERP, so this Sales Order is final: its stock and vouchers were released. Only an order carried over from AutoCount can be reopened. Use Copy as new instead.';
