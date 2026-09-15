/* ----------------------------------------------------------------------------
   doc-payment — which payment a phone document detail offers.

   A Sales Invoice records the customer's payment in place (the Record Payment
   sheet in MobileModuleDetail.tsx). A Purchase Invoice does NOT: a supplier is
   paid with an AP Payment voucher, the same as on the desktop, and the footer
   names where that is done. Until docs/bugs/0889 the phone offered a sheet
   that typed the amount straight onto the supplier invoice, skipping the
   voucher, the journal entry and the hold check. The rule for the purchase
   invoice lives in vendor/scm/lib/pi-payment-path.ts, which the desktop reads
   too.

   Its own module because MobileModuleDetail.tsx sits at the 2,000-line cap.
   ---------------------------------------------------------------------------- */

import { piAwaitsPayment, PI_PAYMENT_ROUTE_HINT, type PayablePi } from "../vendor/scm/lib/pi-payment-path";

type DocHeader = Record<string, unknown> | null | undefined;

/** true when total minus paid still leaves a balance. */
function hasBalance(h: DocHeader): boolean {
  const total = Number(h?.total_sen ?? h?.local_total_sen ?? 0);
  const paid = Number(h?.paid_sen ?? 0);
  const t = Number.isFinite(total) ? total : 0;
  const p = Number.isFinite(paid) ? paid : 0;
  return t > 0 && t - p > 0;
}

/** Is the Record Payment sheet offered? Sales invoices only, confirmed and still owed. */
export function offersRecordPayment(moduleKey: string, header: DocHeader): boolean {
  if (moduleKey !== "sales-invoices") return false;
  const st = typeof header?.status === "string" ? header.status.toUpperCase() : "";
  if (st === "CANCELLED" || st === "DRAFT") return false;
  return hasBalance(header);
}

/** The sentence a purchase invoice's footer shows while the invoice still awaits payment. */
export function piPaymentHint(moduleKey: string, header: DocHeader): string | null {
  if (moduleKey !== "purchase-invoices" || !header) return null;
  return piAwaitsPayment(header as PayablePi) ? PI_PAYMENT_ROUTE_HINT : null;
}
