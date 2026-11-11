// ----------------------------------------------------------------------------
// PaymentRequestParts — what both readers of Payment requests share: the
// requester's own page and Finance's view under Money out (the redesign, batch
// 4). Which list a request sits in, who may still change it, the balance of a
// bill paid in instalments, its official invoice and its files. One home each,
// so the two views can never disagree about a request.
// ----------------------------------------------------------------------------

import { useState } from 'react';
import { Button } from '@2990s/design-system';
import {
  awaitsFinance, fetchPaymentRequestFileBlobUrl, financeWorking, hasInstalments, isRefundRequest, pctOf, requestPaid, requestReturned,
  useDeletePaymentRequestFile, usePaymentRequestFiles, useRequestBalance, useUploadPaymentRequestFile,
  type PaymentRequest, type usePaymentRequests,
} from '../../vendor/scm/lib/payment-request-queries';
import { BillInstalments } from '../../vendor/scm/components/RequestBill';
import { OfficialDocActions, OfficialDocChip } from '../../vendor/scm/components/OfficialDoc';
import { useUploadOfficialDoc } from '../../vendor/scm/lib/official-doc-queries';
import { fileToBase64, PV_FILE_ACCEPT, type PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { docFileMime } from '../../vendor/scm/lib/doc-file-mime';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { MoneyInput } from '../../vendor/scm/components/MoneyInput';
import { DateField } from '../../vendor/scm/components/DateField';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';

const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };

/** The list read once by the page and handed to whichever view its reader gets. */
export type RequestListQuery = ReturnType<typeof usePaymentRequests>;

/** The lists a request can be read in — the requester's filters, and what
    Finance's tabs are made of. */
export type StageFilter = 'all' | 'waiting' | 'processing' | 'paid' | 'returned' | 'official';

/** 欠正式单 (item 3): the payment answering it owes its official invoice, or has it waiting to be checked. */
export const owesOfficial = (r: PaymentRequest): boolean => r.officialDoc?.state === 'OWED' || r.officialDoc?.state === 'RECEIVED';

export const inFilter = (r: PaymentRequest, f: StageFilter): boolean => {
  if (f === 'all') return true;
  if (f === 'waiting') return awaitsFinance(r);
  if (f === 'processing') return financeWorking(r);
  if (f === 'paid') return requestPaid(r);
  if (f === 'official') return owesOfficial(r);
  return requestReturned(r);
};

/** The requester may still change their own request while it waits, or after it came back. */
export const requesterMayChange = (r: PaymentRequest, me: number): boolean =>
  Number(r.requested_by) === me && (r.status === 'SUBMITTED' || r.status === 'REJECTED');
/** A refund request is never edited; it is withdrawn while it waits. */
export const mayEditRequest = (r: PaymentRequest, me: number): boolean => requesterMayChange(r, me) && !isRefundRequest(r);
export const mayWithdrawRequest = (r: PaymentRequest, me: number): boolean =>
  requesterMayChange(r, me) && (!isRefundRequest(r) || r.status === 'SUBMITTED');

/** A balance of a bill Finance booked as an AP invoice — paid ON that invoice (item 2). */
export const apBalanceOn = (r: PaymentRequest): boolean =>
  !!r.parent_request_id && !!r.familyInvoice?.supplierId
  && (r.familyInvoice.status === 'POSTED' || r.familyInvoice.status === 'PARTIALLY_PAID');

/** Where Finance pays an instalment on the bill's AP invoice: an AP Payment ticking it. */
export const payOnInvoiceHref = (r: PaymentRequest): string =>
  `/scm/payment-vouchers/new?${new URLSearchParams({ type: 'ap', supplier: r.familyInvoice?.supplierId ?? '', pi: r.familyInvoice?.id ?? '', amount: String(r.amount_sen), fromRequest: r.id }).toString()}`;

/* ── 申请付余额 — the next instalment of the same bill (item 2) ─────────────────
   No second upload: the bill is on the first request and travels with every
   instalment's payment. The amount starts at what is left to ask; more is the
   requester's call, said out loud. The official invoice may be attached here. */
export function BalanceForm({ request, onDone, onCancel }: { request: PaymentRequest; onDone: (id: string) => void; onCancel: () => void }) {
  const notify = useNotify();
  const balance = useRequestBalance();
  /* The official invoice attached here is uploaded AS the official invoice (owner
     2026-10-01, 漏洞 3): it moves every owed payment of this bill to 待核对. */
  const official = useUploadOfficialDoc();
  const fam = request.family;
  const total = fam?.totalSen ?? null;
  const left = fam?.remainingSen ?? null;
  const [amount, setAmount] = useState<number>(left ?? 0);
  const [pct, setPct] = useState('');
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [purpose, setPurpose] = useState(`Balance — ${request.purpose.replace(/^Balance — /, '')}`);
  const [files, setFiles] = useState<File[]>([]);
  const busy = balance.isPending || official.isPending;
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
        const payload: PvFilePayload = { name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) };
        try { await official.mutateAsync({ requestId: res.request.id, file: payload }); } catch (e) {
          void notify({ title: `${f.name} did not attach`, body: e instanceof Error ? e.message : 'Upload it from the request — 补正式单.', tone: 'error' });
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
        <div role="alert" style={{ color: 'var(--c-festive-b, var(--hz-dk-festive-b, #B8331F))', fontSize: 'var(--fs-12)' }}>
          More than is left to ask on the bill ({fmtSen(left)}) — it still goes, and Finance sees it.
        </div>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>What is it for</span>
        <input data-upper className={styles.fieldInput} value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="Balance purpose" />
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
export function OfficialDocPanel({ request, finance, mayUpload }: { request: PaymentRequest; finance: boolean; mayUpload: boolean }) {
  const notify = useNotify();
  const upload = useUploadOfficialDoc();
  const state = request.officialDoc?.state ?? null;
  const doc = request.voucher ? { kind: 'PV' as const, id: request.voucher.id } : request.invoice ? { kind: 'API' as const, id: request.invoice.id } : null;
  const pick = async (list: FileList | null) => {
    for (const f of [...(list ?? [])]) {
      try {
        const res = await upload.mutateAsync({ requestId: request.id, file: { name: f.name, mime: docFileMime(f), dataBase64: await fileToBase64(f) } });
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
          {/* Finance reads English (the redesign); the requester keeps both. */}
          <span style={{ fontWeight: 600 }}>{finance ? 'Upload the official invoice' : 'Upload the official invoice · 补正式单'}</span>
          <input type="file" accept={PV_FILE_ACCEPT} aria-label="Upload the official invoice" disabled={upload.isPending}
            onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
        </label>
      )}
    </div>
  );
}

/* ── The bill — the requester's own until Finance answers ─────────────────── */
export function RequestFilesCard({ request, canWrite }: { request: PaymentRequest; canWrite: boolean }) {
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
      emptyNote={isRefundRequest(request) ? 'No file — a refund request needs none.' : 'No bill attached yet — attach the invoice or quotation Finance should pay.'}
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
