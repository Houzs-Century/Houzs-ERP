/* ----------------------------------------------------------------------------
   CancelRequestPanel — the ONE way an open cancellation request is shown and
   acted on, on the Sales Order and the Purchase Order detail pages (desktop
   and mobile).

   THE OWNER, 2026-09-08: 「SO 和 PO 取消的话需要 approval 2 层 — 已经输入原因」.

   IT SITS ABOVE THE DOCUMENT AND NEVER CHANGES ITS STATUS PILL. The request is
   a row beside the document, not a state of it (the same reading as the hold
   marker, mig 0324): the order still says Confirmed / In Production, and this
   card says "cancellation requested — waiting for level-2 approval (1 of 2)".

   WHAT IT DOES ON LEVEL 2. The approve route answers `execute: true` and the
   panel then calls `onExecute` — the page's OWN cancel mutation, the one its
   Cancel button always ran — so "approve" and "cancel" are one click for the
   second approver while every guard the cancel carries stays exactly where it
   is. If that cancel is refused (a Delivery Order was raised in between), the
   request stays APPROVED, the card says so, and "Cancel now" retries it.

   WHO SEES WHICH BUTTON is decided by the same rules the server enforces
   (document-cancel-queries.ts viewerCan*), but only to avoid showing a person
   a button that will 403 — the server's answer is the gate.
   ---------------------------------------------------------------------------- */

import { useState } from 'react';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { fmtDateTime } from '../../shared/format';
import { useConfirm } from './ConfirmDialog';
import { usePrompt } from './PromptDialog';
import { serviceNotify } from '../lib/dialog-service';
import { STATUS_TONES } from '../lib/status-pill';
import {
  approveLabel,
  cancelRequestLine,
  isFinalLevel,
  pendingLevel,
  useApproveCancelRequest,
  useCancelRequest,
  useRejectCancelRequest,
  useWithdrawCancelRequest,
  docTypeOfRow,
  levelsFor,
  viewerCanApprove,
  viewerCanReject,
  viewerCanWithdraw,
  type CancelDocType,
  type CancelRequestRow,
} from '../lib/document-cancel-queries';

export type CancelRequestPanelProps = {
  docType: CancelDocType;
  /** `doc_no` for the Sales Order, `id` for the Purchase Order. */
  docKey: string | null | undefined;
  /** What the person calls it. */
  docNumber: string;
  /** The page's own cancel — run after the second signature, and by "Cancel now". */
  onExecute?: () => void | Promise<unknown>;
  /** True while the page's cancel mutation is in flight. */
  executing?: boolean;
  /** Compact layout for the mobile detail. */
  compact?: boolean;
};

const who = (name: string | null | undefined, at: string | null | undefined): string =>
  `${(name ?? '').trim() || 'someone'}${at ? ` · ${fmtDateTime(at)}` : ''}`;

const btn = (danger = false): React.CSSProperties => ({
  fontFamily: 'var(--font-button)', fontSize: 'var(--fs-12, 12px)', fontWeight: 700,
  padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
  border: `1px solid ${danger ? 'var(--c-festive-b, #B8331F)' : 'var(--line-strong)'}`,
  background: 'var(--c-paper)', color: danger ? 'var(--c-festive-b, #B8331F)' : 'var(--c-ink)',
});

export function CancelRequestPanel({ docType, docKey, docNumber, onExecute, executing, compact }: CancelRequestPanelProps) {
  const q = useCancelRequest(docType, docKey ?? null);
  const { user, can } = useHouzsAuth();
  const approve = useApproveCancelRequest(docType);
  const reject = useRejectCancelRequest(docType);
  const withdraw = useWithdrawCancelRequest(docType);
  const askPrompt = usePrompt();
  const askConfirm = useConfirm();
  const [busy, setBusy] = useState(false);

  const open = q.data?.open ?? null;
  if (!open || !docKey) return null;

  const viewer = { userId: user?.id ?? null, can };
  const level = pendingLevel(open.status);
  /* A Sales Order takes two signatures, a Purchase Order one — the final
     signature is the one that cancels, whichever number it carries. */
  const final = level != null && isFinalLevel(docType, level);
  const approved = open.status === 'APPROVED';
  const pending = busy || approve.isPending || reject.isPending || withdraw.isPending || !!executing;

  const fail = (title: string, err: unknown) =>
    serviceNotify({ title, body: err instanceof Error ? err.message : 'Something went wrong.', tone: 'error' });

  const doApprove = async () => {
    if (!(await askConfirm({
      title: final ? `Approve and cancel ${docNumber}?` : `Give level-1 approval to cancel ${docNumber}?`,
      body: final
        ? `This is the final approval. The document is cancelled on your signature${docType === 'so' ? ' — a cancelled sales order cannot be reactivated' : ''}.`
        : 'Level 2 still has to approve after you. Nothing is cancelled yet.',
      confirmLabel: final ? 'Approve & cancel' : 'Approve (level 1)',
      danger: final,
    }))) return;
    setBusy(true);
    try {
      const res = await approve.mutateAsync({ key: docKey });
      if (res.execute && onExecute) await onExecute();
      else if (!res.execute) void serviceNotify({ title: 'Level-1 approval recorded', body: `${docNumber} now waits for the level-2 approver.` });
    } catch (err) {
      void fail('Could not approve', err);
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    const reason = await askPrompt({
      title: `Reject the cancellation of ${docNumber}?`,
      body: 'The document keeps its status. Say why, so the person who raised it knows — they will see this.',
      placeholder: 'e.g. production has already started',
      multiline: true,
      confirmLabel: 'Reject request',
      validate: (v) => (v.trim().length < 5 ? 'Give a reason the requester can act on — at least a few words.' : null),
    });
    if (reason == null) return;
    try { await reject.mutateAsync({ key: docKey, reason: reason.trim() }); } catch (err) { void fail('Could not reject', err); }
  };

  const doWithdraw = async () => {
    if (!(await askConfirm({ title: `Withdraw the cancellation request on ${docNumber}?`, body: 'The request is closed and the document carries on as it is. A new request can be raised later.', confirmLabel: 'Withdraw request' }))) return;
    try { await withdraw.mutateAsync({ key: docKey }); } catch (err) { void fail('Could not withdraw', err); }
  };

  const tone = approved ? STATUS_TONES.danger : STATUS_TONES.pending;

  return (
    <section
      data-testid="cancel-request-panel"
      style={{
        border: `1px solid ${tone.fg}`, background: tone.bg, borderRadius: 'var(--radius-lg, 10px)',
        padding: compact ? '10px 12px' : '12px 16px', marginBottom: compact ? 10 : 14,
        display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ color: tone.fg, fontSize: 'var(--fs-13, 13px)' }}>
          Cancellation requested
        </strong>
        <span style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-ink)' }}>{cancelRequestLine(open)}</span>
      </div>
      <div style={{ fontSize: 'var(--fs-12, 12px)', color: 'var(--c-ink)', whiteSpace: 'pre-wrap' }}>
        <span style={{ color: 'var(--fg-muted)' }}>Reason: </span>{open.reason}
      </div>
      <Signatures row={open} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
        {viewerCanApprove(open, viewer) && (
          <button type="button" style={btn(final)} disabled={pending} onClick={doApprove}>
            {level != null ? approveLabel(docType, level) : 'Approve'}
          </button>
        )}
        {approved && onExecute && (
          <button type="button" style={btn(true)} disabled={pending} onClick={() => void onExecute()}>
            {executing ? 'Cancelling…' : 'Cancel now'}
          </button>
        )}
        {viewerCanReject(open, viewer) && (
          <button type="button" style={btn()} disabled={pending} onClick={doReject}>Reject</button>
        )}
        {viewerCanWithdraw(open, viewer) && (
          <button type="button" style={btn()} disabled={pending} onClick={doWithdraw}>Withdraw request</button>
        )}
      </div>
    </section>
  );
}

function Signatures({ row }: { row: CancelRequestRow }) {
  return (
    <div style={{ fontSize: 'var(--fs-11, 11px)', color: 'var(--fg-muted)', display: 'flex', flexWrap: 'wrap', gap: '4px 14px' }}>
      <span>Raised by {who(row.requested_by_name, row.requested_at)}</span>
      <span>{levelsFor(docTypeOfRow(row)) > 1 ? 'Level 1' : 'Approval'}: {row.l1_at ? who(row.l1_by_name, row.l1_at) : 'pending'}</span>
      {levelsFor(docTypeOfRow(row)) > 1 && <span>Level 2: {row.l2_at ? who(row.l2_by_name, row.l2_at) : 'pending'}</span>}
    </div>
  );
}
