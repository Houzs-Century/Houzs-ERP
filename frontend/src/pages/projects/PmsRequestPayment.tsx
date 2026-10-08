// ----------------------------------------------------------------------------
// PmsRequestPayment — 「Request payment」 on an event's CONTRACT row (owner
// 2026-10-08: 我的bd 会upload rental invoice 在这里，可以让他连过来for request
// payment 吗 … 就在这里加request payment … 做，但可以有可能是performa invoice,
// 所以finance 这样也要可以remark 要follow up actual invoice).
//
//   • The row's ACTIONS gain 「Request payment」: tick the row's file(s) that
//     are the bill → the payment request form opens with them read and the
//     row's event fixed (pages/scm-v2/PaymentRequestForm.tsx).
//   • Under the row, its requests: number, stage, amount, what answered it, and
//     the 欠正式单 state with Finance's remark — and, while the official invoice
//     is owed, 「Send the actual invoice · 补正式单」 from the row's own files
//     (the BD attaches it to the row first, as always).
// The dialogs load on first use (PmsRequestModals.tsx): the PMS page does not
// carry the request form until someone asks. Server: routes/payment-requests.ts
// (checklistItemId, GET /from-checklist), lib/pms-checklist-source.ts.
// ----------------------------------------------------------------------------

import { Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import { HandCoins } from 'lucide-react';
import { STAGE, answerText, type PaymentRequest } from '../../vendor/scm/lib/payment-request-queries';
import { OfficialDocChip } from '../../vendor/scm/components/OfficialDoc';
import { fmtSen } from '../../vendor/shared/format';
import type { TaskAttachment } from './types';

const PmsRequestModals = lazy(() => import('./PmsRequestModals'));

/** The checklist sections a payment may be asked from — the server's own list
    (lib/pms-checklist-source.ts PAYABLE_SECTIONS). */
export const PAYABLE_SECTION_NAMES: readonly string[] = ['CONTRACT'];
export const isPayableSectionName = (name: string | null | undefined): boolean =>
  PAYABLE_SECTION_NAMES.includes(String(name ?? '').trim().toUpperCase());

/** Who sees the button and the row's requests: a requester, or Finance. */
export const PAYMENT_REQUEST_PERMS: readonly string[] = ['scm.payment_request.create', 'scm.payment_voucher.create'];

/** A row's real files — merged crew photos (id < 0) are views, not uploads. */
export const rowFiles = (attachments: TaskAttachment[]): TaskAttachment[] => attachments.filter((a) => a.id > 0);

/** The row's requests, grouped by row. */
export function requestsByRow(requests: PaymentRequest[] | undefined): Map<number, PaymentRequest[]> {
  const out = new Map<number, PaymentRequest[]>();
  for (const r of requests ?? []) {
    const id = Number(r.checklist_item_id);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.set(id, [...(out.get(id) ?? []), r]);
  }
  return out;
}

export function RequestPaymentButton({ itemId, itemTitle, attachments, projectId, eventLabel, className, onNoFiles }: {
  itemId: number;
  itemTitle: string;
  attachments: TaskAttachment[];
  projectId: number;
  eventLabel: string;
  className: string;
  /** Nothing on the row to send yet — the page says so its own way. */
  onNoFiles: () => void;
}) {
  const [open, setOpen] = useState(false);
  const files = rowFiles(attachments);
  return (
    <>
      <button
        type="button"
        onClick={() => { if (files.length === 0) onNoFiles(); else setOpen(true); }}
        title="Ask Finance to pay the bill on this row · 申请付款"
        className={className}
      >
        <HandCoins size={12} />
        Request payment
      </button>
      {open && (
        <Suspense fallback={null}>
          <PmsRequestModals mode="request" itemId={itemId} itemTitle={itemTitle} attachments={files} projectId={projectId} eventLabel={eventLabel} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}

export function RowRequests({ requests, attachments, finance, meId }: {
  requests: PaymentRequest[];
  attachments: TaskAttachment[];
  /** Finance sees and answers every request; a requester their own. */
  finance: boolean;
  meId: number | null;
}) {
  const [officialFor, setOfficialFor] = useState<PaymentRequest | null>(null);
  if (requests.length === 0) return null;
  return (
    <div className="space-y-1 rounded-md border border-border-subtle bg-bg/40 px-2 py-1.5" aria-label="Payment requests from this row">
      {requests.map((r) => {
        const owed = r.officialDoc?.state === 'OWED' || r.officialDoc?.state === 'RECEIVED';
        const mayUpload = finance || (meId != null && Number(r.requested_by) === meId);
        const answer = answerText(r);
        return (
          <div key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] leading-snug">
            <Link to={`/scm/payment-requests?open=${encodeURIComponent(r.id)}`} className="font-mono font-semibold text-accent hover:underline">
              {r.request_no}
            </Link>
            {(r.installment_no ?? 1) > 1 && <span className="text-ink-muted">#{r.installment_no} · balance</span>}
            <span className="font-semibold" style={{ color: STAGE[r.stage].tone }}>{STAGE[r.stage].label}</span>
            <span className="text-ink-secondary">{fmtSen(r.amount_sen)}</span>
            {answer && <span className="text-ink-muted">· {answer}</span>}
            {r.officialDoc && <OfficialDocChip state={r.officialDoc.state} note={r.officialDoc.note} />}
            {/* Finance's remark on what to follow up — said where the BD works. */}
            {r.officialDoc?.note && <span className="text-ink-secondary">— {r.officialDoc.note}</span>}
            {owed && mayUpload && (
              <button
                type="button"
                onClick={() => setOfficialFor(r)}
                className="rounded border border-accent/40 bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-accent hover:bg-accent/5"
              >
                Send the actual invoice · 补正式单
              </button>
            )}
          </div>
        );
      })}
      {officialFor && (
        <Suspense fallback={null}>
          <PmsRequestModals mode="official" requestId={officialFor.id} requestNo={officialFor.request_no} attachments={rowFiles(attachments)} onClose={() => setOfficialFor(null)} />
        </Suspense>
      )}
    </div>
  );
}
