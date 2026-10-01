/* The Sales Order's payment backdate requests (owner 2026-09-30: 「超过14天 ...
   只有 admin 可以看到 request」) — one card for the desktop payments panel and the
   phone's payments list. An admin sees every request on the order and decides it
   here; anyone else sees only what they raised, and may withdraw it. The server
   answers the same split (GET /:docNo/payment-backdate-requests), so this only
   decides which buttons to draw. Renders nothing while the order has none. */
import type { CSSProperties } from 'react';
import { fmtDate, fmtMoneySen } from '../../shared/format';
import { useAuth as useHouzsAuth } from '../../../auth/AuthContext';
import { usePrompt } from './ConfirmDialog';
import { useNotify } from './NotifyDialog';
import { PAYMENT_METHOD_CODE_TO_VALUE } from '../lib/payment-methods';
import {
  backdateStatusLabel,
  useDecideBackdateRequest,
  useSoBackdateRequests,
  type BackdateRequestRow,
} from '../lib/payment-backdate-queries';

const btn: CSSProperties = {
  fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid var(--line-strong, #d1d5db)', background: 'var(--c-paper, #fff)', color: 'var(--c-ink, #111827)',
};

const methodLabel = (code: string): string =>
  (PAYMENT_METHOD_CODE_TO_VALUE as Record<string, string>)[code] ?? code;

export function useBackdateDecisions() {
  const decide = useDecideBackdateRequest();
  const prompt = usePrompt();
  const notify = useNotify();
  const run = async (row: BackdateRequestRow, action: 'approve' | 'reject' | 'withdraw') => {
    let note: string | undefined;
    if (action === 'approve') {
      const answer = await prompt({
        title: `Approve ${fmtMoneySen(row.amount_sen)} dated ${fmtDate(row.paid_at)}?`,
        body: `The payment is recorded on ${row.so_doc_no} at once. Requested by ${row.requested_by_name ?? 'staff'}: ${row.reason}`,
        input: { label: 'Remarks (optional)', placeholder: 'Checked against the bank statement' },
        confirmLabel: 'Approve & record',
      });
      if (answer === null) return;
      note = answer || undefined;
    } else if (action === 'reject') {
      const answer = await prompt({
        title: 'Reject this request?',
        body: 'Nothing is recorded. The requester sees your reason.',
        input: { label: 'Reason', placeholder: 'No bank line for this date', required: true },
        confirmLabel: 'Reject',
        danger: true,
      });
      if (answer === null) return;
      note = answer;
    }
    try {
      await decide.mutateAsync({ row, action, ...(note ? { note } : {}) });
    } catch (e) {
      void notify({ title: 'Not done', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  return { run, busy: decide.isPending };
}

export function BackdateRequestsPanel({ docNo, style }: { docNo: string; style?: CSSProperties }) {
  const { data } = useSoBackdateRequests(docNo);
  const { user } = useHouzsAuth();
  const { run, busy } = useBackdateDecisions();
  const rows = data?.requests ?? [];
  if (rows.length === 0) return null;
  const isAdmin = data?.isAdmin === true;
  const myId = Number(user?.id);

  return (
    <div style={{ marginTop: 12, border: '1px solid var(--border, #e5e7eb)', borderRadius: 8, padding: '10px 12px', ...style }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
        {isAdmin ? 'Backdated payment requests (slip older than 14 days)' : 'My backdated payment requests'}
      </div>
      {rows.map((r) => {
        const open = r.status === 'REQUESTED';
        return (
          <div key={r.id} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '6px 0', borderTop: '1px solid var(--border, #e5e7eb)', fontSize: 12 }}>
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div>
                <strong>{fmtMoneySen(r.amount_sen)}</strong> · {methodLabel(r.method)} · slip {fmtDate(r.paid_at)}
                {' · '}<span style={{ color: open ? 'var(--amber, #b45309)' : 'var(--mut, #6b7280)' }}>{backdateStatusLabel(r.status)}</span>
              </div>
              <div style={{ color: 'var(--mut, #6b7280)', overflowWrap: 'anywhere' }}>
                {r.requested_by_name ?? 'Staff'}: {r.reason}
                {r.decision_note ? ` — ${r.decided_by_name ?? 'Admin'}: ${r.decision_note}` : ''}
              </div>
            </div>
            {open && (
              <div style={{ display: 'flex', gap: 6 }}>
                {/* Nobody decides their own request — the server refuses it too. */}
                {isAdmin && Number(r.requested_by) !== myId && <button type="button" style={btn} disabled={busy} onClick={() => void run(r, 'approve')}>Approve</button>}
                {isAdmin && Number(r.requested_by) !== myId && <button type="button" style={btn} disabled={busy} onClick={() => void run(r, 'reject')}>Reject</button>}
                {Number(r.requested_by) === myId && <button type="button" style={btn} disabled={busy} onClick={() => void run(r, 'withdraw')}>Withdraw</button>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
