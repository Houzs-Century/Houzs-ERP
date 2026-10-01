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
// The stage is the server's reading of that document, never a field typed here.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  NO_EVENT_REASON_MIN, STAGE, answerText, awaitsFinance, billMatchText, fetchPaymentRequestFileBlobUrl, financeWorking, hasInstalments, mayAskBalance, pctOf, requestPaid, useCreatePaymentRequest, useDeletePaymentRequestFile,
  usePaymentRequest, usePaymentRequestFiles, usePaymentRequests, useRequestBalance, useReturnPaymentRequest, useUpdatePaymentRequest,
  useUploadPaymentRequestFile, useWithdrawPaymentRequest,
  type PaymentRequest, type PaymentRequestInput,
} from '../../vendor/scm/lib/payment-request-queries';
import { billFactsOf, needsEvent, useRequestBillRead } from '../../vendor/scm/lib/request-bill-read';
import { BillInstalments, BillMatchesNote, BillReadNote, billFactsLine } from '../../vendor/scm/components/RequestBill';
import { EventSuggestions } from '../../vendor/scm/components/EventSuggestions';
import { OfficialDocActions, OfficialDocChip } from '../../vendor/scm/components/OfficialDoc';
import { useUploadOfficialDoc } from '../../vendor/scm/lib/official-doc-queries';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { useEventLabels } from '../../vendor/scm/lib/event-queries';
import { EventSelect, eventCellText } from '../../vendor/scm/components/EventSelect';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { Modal } from '../../vendor/scm/components/Modal';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useConfirm, usePrompt } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { DataTable, type Column } from '../../components/DataTable';
import { PageHeader } from '../../components/Layout';
import { fmtDateOrDash, fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

const EVENTS_PATH = '/payment-requests/event-options' as const;
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const linkBtn: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--c-orange)', textDecoration: 'underline' };

const StageChip = ({ r }: { r: PaymentRequest }) => (
  <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600, color: STAGE[r.stage].tone, whiteSpace: 'nowrap' }}>
    {STAGE[r.stage].label}{answerText(r) ? <span style={{ ...soft, fontWeight: 400 }}> · {answerText(r)}</span> : null}
  </span>
);

type StageFilter = 'all' | 'waiting' | 'processing' | 'paid' | 'returned' | 'official';
const FILTERS: Array<[StageFilter, string]> = [
  ['all', 'All'], ['waiting', 'Waiting for Finance'], ['processing', 'Processing'], ['paid', 'Paid'], ['returned', 'Returned / withdrawn'],
  ['official', 'Official invoice owed · 欠正式单'],
];
/** 欠正式单 (item 3): the payment answering it owes its official invoice, or has it waiting to be checked. */
const owesOfficial = (r: PaymentRequest): boolean => r.officialDoc?.state === 'OWED' || r.officialDoc?.state === 'RECEIVED';
const inFilter = (r: PaymentRequest, f: StageFilter): boolean => {
  if (f === 'all') return true;
  if (f === 'waiting') return awaitsFinance(r);
  if (f === 'processing') return financeWorking(r);
  if (f === 'paid') return requestPaid(r);
  if (f === 'official') return owesOfficial(r);
  return r.stage === 'RETURNED' || r.stage === 'WITHDRAWN';
};

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div style={{ ...soft, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: 'var(--fs-11)' }}>{label}</div>
    <div>{value}</div>
  </div>
);

export const PaymentRequests = () => {
  const { user } = useHouzsAuth();
  const me = Number(user?.id);
  const navigate = useNavigate();
  const askConfirm = useConfirm();
  const askPrompt = usePrompt();
  const [mineOnly, setMineOnly] = useState(false);
  const listQ = usePaymentRequests(mineOnly);
  const finance = listQ.data?.finance ?? false;
  const [filter, setFilter] = useState<StageFilter>('all');
  const rows = useMemo(() => listQ.data?.requests ?? [], [listQ.data]);
  const visible = useMemo(() => rows.filter((r) => inFilter(r, filter)), [rows, filter]);
  const labelsQ = useEventLabels(rows.map((r) => r.project_id), EVENTS_PATH);

  const [openId, setOpenId] = useState<string | null>(null);
  const detailQ = usePaymentRequest(openId);
  const detail = detailQ.data?.request ?? null;
  const [form, setForm] = useState<{ mode: 'new' } | { mode: 'edit'; req: PaymentRequest } | null>(null);
  /* 申请付余额 (item 2): the request the next instalment is asked from. */
  const [balanceOf, setBalanceOf] = useState<PaymentRequest | null>(null);
  const withdraw = useWithdrawPaymentRequest();
  const sendBack = useReturnPaymentRequest();

  const columns = useMemo<Column<PaymentRequest>[]>(() => [
    { key: 'no', label: 'No.', render: (r) => (
      <span style={{ whiteSpace: 'nowrap' }}>
        <button type="button" onClick={() => setOpenId(r.id)} style={{ ...linkBtn, ...mono }}>{r.request_no}</button>
        {/* An instalment of a bill (item 2): which one. */}
        {(r.installment_no ?? 1) > 1 && <span style={{ ...soft, marginLeft: 6 }}>#{r.installment_no} · balance</span>}
        {/* 同一张单: the same bill number and date on another live document. */}
        {(r.billMatches?.length ?? 0) > 0 && (
          <span title={`Same bill: ${(r.billMatches ?? []).map(billMatchText).join(' | ')}`} aria-label="Same bill elsewhere"
            style={{ marginLeft: 6, color: 'var(--c-festive-b, #B8331F)', fontWeight: 700 }}>⚠ same bill</span>
        )}
      </span>
    ), getValue: (r) => r.request_no },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
    ...(finance ? [{ key: 'by', label: 'Requested by', render: (r: PaymentRequest) => r.requested_by_name ?? '—', getValue: (r: PaymentRequest) => r.requested_by_name ?? '' }] : []),
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
    ), getValue: (r) => STAGE[r.stage].label },
  ], [finance, labelsQ.data]);

  const mine = (r: PaymentRequest) => Number(r.requested_by) === me;
  const requesterMayChange = (r: PaymentRequest) => mine(r) && (r.status === 'SUBMITTED' || r.status === 'REJECTED');

  const onWithdraw = async (r: PaymentRequest) => {
    const ok = await askConfirm({ title: `Withdraw ${r.request_no}?`, body: 'Finance will not pay it. You can raise a new request later.', confirmLabel: 'Withdraw', danger: true });
    if (!ok) return;
    withdraw.mutate(r.id); // a refusal reaches the user through the mutation's own onError
  };
  const onReturn = async (r: PaymentRequest) => {
    const note = await askPrompt({
      title: `Return ${r.request_no} to ${r.requested_by_name ?? 'the requester'}?`,
      body: 'They read your note, fix the request and send it again.',
      confirmLabel: 'Send back',
      input: { label: 'Why it goes back', placeholder: 'e.g. Attach the organiser invoice, not the quotation', required: true },
    });
    if (!note) return;
    sendBack.mutate({ id: r.id, note }); // a refusal reaches the user through the mutation's own onError
  };

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="Payments" title="Payment Requests · 申请付款" />
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
          {finance && (
            <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} aria-label="Only my requests" />
              only my requests
            </label>
          )}
          <span style={{ flex: 1 }} />
          <Button variant="primary" size="sm" onClick={() => setForm({ mode: 'new' })}>
            <Plus size={16} strokeWidth={1.75} /> New request
          </Button>
        </div>
        <div className={styles.cardBody}>
          <DataTable<PaymentRequest>
            tableId="payment-requests"
            exportName="payment-requests"
            columns={columns}
            rows={listQ.data ? visible : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The requests could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0 ? 'No request in this view — pick another filter.' : (finance ? 'No payment request has been raised yet.' : 'You have not raised a payment request yet — New request asks Finance to pay a bill.')}
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
              {requesterMayChange(detail) && (
                <Button variant="secondary" size="sm" onClick={() => setForm({ mode: 'edit', req: detail })}>{detail.status === 'REJECTED' ? 'Fix and send again' : 'Edit'}</Button>
              )}
              {requesterMayChange(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onWithdraw(detail)} disabled={withdraw.isPending}>Withdraw</Button>
              )}
              {/* Two answers (owner 2026-09-30, 6.1): pay now with a voucher, or
                  book the supplier's bill first as an AP invoice and pay it later. */}
              {finance && awaitsFinance(detail) && (
                <Button variant="primary" size="sm" title="Pay now — a payment voucher, the bill attached"
                  onClick={() => navigate(`/scm/payment-vouchers/new?fromRequest=${encodeURIComponent(detail.id)}`)}>Make voucher</Button>
              )}
              {finance && awaitsFinance(detail) && (
                <Button variant="secondary" size="sm" title="Book the supplier's bill first — an AP invoice, paid later by an AP Payment"
                  onClick={() => navigate(`/scm/ap-invoices?fromRequest=${encodeURIComponent(detail.id)}`)}>Make AP invoice</Button>
              )}
              {/* A balance of a bill Finance booked as an AP invoice (item 2) is
                  paid ON that invoice — an AP Payment ticking this instalment. */}
              {finance && awaitsFinance(detail) && apBalanceOn(detail) && (
                <Button variant="secondary" size="sm" title="Pay this instalment on the bill's AP invoice"
                  onClick={() => navigate(`/scm/payment-vouchers/new?${new URLSearchParams({ type: 'ap', supplier: detail.familyInvoice?.supplierId ?? '', pi: detail.familyInvoice?.id ?? '', amount: String(detail.amount_sen), fromRequest: detail.id }).toString()}`)}>
                  Pay on {detail.familyInvoice?.invoiceNumber ?? 'the AP invoice'}
                </Button>
              )}
              {finance && awaitsFinance(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onReturn(detail)} disabled={sendBack.isPending}>Return…</Button>
              )}
              {/* 申请付余额 (item 2): the next instalment of the same bill — no second upload. */}
              {(finance || mine(detail)) && mayAskBalance(detail) && (
                <Button variant="secondary" size="sm" onClick={() => setBalanceOf(detail)}>Request the balance · 申请付余额</Button>
              )}
              {finance && detail.voucher && (
                <Link to={`/scm/payment-vouchers/${detail.voucher.id}`} style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>Open {detail.voucher.pvNumber ?? 'voucher'} →</Link>
              )}
              {finance && detail.invoice && (
                <Link to={`/scm/ap-invoices?open=${encodeURIComponent(detail.invoice.id)}`} style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>Open {detail.invoice.invoiceNumber ?? 'AP invoice'} →</Link>
              )}
            </>
          )}
        >
          {detail.stage === 'RETURNED' && detail.finance_note && (
            <div style={{ padding: 'var(--space-3)', borderRadius: 8, background: 'var(--c-cream, #faf8f3)', color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>
              Returned by {detail.decided_by ?? 'Finance'}{detail.decided_at ? ` on ${fmtDateOrDash(detail.decided_at)}` : ''}: {detail.finance_note}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Requested by" value={`${detail.requested_by_name ?? '—'} · ${fmtDateOrDash(detail.created_at)}`} />
            <Meta label="Pay to" value={detail.payee_name} />
            <Meta label="Amount" value={<b>{fmtSen(detail.amount_sen)}</b>} />
            <Meta label="Pay by" value={fmtDateOrDash(detail.due_date)} />
            <Meta label="Event" value={eventCellText(labelsQ.data, detail.project_id)} />
            <Meta label="For" value={detail.purpose} />
            <Meta label="The bill" value={detail.bill_no || detail.bill_date || detail.bill_total_sen != null
              ? billFactsLine({ billNo: detail.bill_no, billDate: detail.bill_date, totalSen: detail.bill_total_sen })
              : '— not read'} />
            {detail.project_id == null && detail.no_event_reason && (
              <Meta label="No event — why" value={detail.no_event_reason} />
            )}
            <Meta label="Payee's bank" value={[detail.bank_name, detail.bank_account_no, detail.bank_account_name].filter(Boolean).join(' · ') || '—'} />
            <Meta label="Answered by" value={detail.voucher
              ? <>{detail.voucher.pvNumber ?? 'Draft voucher'}{detail.voucher.postedAt ? <span style={soft}> · paid {fmtDateOrDash(detail.voucher.approvedAt ?? detail.voucher.postedAt)}</span> : null}{detail.voucher.bankConfirmed ? <span style={soft}> · bank ✓</span> : null}</>
              : detail.invoice
                ? <>{answerText(detail)}{detail.invoice.paidBy.length > 0 ? <span style={soft}> · by {detail.invoice.paidBy.join(', ')}</span> : null}{detail.invoice.bankConfirmed ? <span style={soft}> · bank ✓</span> : null}</>
                : '—'} />
          </div>
          {hasInstalments(detail.family) && <BillInstalments family={detail.family} currentId={detail.id} />}
          {/* 欠正式单 (item 3): the payment owes its official invoice — the requester uploads it here; Finance checks it. */}
          {(detail.officialDoc || (finance && (detail.voucher || detail.invoice))) && (
            <OfficialDocPanel request={detail} finance={finance} mayUpload={finance || mine(detail)} />
          )}
          <BillMatchesNote matches={detail.billMatches} />
          {detail.parent_request_id && (
            <div style={soft}>The bill is on {detail.family?.rootNo ?? 'the first request'} — it travels with the payment; nothing to upload again.</div>
          )}
          <RequestFilesCard request={detail} canWrite={finance || requesterMayChange(detail)} />
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
};

/** A balance of a bill Finance booked as an AP invoice — paid ON that invoice (item 2). */
const apBalanceOn = (r: PaymentRequest): boolean =>
  !!r.parent_request_id && !!r.familyInvoice?.supplierId
  && (r.familyInvoice.status === 'POSTED' || r.familyInvoice.status === 'PARTIALLY_PAID');

/* ── 申请付余额 — the next instalment of the same bill (item 2) ─────────────────
   No second upload: the bill is on the first request and travels with every
   instalment's payment. The amount starts at what is left to ask; more is the
   requester's call, said out loud. The official invoice may be attached here. */
function BalanceForm({ request, onDone, onCancel }: { request: PaymentRequest; onDone: (id: string) => void; onCancel: () => void }) {
  const notify = useNotify();
  const balance = useRequestBalance();
  const upload = useUploadPaymentRequestFile();
  const fam = request.family;
  const total = fam?.totalSen ?? null;
  const left = fam?.remainingSen ?? null;
  const [amount, setAmount] = useState<number>(left ?? 0);
  const [pct, setPct] = useState('');
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [purpose, setPurpose] = useState(`Balance — ${request.purpose.replace(/^Balance — /, '')}`);
  const [files, setFiles] = useState<File[]>([]);
  const busy = balance.isPending || upload.isPending;
  const pctValue = (() => { const n = Number(pct); return pct.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; })();
  const over = left != null && amount > left;

  const save = async () => {
    if (amount <= 0) { void notify({ title: 'Not yet complete', body: 'Say how much this instalment is.', tone: 'error' }); return; }
    try {
      const res = await balance.mutateAsync({
        id: request.id, amountSen: amount, dueDate, purpose: purpose.trim() || null,
        payPct: pctValue != null && total != null && pctOf(total, pctValue) === amount ? pctValue : null,
      });
      for (const f of files) {
        const payload: PvFilePayload = { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) };
        try { await upload.mutateAsync({ id: res.request.id, file: payload }); } catch (e) {
          void notify({ title: `${f.name} did not attach`, body: e instanceof Error ? e.message : 'Attach it from the request.', tone: 'error' });
        }
      }
      onDone(res.request.id);
    } catch { /* the mutation's own onError told the user */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {fam && hasInstalments(fam) && <BillInstalments family={fam} currentId={request.id} />}
      <div style={soft}>
        {left != null ? `Left to ask on this bill: ${fmtSen(left)}${total != null ? ` of ${fmtSen(total)}` : ''}.` : 'The bill\'s total is not known — type this instalment\'s amount.'}
        {' '}The bill is already on {fam?.rootNo ?? request.request_no} — nothing to upload again.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Amount (MYR) *</span>
          <MoneyInput bare valueSen={amount} onCommit={(sen) => { setAmount(sen ?? 0); setPct(''); }} inputClassName={styles.fieldInput} selectOnFocus aria-label="Balance amount" />
        </label>
        {total != null && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>…or a percent of the bill</span>
            <input className={styles.fieldInput} inputMode="decimal" value={pct} aria-label="Balance percent" placeholder="e.g. 50"
              onChange={(e) => { setPct(e.target.value); const n = Number(e.target.value); if (Number.isFinite(n) && n > 0 && n <= 100) setAmount(pctOf(total, n)); }} />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pay by</span>
          <DateField fullWidth value={dueDate ?? ''} onChange={(iso) => setDueDate(iso || null)} className={styles.fieldInput} aria-label="Balance pay by" />
        </label>
      </div>
      {over && (
        <div role="alert" style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-12)' }}>
          More than is left to ask on the bill ({fmtSen(left)}) — it still goes, and Finance sees it.
        </div>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>What is it for</span>
        <input className={styles.fieldInput} value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Balance purpose" />
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>The official invoice (optional — when the first was a proforma)</span>
        <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Official invoice files" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
      </label>
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Sending…' : 'Send to Finance'}</Button>
      </div>
    </div>
  );
}

/* ── 欠正式单 — the official invoice after a proforma was paid (item 3) ─────────
   Finance marked the payment as owing it; the requester (or Finance) uploads it
   here, it travels to the payment and waits for Finance's check. */
function OfficialDocPanel({ request, finance, mayUpload }: { request: PaymentRequest; finance: boolean; mayUpload: boolean }) {
  const notify = useNotify();
  const upload = useUploadOfficialDoc();
  const state = request.officialDoc?.state ?? null;
  const doc = request.voucher ? { kind: 'PV' as const, id: request.voucher.id } : request.invoice ? { kind: 'API' as const, id: request.invoice.id } : null;
  const pick = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      try {
        const res = await upload.mutateAsync({ requestId: request.id, file: { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) } });
        void notify({
          title: 'Official invoice uploaded',
          body: res.note ?? (res.received.length > 0 ? `Finance checks it on ${res.received.map((d) => d.number ?? d.kind).join(', ')}.` : 'It is kept with the request and its payment.'),
          tone: res.note ? 'error' : 'info',
        });
      } catch { /* the mutation's own onError told the user */ }
    }
  };
  return (
    <div role="group" aria-label="Official invoice" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 'var(--space-3)', borderRadius: 8, border: '1px dashed var(--line)' }}>
      {finance && doc
        ? <OfficialDocActions kind={doc.kind} id={doc.id} state={state} note={request.officialDoc?.note} />
        : <OfficialDocChip state={state} note={request.officialDoc?.note} />}
      {state === 'OWED' && !finance && <span style={soft}>Paid on a proforma or quotation — upload the official invoice when you have it.</span>}
      {mayUpload && (state === 'OWED' || state === 'RECEIVED') && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-12)', flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>Upload the official invoice · 补正式单</span>
          <input type="file" accept={PV_FILE_ACCEPT} aria-label="Upload the official invoice" disabled={upload.isPending}
            onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
        </label>
      )}
    </div>
  );
}

/* ── The bill — the requester's own until Finance answers ─────────────────── */
function RequestFilesCard({ request, canWrite }: { request: PaymentRequest; canWrite: boolean }) {
  const filesQ = usePaymentRequestFiles(request.id);
  const upload = useUploadPaymentRequestFile();
  const remove = useDeletePaymentRequestFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWrite}
      locked={request.status === 'VOUCHERED'}
      closed={request.status === 'WITHDRAWN'}
      lockedNote=" · kept with the voucher or AP invoice Finance made"
      emptyNote="No bill attached yet — attach the invoice or quotation Finance should pay."
      removeBody="The file leaves this request."
      attachAriaLabel="Attach the bill"
      uploading={upload.isPending}
      removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ id: request.id, file })}
      onRemove={(fileId) => remove.mutateAsync({ id: request.id, fileId })}
      openUrl={(fileId) => fetchPaymentRequestFileBlobUrl(request.id, fileId)}
    />
  );
}

/* ── New / edit ─────────────────────────────────────────────────────────── */
function RequestForm({ initial, hasEvents, onDone, onCancel }: { initial: PaymentRequest | null; hasEvents: boolean; onDone: (id: string) => void; onCancel: () => void }) {
  const notify = useNotify();
  const create = useCreatePaymentRequest();
  const update = useUpdatePaymentRequest();
  const upload = useUploadPaymentRequestFile();
  const [v, setV] = useState<PaymentRequestInput>(() => ({
    payeeName: initial?.payee_name ?? '',
    amountSen: initial?.amount_sen ?? 0,
    dueDate: initial?.due_date ?? null,
    purpose: initial?.purpose ?? '',
    projectId: initial?.project_id ?? null,
    bankName: initial?.bank_name ?? null,
    bankAccountNo: initial?.bank_account_no ?? null,
    bankAccountName: initial?.bank_account_name ?? null,
  }));
  const [files, setFiles] = useState<File[]>([]);
  /* The bill is READ as it is attached (owner 2026-10-01, item 1): its number,
     date and total, whether it is for an event, the same bill elsewhere. */
  const billRead = useRequestBillRead();
  const [noEvent, setNoEvent] = useState(() => !!initial?.no_event_reason);
  const [noEventReason, setNoEventReason] = useState(initial?.no_event_reason ?? '');
  const set = (patch: Partial<PaymentRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  /* A bill paid in instalments (item 2): its total — read off it, or typed —
     and this payment as an amount OR a percent of it. A balance's total is its
     first request's, not edited here. */
  const isBalance = !!initial?.parent_request_id;
  const [billTotal, setBillTotal] = useState<number | null>(initial?.bill_total_sen ?? null);
  const [pct, setPct] = useState<string>(initial?.pay_pct != null ? String(initial.pay_pct) : '');
  const pctValue = (() => { const n = Number(pct); return pct.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; })();
  const applyPct = (raw: string, total: number | null) => {
    setPct(raw);
    const n = Number(raw);
    if (total != null && total > 0 && raw.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100) set({ amountSen: pctOf(total, n) });
  };
  const pickFiles = async (list: File[]) => {
    setFiles(list);
    const read = await billRead.run(list);
    const readTotal = read?.bill.totalSen ?? null;
    if (readTotal != null && readTotal > 0) setBillTotal((prev) => prev ?? readTotal);
    /* The event the bill points at most strongly is picked for them — they confirm or change it. */
    const top = read?.eventBill ? read.eventSuggestions[0] : undefined;
    if (top) setV((prev) => (prev.projectId == null ? { ...prev, projectId: top.id } : prev));
  };
  /* An event bill goes with its Event — or the reason there is none (找不到这场活动). */
  const eventNeeded = hasEvents && (needsEvent(billRead.state) || !!initial?.event_bill);
  const eventOk = !eventNeeded || v.projectId != null || (noEvent && noEventReason.trim().length >= NO_EVENT_REASON_MIN);
  const reading = billRead.state.status === 'reading';
  const missing = [
    v.payeeName.trim() === '' ? 'who to pay' : null,
    v.amountSen > 0 ? null : 'the amount',
    v.purpose.trim() === '' ? 'what it is for' : null,
    !initial && files.length === 0 ? 'the bill' : null,
    eventOk ? null : 'the event (or why there is none)',
  ].filter(Boolean) as string[];
  const ready = missing.length === 0 && !reading;
  const saving = create.isPending || update.isPending || upload.isPending;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  const save = async () => {
    if (!ready) {
      void notify({ title: 'Not yet complete', body: reading ? 'The bill is still being read — a moment.' : `Still needed: ${missing.join(', ')}.`, tone: 'error' });
      return;
    }
    const body: PaymentRequestInput = {
      ...v,
      ...billFactsOf(billRead.state),
      noEventReason: v.projectId == null && noEvent ? noEventReason.trim() : null,
      /* The total as it stands on the form (read, or typed over), and the percent
         only while the amount is still what it makes. */
      ...(isBalance ? {} : { billTotalSen: billTotal }),
      payPct: pctValue != null && billTotal != null && pctOf(billTotal, pctValue) === v.amountSen ? pctValue : null,
    };
    try {
      const res = initial
        ? await update.mutateAsync({ id: initial.id, ...body })
        : await create.mutateAsync(body);
      const id = res.request.id;
      for (const f of files) {
        const payload: PvFilePayload = { name: f.name, mime: f.type || 'application/pdf', dataBase64: await fileToBase64(f) };
        try { await upload.mutateAsync({ id, file: payload }); } catch (e) {
          void notify({ title: `${f.name} did not attach`, body: e instanceof Error ? e.message : 'Attach it from the request.', tone: 'error' });
        }
      }
      onDone(id);
    } catch { /* the mutation's own onError told the user */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
      {initial?.status === 'REJECTED' && initial.finance_note && (
        <div style={{ color: 'var(--c-festive-b, #B8331F)', fontSize: 'var(--fs-13)' }}>Finance returned it: {initial.finance_note}</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pay to *</span>
          <input className={styles.fieldInput} value={v.payeeName} onChange={(e) => set({ payeeName: e.target.value })} aria-label="Pay to" placeholder="e.g. MLE EVENTS SDN BHD" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Amount to pay now (MYR) *</span>
          <MoneyInput bare valueSen={v.amountSen} onCommit={(sen) => set({ amountSen: sen ?? 0 })} inputClassName={styles.fieldInput} selectOnFocus aria-label="Amount" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pay by</span>
          <DateField fullWidth value={v.dueDate ?? ''} onChange={(iso) => set({ dueDate: iso || null })} className={styles.fieldInput} aria-label="Pay by" />
        </label>
      </div>
      {/* 一张单付两次 (item 2): the bill's total, and this payment as a percent of it. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
        {!isBalance && (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>The bill's total (MYR)</span>
            <MoneyInput bare valueSen={billTotal ?? 0} inputClassName={styles.fieldInput} selectOnFocus aria-label="Bill total"
              onCommit={(sen) => { const t = sen != null && sen > 0 ? sen : null; setBillTotal(t); if (pct) applyPct(pct, t); }} />
          </label>
        )}
        <label className={styles.field}>
          <span className={styles.fieldLabel}>…or a percent of it</span>
          <input className={styles.fieldInput} inputMode="decimal" value={pct} aria-label="Percent of the bill" placeholder={billTotal ? 'e.g. 50' : 'Type the bill total first'}
            disabled={!billTotal} onChange={(e) => applyPct(e.target.value, billTotal)} />
        </label>
      </div>
      {!initial && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>The bill * (invoice / quotation / proforma — photo or PDF; several files = one bill's pages)</span>
          <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Bill files" onChange={(e) => void pickFiles([...(e.target.files ?? [])])} />
          {files.length > 0 && <span style={soft}>{files.length} file(s) attach when the request is sent: {files.map((f) => f.name).join(', ')}</span>}
        </label>
      )}
      <BillReadNote state={billRead.state} />
      {hasEvents && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{eventNeeded ? 'Event * — this bill is for an event' : 'Event'}</span>
          <EventSelect value={v.projectId} around={v.dueDate || today} optionsPath={EVENTS_PATH} className={styles.fieldInput} aria-label="Event"
            onChange={(id) => set({ projectId: id })} />
        </label>
      )}
      {eventNeeded && billRead.state.status === 'done' && (
        <EventSuggestions suggestions={billRead.state.result.eventSuggestions} current={v.projectId} onUse={(id) => set({ projectId: id })} />
      )}
      {eventNeeded && v.projectId == null && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ ...soft, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={noEvent} onChange={(e) => setNoEvent(e.target.checked)} aria-label="I cannot find this event" />
            I cannot find this event · 找不到这场活动
          </label>
          {noEvent && (
            <input className={styles.fieldInput} value={noEventReason} onChange={(e) => setNoEventReason(e.target.value)} aria-label="Why there is no event"
              placeholder="Say why in a line — Finance reads it (e.g. the fair is not in PMS yet)" />
          )}
        </div>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>What is it for *</span>
        <textarea className={styles.fieldInput} rows={2} value={v.purpose} onChange={(e) => set({ purpose: e.target.value })} aria-label="What is it for"
          placeholder="e.g. Booth F1 rental, balance 50%" />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3)' }}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Payee's bank</span>
          <input className={styles.fieldInput} value={v.bankName ?? ''} onChange={(e) => set({ bankName: e.target.value || null })} aria-label="Payee's bank" placeholder="e.g. Maybank" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Account no.</span>
          <input className={styles.fieldInput} value={v.bankAccountNo ?? ''} onChange={(e) => set({ bankAccountNo: e.target.value || null })} aria-label="Account no." />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Account name</span>
          <input className={styles.fieldInput} value={v.bankAccountName ?? ''} onChange={(e) => set({ bankAccountName: e.target.value || null })} aria-label="Account name" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {/* Pressable while incomplete: the press says what is still missing. */}
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || reading}>
          {saving ? 'Sending…' : initial ? (initial.status === 'REJECTED' ? 'Send again' : 'Save') : 'Send to Finance'}
        </Button>
      </div>
    </div>
  );
}
