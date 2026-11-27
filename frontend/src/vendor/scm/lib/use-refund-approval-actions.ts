/* ----------------------------------------------------------------------------
   use-refund-approval-actions — approve or reject one refund request waiting
   for its approval (owner 2026-11-27: 「只要一级，但这一级的权限和cancel 的第二级
   一样」), as ONE flow behind the desktop approval lists and the phone's: the
   confirm names the order and the amount, and a reject asks for a reason the
   requester reads. Who may sign is the server's to decide; it refuses anyone
   else, and the mutation shows that refusal.
   ---------------------------------------------------------------------------- */

import { useConfirm } from '../components/ConfirmDialog';
import { usePrompt } from '../components/PromptDialog';
import { fmtSen } from '../../../../../shared/src/vendor/shared/format';
import { useApproveRefundRequest, useReturnPaymentRequest, type PaymentRequest } from './payment-request-queries';

export type RefundApprovalActions = {
  approve: (r: PaymentRequest) => Promise<void>;
  reject: (r: PaymentRequest) => Promise<void>;
  busy: boolean;
};

const orderOf = (r: Pick<PaymentRequest, 'refund_source_doc_no' | 'request_no'>): string => r.refund_source_doc_no ?? r.request_no;

export function useRefundApprovalActions(onChanged: (() => void) | null): RefundApprovalActions {
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const approveRefund = useApproveRefundRequest();
  const rejectRefund = useReturnPaymentRequest();

  const changed = () => { try { onChanged?.(); } catch { } };

  const approve = async (r: PaymentRequest) => {
    const ok = await askConfirm({
      title: `Approve the refund of ${fmtSen(r.amount_sen)} on ${orderOf(r)}?`,
      body: `${r.payee_name}: ${r.purpose}. Finance can then pay it back.`,
      confirmLabel: 'Approve refund',
    });
    if (!ok) return;
    try {
      await approveRefund.mutateAsync(r.id);
      changed();
    } catch { }
  };

  const reject = async (r: PaymentRequest) => {
    const reason = await askPrompt({
      title: `Reject the refund on ${orderOf(r)}?`,
      body: 'The money stays on the order. Say why, so the person who asked knows — they will see this.',
      multiline: true,
      confirmLabel: 'Reject refund',
      validate: (v) => (v.trim().length < 5 ? 'Give a reason the requester can act on — at least a few words.' : null),
    });
    if (reason == null) return;
    try {
      await rejectRefund.mutateAsync({ id: r.id, note: reason.trim() });
      changed();
    } catch { }
  };

  return { approve, reject, busy: approveRefund.isPending || rejectRefund.isPending };
}
