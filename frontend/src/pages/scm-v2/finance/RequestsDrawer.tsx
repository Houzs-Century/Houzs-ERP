// ----------------------------------------------------------------------------
// RequestsDrawer — To do's "Payment requests" drawer in the owner's Claude
// Design (Money out, batch 4 step 10). The `requests` job's Review opens it on
// the To do page (?drawer=requests): one card per request waiting for Finance —
// what it is, from whom, how much, for what, where the money goes — with Send
// back (a reason, then today's return) and Make voucher › (New payment voucher
// prefilled from the request, in a workspace tab); a supplier's bill can be
// booked as an AP bill first. Nothing here posts: a voucher made from it starts
// as a draft and walks the four steps.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { CheckCircle2, Info, Undo2, X } from 'lucide-react';
import { ResizableDetailDrawer } from '../../../components/ResizableDetailDrawer';
import { useOpenDocInTab } from '../../../lib/openDocInTab';
import { fmtSen } from '../../../vendor/shared/format';
import {
  awaitsFinance, isRefundRequest, makeVoucherHref, requestKind, usePaymentRequests, useReturnPaymentRequest, type PaymentRequest,
} from '../../../vendor/scm/lib/payment-request-queries';
import { AP_INVOICE_TITLE, apInvoiceFromRequestHref, makeVoucherLabel, sendBackLabel } from '../PaymentRequestsFinance';
import styles from './FinanceTasks.module.css';
import look from './RequestsDrawer.module.css';

const firstName = (name: string | null): string => (name ?? '').trim().split(/\s+/)[0] || 'the requester';
/** Whole days a request has waited, by its MYT calendar day. */
const waitedDays = (createdAt: string, today: string): number =>
  Math.max(0, Math.round((Date.parse(today) - Date.parse(new Date(Date.parse(createdAt) + 8 * 3600_000).toISOString().slice(0, 10))) / 86_400_000));
const payTo = (r: PaymentRequest): string | null => {
  if (!r.bank_name && !r.bank_account_no) return null;
  const tail = (r.bank_account_no ?? '').replace(/\s+/g, '').slice(-4);
  return `${r.bank_name ?? 'Bank'}${tail ? ` ···· ${tail}` : ''}${isRefundRequest(r) ? ' (customer)' : ''}`;
};

function RequestCard({ r, today, onSentBack }: { r: PaymentRequest; today: string; onSentBack: (r: PaymentRequest) => void }) {
  const openInTab = useOpenDocInTab();
  const sendBack = useReturnPaymentRequest();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const days = waitedDays(r.created_at, today);
  const where = payTo(r);
  const back = async () => {
    try { await sendBack.mutateAsync({ id: r.id, note: note.trim() }); onSentBack(r); } catch { /* the hook says why */ }
  };
  return (
    <div className={look.req}>
      <div className={look.reqHead}>
        <span className={`${look.tag} ${isRefundRequest(r) ? look.toneWarn : look.toneCalm}`}>{requestKind(r)}</span>
        <span className={look.from}>from {r.requested_by_name ?? '—'}</span>
        <span className={look.grow} />
        <span className={look.amount}>{fmtSen(r.amount_sen)}</span>
      </div>
      <div className={look.payee}>{r.payee_name}</div>
      <div className={look.why}>{r.purpose}{r.note ? ` — ${r.note}` : ''}</div>
      <div className={look.facts}>
        {where && <span>Pay to {where}</span>}
        {r.bill_no && <span>Bill {r.bill_no}</span>}
        <span className={days >= 3 ? look.late : undefined}>{days === 0 ? 'Waiting since today' : `Waiting ${days} day${days === 1 ? '' : 's'}`}</span>
        <span className={look.no}>{r.request_no}</span>
      </div>
      {asking ? (
        <div className={look.askBox}>
          <textarea className={styles.textarea} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            placeholder={`Why does it go back? ${firstName(r.requested_by_name)} reads this.`} aria-label={`Why ${r.request_no} goes back`} />
          <div className={look.acts}>
            <button type="button" className={styles.btnSecondary} onClick={() => { setAsking(false); setNote(''); }} disabled={sendBack.isPending}>Cancel</button>
            <button type="button" className={styles.btnPrimary} onClick={() => void back()} disabled={!note.trim() || sendBack.isPending}>
              {sendBack.isPending ? 'Sending…' : sendBackLabel(r)}
            </button>
          </div>
        </div>
      ) : (
        <div className={look.acts}>
          <button type="button" className={look.link} onClick={() => setAsking(true)}>{sendBackLabel(r)}</button>
          <span className={look.grow} />
          {!isRefundRequest(r) && (
            <button type="button" className={styles.btnSecondary} title={AP_INVOICE_TITLE} onClick={() => openInTab(apInvoiceFromRequestHref(r))}>Make AP invoice</button>
          )}
          <button type="button" className={styles.btnPrimary} onClick={() => openInTab(makeVoucherHref(r))}>{makeVoucherLabel(r)} ›</button>
        </div>
      )}
    </div>
  );
}

export function RequestsDrawer({ open, onClose, today }: { open: boolean; onClose: () => void; today: string }) {
  const q = usePaymentRequests(false);
  const waiting = useMemo(() => (q.data?.requests ?? []).filter(awaitsFinance), [q.data]);
  /* What was decided here, said in place of the card (the design's resolved lines). */
  const [sentBack, setSentBack] = useState<PaymentRequest[]>([]);
  return (
    <ResizableDetailDrawer open={open} onClose={onClose} ariaLabel="Payment requests">
      {open && (
        <div className={styles.drawer}>
          <div className={styles.head}>
            <div>
              <div className={styles.headTitle}>Payment requests</div>
              <div className={styles.headSub}>{q.data ? `${waiting.length} waiting for Finance` : 'Reading the requests…'}</div>
            </div>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close"><X size={16} /></button>
          </div>
          <div className={styles.body}>
            {q.isError && <div className={styles.problem}>The requests could not be read — {q.error instanceof Error ? q.error.message : 'try again'}.</div>}
            {sentBack.map((r) => (
              <div key={`back-${r.id}`} className={`${look.done} ${look.doneBack}`}><Undo2 size={14} /> {r.request_no} sent back · {firstName(r.requested_by_name)} sees why</div>
            ))}
            {waiting.map((r) => <RequestCard key={r.id} r={r} today={today} onSentBack={(x) => setSentBack((p) => [...p, x])} />)}
            {q.data && waiting.length === 0 && sentBack.length === 0 && <div className={styles.hint}>No request is waiting for Finance in this list.</div>}
          </div>
          <div className={styles.foot}>
            <div className={styles.note}><Info size={14} />A voucher made here starts as a draft. It is checked, then approved, before any money moves.</div>
            <div className={styles.note}><CheckCircle2 size={14} />Make voucher opens the voucher in its own tab; saving it takes the request off this list.</div>
            <div className={styles.footButtons}>
              <button type="button" className={styles.btnPrimary} onClick={onClose}>Done</button>
            </div>
          </div>
        </div>
      )}
    </ResizableDetailDrawer>
  );
}
