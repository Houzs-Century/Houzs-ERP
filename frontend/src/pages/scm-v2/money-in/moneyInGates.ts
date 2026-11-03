// ----------------------------------------------------------------------------
// moneyInGates — who sees each kind on Money in's merged pages (the owner's
// Claude Design, batch 5 §1). Receipts took in Official receipts and Invoices
// took in Deposit invoices; the merged Sidebar entry shows to whoever saw
// either old one, and INSIDE the page each kind shows only to whoever saw its
// old entry — nobody sees more than before. The test is navFilter's: an entry
// opened to `scm.access` (not for an SCM L2 configuration), to the Money in
// page access, or to its own keys. The server's checks are unchanged.
// ----------------------------------------------------------------------------

import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';

export type MoneyInGates = {
  /** The payment-recording keys' entries — Official receipts, Deposit invoices
   *  (scm.payment_voucher.post or scm.sales_order.write). */
  paperKeys: boolean;
  /** The voucher create key's entries — Receipts, AR invoices. */
  createKeys: boolean;
};

export function useMoneyInGates(): MoneyInGates {
  const { user, can, pageAccess } = useHouzsAuth();
  const shared = (!user?.scm_l2_configured && can('scm.access')) || pageAccess('scm.finance.money_in') !== 'none';
  return {
    paperKeys: shared || can('scm.payment_voucher.post') || can('scm.sales_order.write'),
    createKeys: shared || can('scm.payment_voucher.create'),
  };
}
