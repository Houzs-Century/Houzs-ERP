/* ----------------------------------------------------------------------------
   How a purchase invoice is paid: one answer for the desktop and the phone.

   A supplier invoice is paid with an AP Payment, the payment voucher whose
   purpose is SUPPLIER_PAYMENT (owner flow, 2026-09-02). Finance ticks the
   invoice, the voucher goes through its approval cycle, and posting books the
   journal entry and settles the invoice through scm.settle_pi_paid_sen, which
   clamps to what is owed and refuses a held invoice.

   Until docs/bugs/0889-supplier-invoice-payments-could-skip-the-payment-voucher-and.md
   there was a second way in. The phone's Record Payment
   sheet typed an amount straight onto the invoice through
   PATCH /purchase-invoices/:id/payment: no voucher, no journal entry, no hold
   check, no approval. The desktop's own two buttons led nowhere: Record payment
   opened a `?tab=payments` the page never read, and Mark paid sent RM0, which
   that route refuses. The route now refuses every call, and both surfaces send
   the operator to the AP Payment instead.
   ---------------------------------------------------------------------------- */

import { rowIsHeld, type HoldFields } from '../components/HoldChip';

/** The page-access area `/scm/payment-vouchers/new` is guarded by (App.tsx). */
export const AP_PAYMENT_AREA = 'scm.finance.accounting';

export type PayablePi = HoldFields & {
  id: string;
  status?: string | null;
  total_sen?: number | null;
  paid_sen?: number | null;
  supplier?: { id: string } | null;
};

/**
 * Does this invoice still take a payment? The same test the AP Payment page
 * applies when it lists a supplier's invoices (POSTED or PARTIALLY_PAID with
 * something owed), plus the hold the voucher route refuses. A button that
 * leads to a page where the invoice is not offered is the defect this file
 * exists to end.
 */
export function piAwaitsPayment(pi: PayablePi | null | undefined): boolean {
  if (!pi) return false;
  const st = String(pi.status ?? '').toUpperCase();
  if (st !== 'POSTED' && st !== 'PARTIALLY_PAID') return false;
  if (rowIsHeld(pi)) return false;
  return Number(pi.total_sen ?? 0) - Number(pi.paid_sen ?? 0) > 0;
}

/** The AP Payment screen with this invoice's supplier chosen and the invoice ticked. */
export function apPaymentHrefFor(pi: Pick<PayablePi, 'id' | 'supplier'>): string {
  const q = new URLSearchParams({ type: 'ap' });
  if (pi.supplier?.id) q.set('supplier', pi.supplier.id);
  q.set('pi', pi.id);
  return `/scm/payment-vouchers/new?${q.toString()}`;
}

/** May this user open the AP Payment screen? The same two doors ScmGuard opens
 *  for that route: `scm.access` (which `*` satisfies) or the accounting area. */
export function canOpenApPayment(
  can: (perm: string) => boolean,
  pageAccess: (page: string) => string,
): boolean {
  return can('scm.access') || pageAccess(AP_PAYMENT_AREA) !== 'none';
}

/** What the phone says where its payment sheet used to be. The phone has no
 *  voucher screen, so the sentence names the one that records the payment. */
export const PI_PAYMENT_ROUTE_HINT =
  'Supplier payments are recorded as an AP Payment: Finance, Money out, Payment Vouchers.';
