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
//   • Finance (scm.payment_voucher.create) sees every request, makes the
//     voucher that answers one (PV New, ?fromRequest=, which carries the bill
//     across) or returns it with the why.
// The stage is the server's reading of the voucher, never a field typed here.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  STAGE, awaitsFinance, fetchPaymentRequestFileBlobUrl, useCreatePaymentRequest, useDeletePaymentRequestFile,
  usePaymentRequest, usePaymentRequestFiles, usePaymentRequests, useReturnPaymentRequest, useUpdatePaymentRequest,
  useUploadPaymentRequestFile, useWithdrawPaymentRequest,
  type PaymentRequest, type PaymentRequestInput,
} from '../../vendor/scm/lib/payment-request-queries';
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
    {STAGE[r.stage].label}{r.voucher?.pvNumber ? <span style={{ ...soft, fontWeight: 400 }}> · {r.voucher.pvNumber}</span> : null}
  </span>
);

type StageFilter = 'all' | 'waiting' | 'processing' | 'paid' | 'returned';
const FILTERS: Array<[StageFilter, string]> = [
  ['all', 'All'], ['waiting', 'Waiting for Finance'], ['processing', 'Processing'], ['paid', 'Paid'], ['returned', 'Returned / withdrawn'],
];
const inFilter = (r: PaymentRequest, f: StageFilter): boolean => {
  if (f === 'all') return true;
  if (f === 'waiting') return awaitsFinance(r);
  if (f === 'processing') return r.stage === 'PROCESSING';
  if (f === 'paid') return r.stage === 'PAID' || r.stage === 'BANK_CONFIRMED';
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
  const withdraw = useWithdrawPaymentRequest();
  const sendBack = useReturnPaymentRequest();

  const columns = useMemo<Column<PaymentRequest>[]>(() => [
    { key: 'no', label: 'No.', render: (r) => <button type="button" onClick={() => setOpenId(r.id)} style={{ ...linkBtn, ...mono }}>{r.request_no}</button>, getValue: (r) => r.request_no },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.created_at), getValue: (r) => r.created_at, exportFormat: 'date' },
    ...(finance ? [{ key: 'by', label: 'Requested by', render: (r: PaymentRequest) => r.requested_by_name ?? '—', getValue: (r: PaymentRequest) => r.requested_by_name ?? '' }] : []),
    { key: 'payee', label: 'Pay to', render: (r) => r.payee_name, getValue: (r) => r.payee_name },
    { key: 'event', label: 'Event', width: '240px', render: (r) => <span style={r.project_id == null ? soft : undefined}>{eventCellText(labelsQ.data, r.project_id)}</span>, getValue: (r) => eventCellText(labelsQ.data, r.project_id) },
    { key: 'purpose', label: 'For', width: '220px', render: (r) => r.purpose, getValue: (r) => r.purpose },
    { key: 'amount', label: 'Amount', align: 'right', render: (r) => fmtSen(r.amount_sen), getValue: (r) => r.amount_sen, exportValue: (r) => r.amount_sen / 100, exportFormat: 'money' },
    { key: 'due', label: 'Pay by', render: (r) => fmtDateOrDash(r.due_date), getValue: (r) => r.due_date, exportFormat: 'date' },
    { key: 'stage', label: 'Stage', render: (r) => <StageChip r={r} />, getValue: (r) => STAGE[r.stage].label },
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
              {finance && awaitsFinance(detail) && (
                <Button variant="primary" size="sm" onClick={() => navigate(`/scm/payment-vouchers/new?fromRequest=${encodeURIComponent(detail.id)}`)}>Make voucher</Button>
              )}
              {finance && awaitsFinance(detail) && (
                <Button variant="ghost" size="sm" onClick={() => void onReturn(detail)} disabled={sendBack.isPending}>Return…</Button>
              )}
              {finance && detail.voucher && (
                <Link to={`/scm/payment-vouchers/${detail.voucher.id}`} style={{ fontSize: 'var(--fs-12)', color: 'var(--c-orange)' }}>Open {detail.voucher.pvNumber ?? 'voucher'} →</Link>
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
            <Meta label="Payee's bank" value={[detail.bank_name, detail.bank_account_no, detail.bank_account_name].filter(Boolean).join(' · ') || '—'} />
            <Meta label="Voucher" value={detail.voucher
              ? <>{detail.voucher.pvNumber ?? 'Draft voucher'}{detail.voucher.postedAt ? <span style={soft}> · paid {fmtDateOrDash(detail.voucher.approvedAt ?? detail.voucher.postedAt)}</span> : null}{detail.voucher.bankConfirmed ? <span style={soft}> · bank ✓</span> : null}</>
              : '—'} />
          </div>
          <RequestFilesCard request={detail} canWrite={finance || requesterMayChange(detail)} />
        </Modal>
      )}

      {form && (
        <Modal title={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`} onClose={() => setForm(null)} width="min(760px, 100%)"
          ariaLabel={form.mode === 'new' ? 'New payment request' : `Edit ${form.req.request_no}`}>
          <RequestForm
            initial={form.mode === 'edit' ? form.req : null}
            onDone={(id) => { setForm(null); setOpenId(id); }}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};

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
      lockedNote=" · kept with the voucher Finance made"
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
function RequestForm({ initial, onDone, onCancel }: { initial: PaymentRequest | null; onDone: (id: string) => void; onCancel: () => void }) {
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
  const set = (patch: Partial<PaymentRequestInput>) => setV((prev) => ({ ...prev, ...patch }));
  const ready = v.payeeName.trim() !== '' && v.amountSen > 0 && v.purpose.trim() !== '';
  const saving = create.isPending || update.isPending || upload.isPending;
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

  const save = async () => {
    if (!ready) {
      void notify({ title: 'Not yet complete', body: 'Pay to, the amount and what it is for are needed.', tone: 'error' });
      return;
    }
    try {
      const res = initial
        ? await update.mutateAsync({ id: initial.id, ...v })
        : await create.mutateAsync(v);
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
          <span className={styles.fieldLabel}>Amount (MYR) *</span>
          <MoneyInput bare valueSen={v.amountSen} onCommit={(sen) => set({ amountSen: sen ?? 0 })} inputClassName={styles.fieldInput} selectOnFocus aria-label="Amount" />
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Pay by</span>
          <DateField fullWidth value={v.dueDate ?? ''} onChange={(iso) => set({ dueDate: iso || null })} className={styles.fieldInput} aria-label="Pay by" />
        </label>
      </div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Event</span>
        <EventSelect value={v.projectId} around={v.dueDate || today} optionsPath={EVENTS_PATH} className={styles.fieldInput} aria-label="Event"
          onChange={(id) => set({ projectId: id })} />
      </label>
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
      {!initial && (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>The bill (invoice / quotation — photo or PDF)</span>
          <input type="file" multiple accept={PV_FILE_ACCEPT} aria-label="Bill files" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
          {files.length > 0 && <span style={soft}>{files.length} file(s) attach when the request is sent: {files.map((f) => f.name).join(', ')}</span>}
        </label>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={saving || !ready}>
          {saving ? 'Sending…' : initial ? (initial.status === 'REJECTED' ? 'Send again' : 'Save') : 'Send to Finance'}
        </Button>
      </div>
    </div>
  );
}
