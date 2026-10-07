// ----------------------------------------------------------------------------
// BackdateRequestQuickView — the side drawer a SINGLE click on a Payment
// Backdate Requests row opens (owner 2026-10-07: 「bank backdate request - 需要
// 右侧打开」), the way an amendment queue row opens AmendmentQuickView.
// Double-click still opens the Sales Order.
//
// Everything the admin needs to decide is here: the payment as it was keyed in
// (amount, slip date, method, collector, sheet, approval code, note), who asked
// and why, the slip itself, and — for an open request that is not their own —
// the same Approve / Reject the row's Actions column carries. Both go through
// useBackdateDecisions, so the drawer can never decide differently from the
// row. A decision closes the drawer: on the Open scope the row is gone.
// ----------------------------------------------------------------------------

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X as XIcon } from 'lucide-react';
import { fmtDate, fmtDateTime, fmtMoneySen } from '../../vendor/shared/format';
import { ResizableDetailDrawer } from '../../components/ResizableDetailDrawer';
import { TonedPill } from '../../vendor/scm/components/StatusPill';
import { useBackdateDecisions } from '../../vendor/scm/components/BackdateRequestsPanel';
import { PAYMENT_METHOD_CODE_TO_VALUE } from '../../vendor/scm/lib/payment-methods';
import { fetchBackdateRequestSlipUrl } from '../../vendor/scm/lib/slip';
import { backdateStatusLabel, type BackdateRequestRow } from '../../vendor/scm/lib/payment-backdate-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useStaffLookup } from '../../hooks/useStaffLookup';

/** The Sales Order a row opens — one answer for the double-click and the drawer. */
export const backdateRequestOrderPath = (r: Pick<BackdateRequestRow, 'so_doc_no'>): string =>
  `/scm/sales-orders/${encodeURIComponent(r.so_doc_no)}`;

const methodLabel = (code: string): string =>
  (PAYMENT_METHOD_CODE_TO_VALUE as Record<string, string>)[code] ?? code;

/** Method plus what qualifies it: the merchant and tenure, or the online rail. */
export const backdateMethodLine = (r: Pick<BackdateRequestRow, 'method' | 'merchant_provider' | 'installment_months' | 'online_type'>): string =>
  [
    methodLabel(r.method),
    r.merchant_provider,
    r.installment_months ? `${r.installment_months} months` : null,
    r.online_type,
  ].filter(Boolean).join(' · ');

const STATUS_TONE: Record<BackdateRequestRow['status'], 'pending' | 'success' | 'danger' | 'neutral'> = {
  REQUESTED: 'pending', APPROVED: 'success', REJECTED: 'danger', WITHDRAWN: 'neutral',
};

export function BackdateRequestQuickView({ row, onClose }: { row: BackdateRequestRow | null; onClose: () => void }) {
  return (
    <ResizableDetailDrawer
      open={row != null}
      onClose={onClose}
      ariaLabel={row ? `Backdate request ${row.so_doc_no}` : 'Backdate request details'}
    >
      {row && <Body key={row.id} row={row} onClose={onClose} />}
    </ResizableDetailDrawer>
  );
}

function Body({ row, onClose }: { row: BackdateRequestRow; onClose: () => void }) {
  const navigate = useNavigate();
  const { actorNameOf } = useStaffLookup();
  const { run, busy } = useBackdateDecisions();
  const myId = Number(useHouzsAuth().user?.id);
  const mine = Number(row.requested_by) === myId;
  const open = row.status === 'REQUESTED';

  const decide = async (action: 'approve' | 'reject') => {
    if (await run(row, action)) onClose();
  };

  return (
    <>
      <div className="flex h-[60px] shrink-0 items-center gap-3 bg-sidebar px-5 text-sidebar-ink">
        <button type="button" onClick={onClose} className="text-sidebar-ink-muted hover:text-sidebar-ink" aria-label="Close details">
          <XIcon size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[14px] font-bold tracking-wide">{row.so_doc_no}</div>
          <div className="mt-0.5 text-[11px] text-sidebar-ink-muted">Payment backdate request</div>
        </div>
        <button
          type="button"
          onClick={() => navigate(backdateRequestOrderPath(row))}
          className="inline-flex items-center gap-1.5 rounded-md border border-accent-bright/40 px-2.5 py-1.5 text-[11.5px] font-semibold text-accent-bright hover:bg-accent-bright/10"
        >
          Open Sales Order <ExternalLink size={12} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-[19px] font-bold tabular-nums text-ink">{fmtMoneySen(row.amount_sen)}</span>
          <span className="text-[12.5px] text-ink-muted">slip {fmtDate(row.paid_at)}</span>
          <TonedPill label={backdateStatusLabel(row.status)} tone={STATUS_TONE[row.status]} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border bg-surface-2 px-4 py-4">
          <MetaItem k="Method" v={backdateMethodLine(row)} />
          <MetaItem k="Approval code" v={row.approval_code || '—'} />
          <MetaItem k="Account sheet" v={row.account_sheet || '—'} />
          <MetaItem k="Collected by" v={actorNameOf(row.collected_by)} />
          <MetaItem k="Requested by" v={row.requested_by_name ?? '—'} />
          <MetaItem k="Requested" v={fmtDateTime(row.requested_at)} />
        </dl>

        <SectionHeading>Reason</SectionHeading>
        <p className="text-[13px] leading-relaxed text-ink-secondary" style={{ overflowWrap: 'anywhere' }}>{row.reason}</p>

        {(row.note ?? '').trim() && (
          <>
            <SectionHeading>Payment note</SectionHeading>
            <p className="text-[13px] leading-relaxed text-ink-secondary" style={{ overflowWrap: 'anywhere' }}>{row.note}</p>
          </>
        )}

        {row.decided_at && (
          <div className={`mt-5 rounded-md border px-3 py-2 text-[12px] ${row.status === 'APPROVED' ? 'border-ok/40 bg-ok/10 text-ink' : 'border-err/40 bg-err/10 text-err'}`}>
            <div className="font-semibold">
              {backdateStatusLabel(row.status)} by {row.decided_by_name ?? 'admin'} · {fmtDateTime(row.decided_at)}
            </div>
            {row.decision_note && <div className="mt-1">“{row.decision_note}”</div>}
          </div>
        )}

        <SectionHeading>Payment slip</SectionHeading>
        {row.slip_key ? <Slip requestId={row.id} /> : <div className="text-[12px] text-ink-muted">No slip was attached to this request.</div>}
      </div>

      {open && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-surface px-5 py-3">
          {mine ? (
            <div className="text-[12px] text-ink-muted">Your own request — another admin has to decide it.</div>
          ) : (
            <>
              <div className="text-[12px] text-ink-muted">Approve records the payment on {row.so_doc_no}.</div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide('reject')}
                  className="rounded-md border border-err/50 px-3 py-1.5 text-[12px] font-semibold text-err hover:bg-err/10 disabled:opacity-50"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void decide('approve')}
                  className="rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-ink hover:opacity-90 disabled:opacity-50"
                >
                  Approve & record
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

/* The slip as a blob object URL through the Worker proxy — the same fetch shape
   as a recorded payment's slip (PaymentsTable), keyed by request so a reopened
   drawer does not re-download it. */
function Slip({ requestId }: { requestId: string }) {
  const q = useQuery({
    queryKey: ['payment-backdate-request-slip', requestId],
    queryFn: () => fetchBackdateRequestSlipUrl(requestId),
    staleTime: 4 * 60 * 1000,
  });
  if (q.isLoading) return <div className="text-[12px] text-ink-muted">Loading slip…</div>;
  if (q.isError || !q.data) {
    return (
      <div className="rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12px] text-err">
        Could not load the slip. {q.error instanceof Error ? q.error.message : ''}
      </div>
    );
  }
  const { url, contentType } = q.data;
  if (!contentType.startsWith('image/')) {
    return <a href={url} target="_blank" rel="noreferrer" className="text-[12.5px] font-semibold text-accent-bright">Open the slip (PDF)</a>;
  }
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open payment slip full size" className="block">
      <img src={url} alt="Payment slip" className="max-h-[480px] w-full rounded-md border border-border bg-surface-2 object-contain" />
    </a>
  );
}

function MetaItem({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9.5px] font-semibold uppercase tracking-brand text-ink-muted">{k}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-semibold text-ink">{v}</dd>
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2.5 mt-6 font-mono text-[10px] font-semibold uppercase tracking-brand text-ink-muted">
      {children}
    </div>
  );
}
