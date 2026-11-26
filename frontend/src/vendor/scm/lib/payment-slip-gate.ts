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
