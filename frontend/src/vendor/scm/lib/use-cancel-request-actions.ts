/* ----------------------------------------------------------------------------
   use-cancel-request-actions — approve / reject / withdraw / cancel-now for one
   cancellation request row, as ONE flow behind every list that shows such rows.

   Owner 2026-09-24 put cancellation requests in the SO Amendment queue as well
   as their own inbox (「当有 SO request cancel bill - 需要在 SO amendment 出现」),
   and the phone shows the same list — so the same four actions are now on three
   screens. They are here rather than in each of them because the flow is not
   just a mutation: the confirm wording changes with the level, a reject needs a
   reason the requester can act on, and the FINAL approve has to run the
   document's own cancel afterwards. Three hand-written copies of that would
   drift, and the one that drifted would be the one that skipped the cancel.

   NOTHING HERE CANCELS ANYTHING ITSELF. The final approve answers
   `execute: true` and this hook then calls the document's own cancel mutation —
   the one the Cancel button always ran — so every guard that cancel carries
   (version CAS, downstream lock, PWP vouchers, customer credit, AutoCount
   outbox) stays exactly where it is. If that cancel is refused the request
   stays APPROVED and "Cancel now" retries it.
   ---------------------------------------------------------------------------- */

import { useConfirm } from '../components/ConfirmDialog';
import { usePrompt } from '../components/PromptDialog';
import { serviceNotify } from './dialog-service';
import { useUpdateMfgSalesOrderStatus } from './sales-order-queries';
import { useCancelPurchaseOrder } from './suppliers-queries';
import {
  approveLabel,
  docTypeOfRow,
  isFinalLevel,
  pendingLevel,
  useApproveCancelRequest,
  useRejectCancelRequest,
  useWithdrawCancelRequest,
  type CancelRequestRow,
} from './document-cancel-queries';

const DOC_LABEL: Record<CancelRequestRow['doc_type'], string> = {
  SO: 'Sales Order',
  PO: 'Purchase Order',
  DO: 'Delivery Order',
};

export type CancelRequestActions = {
  approve: (row: CancelRequestRow) => Promise<void>;
  reject: (row: CancelRequestRow) => Promise<void>;
  withdraw: (row: CancelRequestRow) => Promise<void>;
  /** Run the document's own cancel on an already-APPROVED request. */
  executeNow: (row: CancelRequestRow) => Promise<void>;
  /** True while any of them is in flight. */
  busy: boolean;
};

/** The approve button's words for a row — the level it will sign, or null when
 *  the row is not waiting for a signature. */
export function approveButtonLabel(row: CancelRequestRow): string | null {
  const level = pendingLevel(row.status);
  if (level == null) return null;
  return isFinalLevel(docTypeOfRow(row), level) ? 'Approve & cancel' : approveLabel(docTypeOfRow(row), level);
}

/** True when signing this row cancels the document on the spot. */
export const approveIsFinal = (row: CancelRequestRow): boolean => {
  const level = pendingLevel(row.status);
  return level != null && isFinalLevel(docTypeOfRow(row), level);
};

export function useCancelRequestActions(
  /** Called after an action changed something — for the sidebar approval badge. */
  onChanged?: () => void,
): CancelRequestActions {
  const askPrompt = usePrompt();
  const askConfirm = useConfirm();
  const approveSo = useApproveCancelRequest('so');
  const approvePo = useApproveCancelRequest('po');
  const rejectSo = useRejectCancelRequest('so');
  const rejectPo = useRejectCancelRequest('po');
  const withdrawSo = useWithdrawCancelRequest('so');
  const withdrawPo = useWithdrawCancelRequest('po');
  const cancelSo = useUpdateMfgSalesOrderStatus();
  const cancelPo = useCancelPurchaseOrder();

  const fail = (title: string, err: unknown) =>
    serviceNotify({ title, body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });

  const changed = () => { try { onChanged?.(); } catch { /* a badge refresh must never fail an approval */ } };

  const executeNow = async (row: CancelRequestRow) => {
    if (row.doc_type === 'SO') {
      await cancelSo.mutateAsync({ docNo: row.doc_key, status: 'CANCELLED', expectedStatus: row.doc_status_at_request ?? null });
    } else {
      /* The row's own words are the reason the cancel now requires (owner
         2026-09-09). Only a request raised before the PO's approval was cut can
         still reach this branch — nothing raises a new one. */
      await cancelPo.mutateAsync({ id: row.doc_key, reason: row.reason });
    }
    changed();
    void serviceNotify({ title: `${DOC_LABEL[row.doc_type]} ${row.doc_number} cancelled`, body: 'The approval is complete and the cancellation has run.' });
  };

  const approve = async (row: CancelRequestRow) => {
    const final = approveIsFinal(row);
    if (!(await askConfirm({
      title: final ? `Approve and cancel ${row.doc_number}?` : `Give level-1 approval to cancel ${row.doc_number}?`,
      body: final
        ? 'This is the final approval. The document is cancelled on your signature.'
        : 'Level 2 still has to approve after you. Nothing is cancelled yet.',
      confirmLabel: final ? 'Approve & cancel' : 'Approve (level 1)',
      danger: final,
    }))) return;
    try {
      const res = await (docTypeOfRow(row) === 'so' ? approveSo : approvePo).mutateAsync({ key: row.doc_key });
      changed();
      if (res.execute) await executeNow(row);
      else void serviceNotify({ title: 'Level-1 approval recorded', body: `${row.doc_number} now waits for the level-2 approver.` });
    } catch (err) {
      void fail('Could not approve', err);
    }
  };

  const reject = async (row: CancelRequestRow) => {
    const reason = await askPrompt({
      title: `Reject the cancellation of ${row.doc_number}?`,
      body: 'The document keeps its status. Say why, so the person who raised it knows — they will see this.',
      multiline: true,
      confirmLabel: 'Reject request',
      validate: (v) => (v.trim().length < 5 ? 'Give a reason the requester can act on — at least a few words.' : null),
    });
    if (reason == null) return;
    try {
      await (docTypeOfRow(row) === 'so' ? rejectSo : rejectPo).mutateAsync({ key: row.doc_key, reason: reason.trim() });
      changed();
    } catch (err) {
      void fail('Could not reject', err);
    }
  };

  const withdraw = async (row: CancelRequestRow) => {
    if (!(await askConfirm({ title: `Withdraw the cancellation request on ${row.doc_number}?`, confirmLabel: 'Withdraw request' }))) return;
    try {
      await (docTypeOfRow(row) === 'so' ? withdrawSo : withdrawPo).mutateAsync({ key: row.doc_key });
      changed();
    } catch (err) {
      void fail('Could not withdraw', err);
    }
  };

  const busy =
    approveSo.isPending || approvePo.isPending || rejectSo.isPending || rejectPo.isPending
    || withdrawSo.isPending || withdrawPo.isPending || cancelSo.isPending || cancelPo.isPending;

  return { approve, reject, withdraw, executeNow: async (row) => { try { await executeNow(row); } catch (err) { void fail('Cancel failed', err); } }, busy };
}
