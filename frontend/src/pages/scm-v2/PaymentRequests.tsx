// ----------------------------------------------------------------------------
// PaymentRequests — 申请付款 (owner 2026-09-29/30: Event 的 rental 要还的要相关负责人
// upload，然后我 finance 这里负责做 payment，慢慢接下来全部 payment 都会需要).
//
// One page, two readers:
//   • a requester (scm.payment_request.create) raises a request — who to pay,
//     how much, by when, the event, what for, the payee's bank, the bill — and
//     watches it move: Submitted → Finance processing → Paid (the voucher
//     approved) → Bank confirmed (its bank line matched). A returned request
//     says why; they fix it and send it again.
//   • Finance (scm.payment_voucher.create) sees every request and answers one
//     with a payment voucher (PV New, ?fromRequest=) — money out now — or with
//     an AP invoice (AP Invoices, ?fromRequest=) — the bill booked first, paid
//     later by an AP Payment (owner 2026-09-30, 6.1). Either carries the bill
//     across and reads it on opening (6.2). Or Finance returns it with the why.
//     Finance reads it under Money out in the redesign (batch 4):
//     PaymentRequestsFinance.tsx — tabs, the request's buttons on its row, the
//     request in a drawer. This file keeps the requester's page.
//   • A REFUND request (owner 2026-10-14) is raised by a Sales Order's Refund
//     button — by a salesperson too, who holds no key and reads only their own
//     here (option A: no New request for them). Finance approves it with a
//     Customer Refund on that order (PV New ?type=refund&fromRequest=) or
//     rejects it (the Return, worded as such); it is never edited.
// The stage is the server's reading of that document, never a field typed here.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  STAGE, answerText, awaitsFinance, billMatchText, hasInstalments, isRefundRequest, mayAskBalance,
  stageLabel, usePaymentRequest, usePaymentRequests, useWithdrawPaymentRequest,
  type PaymentRequest,
} from '../../vendor/scm/lib/payment-request-queries';
import { BillInstalments, BillMatchesNote, billFactsLine } from '../../vendor/scm/components/RequestBill';
import { OfficialDocChip } from '../../vendor/scm/components/OfficialDoc';
import { useEventLabels } from '../../vendor/scm/lib/event-queries';
import { eventCellText } from '../../vendor/scm/components/EventSelect';
import { Modal } from '../../vendor/scm/components/Modal';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { EVENTS_PATH, RequestForm } from './PaymentRequestForm';
import {
  BalanceForm, OfficialDocPanel, RequestFilesCard, inFilter, mayEditRequest, mayWithdrawRequest, requesterMayChange,
  type RequestListQuery, type StageFilter,
} from './PaymentRequestParts';
import { PaymentRequestsFinance } from './PaymentRequestsFinance';

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-orange)', textDecoration: 'underline' };
const refundTag: React.CSSProperties = { marginLeft: 6, padding: '1px 6px', borderRadius: 999, border: '1px solid var(--c-orange)', color: 'var(--c-orange)', fontSize: 'var(--fs-11)', fontWeight: 600 };

const StageChip = ({ r }: { r: PaymentRequest }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: STAGE[r.stage].tone, whiteSpace: 'nowrap' }}>
    {stageLabel(r)}{answerText(r) ? <span style={{ ...soft, fontWeight: 400 }}> · {answerText(r)}</span> : null}
  </span>
);

const FILTERS: Array<[StageFilter, string]> = [
  ['all', 'All'], ['waiting', 'Waiting for Finance'], ['processing', 'Processing'], ['paid', 'Paid'], ['returned', 'Returned / withdrawn'],
  ['official', 'Official invoice owed · 欠正式单'],
];

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div style={{ ...soft, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)' }}>{label}</div>
    <div>{value}</div>
  </div>
);

/** One list read, two readers: Finance gets Money out's view, a requester their own page. */
export const PaymentRequests = () => {
  const { can } = useHouzsAuth();
  /* Finance's "only my requests" tick — a requester's list is theirs anyway. */
  const [mineOnly, setMineOnly] = useState(false);
  const listQ = usePaymentRequests(mineOnly);
  /* Who reads it as Finance is the server's call (the voucher-create key);
     until it answers, the same key here, so neither page flashes the other. */
  const finance = listQ.data ? listQ.data.finance : can('scm.payment_voucher.create');
  return finance
    ? <PaymentRequestsFinance listQ={listQ} mineOnly={mineOnly} onMineOnly={setMineOnly} />
    : <RequesterRequests listQ={listQ} />;
};

/** The requester's page — their own requests, as before the redesign. */
function RequesterRequests({ listQ }: { listQ: RequestListQuery }) {
  const { user } = useHouzsAuth();
  const me = Number(user?.id);
  const askConfirm = useConfirm();
  const [searchParams] = useSearchParams();
  /* ?filter=waiting — the Payment Vouchers page's reminder lands here (owner 2026-10-08). */
  const [filter, setFilter] = useState<StageFilter>(() => {
    const asked = searchParams.get('filter');
    return FILTERS.some(([key]) => key === asked) ? (asked as StageFilter) : 'all';
  });
  const rows = useMemo(() => listQ.data?.requests ?? [], [listQ.data]);
  const visible = useMemo(() => rows.filter((r) => inFilter(r, filter)), [rows, filter]);
  const labelsQ = useEventLabels(rows.map((r) => r.project_id), EVENTS_PATH);

  /* ?open=<id> opens one request — a PMS row's request number links here (owner 2026-10-08). */
  const [openId, setOpenId] = useState<string | null>(() => searchParams.get('open'));
  const detailQ = usePaymentRequest(openId);
  const detail = detailQ.data?.request ?? null;
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; req: PaymentRequest } | null>(null);
  /* 申请付余额 (item 2): the request the next instalment is asked from. */
  const [balanceOf, setBalanceOf] = useState<PaymentRequest | null>(null);
  const withdraw = useWithdrawPaymentRequest();

  const columns = useMemo<Column<PaymentRequest>[]>(() => [
    { key: 'no', label: 'No.', render: (r) => (
      <span style={{ whiteSpace: 'nowrap' }}>
        <button type="button" onClick={() => setOpenId(r.id)} style={{ ...linkBtn, ...num }}>{r.request_no}</button>
        {/* An instalment of a bill (item 2): which one. */}
        {(r.installment_no ?? 1) > 1 && <span style={{ ...soft, marginLeft: 6 }}>#{r.installment_no} · balance</span>}
        {/* A refund raised from a Sales Order (owner 2026-10-14). */}
        {isRefundRequest(r) && <span style={refundTag}>Refund · {r.refund_source_doc_no}</span>}
        {/* 同一张单: the same bill number and date on another live document. */}
        {(r.billMatches?.length ?? 0) > 0 && (
          <span title={`Same bill: ${(r.billMatches ?? []).map(billMatchText).join(' | ')}`} aria-label="Same bill elsewhere"
            style={{ marginLeft: 6, color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontWeight: 700 }}>⚠ same bill</span>
        )}
      </span>
    ), getValue: (r) => (isRefundRequest(r) ? `${r.request_no} Refund ${r.refund_source_doc_no ?? ''}` : r.request_no) },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
    { key: 'payee', label: 'Pay to', render: (r) => r.payee_name, getValue: (r) => r.payee_name },
    { key: 'event', label: 'Event', width: '240px', render: (r) => <span style={r.project_id == null ? soft : undefined}>{eventCellText(labelsQ.data, r.project_id)}</span>, getValue: (r) => eventCellText(labelsQ.data, r.project_id) },
    { key: 'purpose', label: 'For', width: '220px', render: (r) => r.purpose, getValue: (r) => r.purpose },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmtSen(r.amount_sen), getValue: (r) => r.amount_sen, exportValue: (r) => r.amount_sen / 100, exportFormat: 'money' },
    { key: 'due', label: 'Pay by', render: (r) => fmtDateOrDash(r.due_date), getValue: (r) => r.due_date, exportFormat: 'date' },
    { key: 'stage', label: 'Stage', render: (r) => (
      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
        <StageChip r={r} />
        <OfficialDocChip state={r.officialDoc?.state} note={r.officialDoc?.note} />
      </span>
    ), getValue: (r) => stageLabel(r) },
  ], [labelsQ.data]);

  /* Option A (owner 2026-10-14): a salesperson reads their refund requests here
     without the key — and raises nothing else. An older server says nothing. */
  const mayRaise = listQ.data?.mayRaise ?? true;
  const mine = (r: PaymentRequest) => Number(r.requested_by) === me;

  const onWithdraw = async (r: PaymentRequest) => {
    const ok = await askConfirm({ title: `Withdraw ${r.request_no}?`, body: 'Finance will not pay it. You can raise a new request later.', confirmLabel: 'Withdraw', danger: true });
    if (!ok) return;
    withdraw.mutate(r.id); // a refusal reaches the user through the mutation's own onError
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Payments" title="Payment requests" />
      <section className={styles.card}>
        <div className={styles.cardHeader} style={{ flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}
                style={{ padding: '4px 10px', borderRadius: 999, border: '1px solid var(--line)', background: filter === key ? 'var(--c-orange)' : 'transparent', color: filter === key ? '#fff' : 'inherit', fontSize: 'var(--fs-12)', cursor: 'pointer' }}>
                {label}{key === 'waiting' ? ` (${rows.filter(awaitsFinance).length})` : ''}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {mayRaise && (
            <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'new' })}>
              <Plus size={16} strokeWidth={1.75} /> New request
            </Button>
          )}
        </div>
        <div className={styles.cardBody}>
          <DataTable<PaymentRequest>
            tableId="payment-requests"
            exportName="payment-requests"
            columns={columns}
            rows={listQ.data ? visible : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The requests could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0 ? 'No request in this view — pick another filter.'
              : mayRaise ? 'You have not raised a payment request yet — New request asks Finance to pay a bill.'
                : 'Your refund requests show here — send one with Refund on a Sales Order.'}
            getRowKey={(r) => r.id}
            getRowStyle={(r) => (r.stage === 'WITHDRAWN' ? { opacity: 0.55 } : undefined)}
          />
        </div>
      </section>

      {openId && detail && (
        <Modal
          title={`${detail.request_no} · ${detail.payee_name}`}
          onClose={() => setOpenId(null)}
          width="min(820px, 100%)"
          ariaLabel={`Payment request ${detail.request_no}`}
          actions={(
            <>
              <StageChip r={detail} />
              {mayEditRequest(detail, me) && (
                <Button variant="secondary" size="sm" onClick={() => setForm({ mode: 'edit', req: detail })}>{detail.status === 'REJECTED' ? 'Fix and send again' : 'Edit'}</Button>
              )}
              {mayWithdrawRequest(detail, me) && (
                <Button variant="ghost" size="sm" onClick={() => void onWithdraw(detail)} disabled={withdraw.isPending}>Withdraw</Button>
              )}
              {/* 申请付余额 (item 2): the next instalment of the same bill — no second upload. */}
              {mine(detail) && !isRefundRequest(detail) && mayAskBalance(detail) && (
                <Button variant="secondary" size="sm" onClick={() => setBalanceOf(detail)}>Request the balance · 申请付余额</Button>
              )}
            </>
          )}
        >
          {detail.stage === 'RETURNED' && detail.finance_note && (
            <div style={{ padding: 'var(--space-3)', borderRadius: 8, background: 'var(--c-cream, #faf8f3)', color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontSize: 'var(--fs-13)' }}>
              {isRefundRequest(detail) ? 'Rejected' : 'Returned'} by {detail.decided_by ?? 'Finance'}{detail.decided_at ? ` on ${fmtDateOrDash(detail.decided_at)}` : ''}: {detail.finance_note}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Requested by" value={`${detail.requested_by_name ?? '—'} · ${fmtDateOrDash(detail.created_at)}`} />
            {isRefundRequest(detail) && (
              <Meta label="Refund on" value={<Link to={`/scm/sales-orders/${encodeURIComponent(detail.refund_source_doc_no ?? '')}`} style={{ ...num, color: 'var(--c-orange)' }}>{detail.refund_source_doc_no}</Link>} />
            )}
            <Meta label={isRefundRequest(detail) ? 'Refund to' : 'Pay to'} value={detail.payee_name} />
            <Meta label="Amount" value={<b>{fmtSen(detail.amount_sen)}</b>} />
            {!isRefundRequest(detail) && <Meta label="Pay by" value={fmtDateOrDash(detail.due_date)} />}
            {!isRefundRequest(detail) && <Meta label="Event" value={eventCellText(labelsQ.data, detail.project_id)} />}
            <Meta label={isRefundRequest(detail) ? 'Reason' : 'For'} value={detail.purpose} />
            {detail.note && <Meta label="Note · 备注" value={detail.note} />}
            {!isRefundRequest(detail) && (
              <Meta label="The bill" value={detail.bill_no || detail.bill_date || detail.bill_total_sen != null
                ? billFactsLine({ billNo: detail.bill_no, billDate: detail.bill_date, totalSen: detail.bill_total_sen })
                : '— not read'} />
            )}
            {detail.project_id == null && detail.no_event_reason && (
              <Meta label="No event — why" value={detail.no_event_reason} />
            )}
            <Meta label={isRefundRequest(detail) ? "Customer's bank" : "Payee's bank"} value={[detail.bank_name, detail.bank_account_no, detail.bank_account_name].filter(Boolean).join(' · ') || '—'} />
            <Meta label="Answered by" value={detail.voucher
              ? <>{detail.voucher.pvNumber ?? 'Draft voucher'}{detail.voucher.postedAt ? <span style={soft}> · paid {fmtDateOrDash(detail.voucher.approvedAt ?? detail.voucher.postedAt)}</span> : null}{detail.voucher.bankConfirmed ? <span style={soft}> · bank ✓</span> : null}</>
              : detail.invoice
                ? <>{answerText(detail)}{detail.invoice.paidBy.length > 0 ? <span style={soft}> · by {detail.invoice.paidBy.join(', ')}</span> : null}{detail.invoice.bankConfirmed ? <span style={soft}> · bank ✓</span> : null}</>
                : '—'} />
          </div>
          {hasInstalments(detail.family) && <BillInstalments family={detail.family} currentId={detail.id} />}
          {/* 欠正式单 (item 3): the payment owes its official invoice — the requester uploads it here; Finance checks it. */}
          {/* A refund pays the customer back — no supplier's official invoice to owe. */}
          {!isRefundRequest(detail) && detail.officialDoc && (
            <OfficialDocPanel request={detail} finance={false} mayUpload={mine(detail)} />
          )}
          <BillMatchesNote matches={detail.billMatches} />
          {detail.parent_request_id && (
            <div style={soft}>The bill is on {detail.family?.rootNo ?? 'the first request'} — it travels with the payment; nothing to upload again.</div>
          )}
          {/* A refund needs no file (owner 2026-10-14); a requester without the key attaches none. */}
          <RequestFilesCard request={detail} canWrite={requesterMayChange(detail, me) && mayRaise} />
        </Modal>
      )}

      {balanceOf && (
        <Modal title={`Request the balance · 申请付余额 — ${balanceOf.family?.rootNo ?? balanceOf.request_no}`} onClose={() => setBalanceOf(null)} width="min(640px, 100%)"
          ariaLabel="Request the balance">
          <BalanceForm request={balanceOf} onDone={(id) => { setBalanceOf(null); setOpenId(id); }} onCancel={() => setBalanceOf(null)} />
        </Modal>
      )}

      {form && (
        <Modal title={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`} onClose={() => setForm(null)} width="min(760px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`}>
          <RequestForm
            initial={form.mode === 'edit' ? form.req : null}
            hasEvents={listQ.data?.hasEvents ?? true}
            onDone={(id) => { setForm(null); setOpenId(id); }}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
}
