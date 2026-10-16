/* WHY A DRAFT PAYMENT ROW CANNOT BE SAVED WITHOUT ITS PROOF, or null (owner
   2026-10-13: every collected payment is keyed with its slip). The rule is
   payment-slip-required (the backend reads the same file); this adds what the
   rule must not know — a row EDITING a booked payment keeps the slip it has, a
   scanned card receipt IS the slip, and money MOVED from another order was
   receipted when first collected. One function for the desktop panel's Save,
   the phone sheet and both New SO screens, so no surface can ask a different
   question. */
import type { PaymentDraft } from '../components/PaymentsTable';
import { CONVERT_LABEL } from './so-money-queries';
import { checkPaymentSlip } from './payment-slip-required';

export { SLIP_REQUIRED_REASON } from './payment-slip-required';

export const slipMissingProblem = (
  d: Pick<PaymentDraft, 'methodLabel' | 'slipUploadSessionId'> & Partial<Pick<PaymentDraft, 'receiptImageKey' | 'editingPersistedId'>>,
): string | null => {
  if (d.editingPersistedId) return null;
  const verdict = checkPaymentSlip({
    converted: d.methodLabel === CONVERT_LABEL,
    hasSlip: Boolean(d.slipUploadSessionId) || Boolean(d.receiptImageKey),
  });
  return verdict.ok ? null : verdict.reason;
};
