// ----------------------------------------------------------------------------
// ApBillPage — /scm/ap-invoices/:id, an AP bill (or a supplier's debit note) as
// its own document page in the owner's Claude Design (Money out, batch 4
// step 6). Today's pop-out becomes a page: Details, Lines with the books line,
// Payments (what paid it), Attachments and a Trail from its stamps; the action
// bar keeps every action the pop-out had (Edit, Copy, Post, Cancel, Official
// invoice, files) and adds Make voucher and Add task. Posting is unchanged —
// the same calls the list makes. Print (step 8) opens the voucher page's print
// preview: the AP BILL, its stored files after it unless unticked.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { newIdempotencyKey } from '../../lib/idempotency';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Ban, CalendarClock, Copy, ListPlus, Pencil, Printer, Send, Wallet } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { PageHeader } from '../../components/Layout';
import { PrintPreviewModal, useOpenPrintPreviewFromUrl, usePrintPreview } from '../../components/scm-v2/PrintPreviewModal';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { Modal } from '../../vendor/scm/components/Modal';
import { OfficialDocActions } from '../../vendor/scm/components/OfficialDoc';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { eventCellText } from '../../vendor/scm/components/EventSelect';
import { useEventLabels } from '../../vendor/scm/lib/event-queries';
import { useAccounts, postableAccounts } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useApInvoiceDetail, useApInvoiceFiles, useCancelApInvoice, useCreateApInvoice, usePostApInvoice, useUpdateApInvoice,
  type ApInvoiceDetail, type BillPayment,
} from '../../vendor/scm/lib/ap-invoice-queries';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { fmtDateOrDash, fmtDateTime, fmtSen, todayMY } from '../../vendor/shared/format';
import { returnToWorkspaceOpener, useWorkspaceOpener } from '../../lib/useWorkspaceOpener';
import { AccountCell } from './JournalEntryCards';
import { ApInvoiceForm, type ApFormSubmit } from './ApInvoiceForm';
import { ApInvoiceFilesCard, fromDetail } from './ApInvoices';
import { VoucherTaskDrawer } from './PvDocParts';
import { BillPlanDialog } from './BillPlanDialog';
import { billTag, lifeOf, type BillRow, type BillTone } from './supplier-bills';
import { useSupplierBillsPrint } from './useSupplierBillsPrint';
import styles from './SalesOrderDetail.module.css';
import mo from './MoneyOut.module.css';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const TONE: Record<BillTone, string> = { calm: mo.toneCalm, warn: mo.toneWarn, info: mo.toneInfo, late: mo.toneLate };

/** The bill as the list's rules read it — one status tag on both. */
const asRow = (d: ApInvoiceDetail): BillRow => {
  const inv = d.invoice;
  const posted = lifeOf(inv.status) === 'posted';
  return {
    key: `API-${inv.id}`, kind: 'API', debitNote: inv.doc_kind === 'DN', id: inv.id, number: inv.invoice_number,
    supplierId: inv.supplier_id, supplierName: d.supplier?.name ?? null, supplierCode: d.supplier?.code ?? null, controlRole: null,
    ref: inv.supplier_invoice_ref, description: inv.notes, date: inv.invoice_date, due: inv.due_date, planned: posted ? inv.planned_on ?? null : null, currency: inv.currency,
    totalSen: Number(inv.total_sen), paidSen: Number(inv.paid_sen), outstandingSen: posted ? Math.max(0, Number(inv.total_sen) - Number(inv.paid_sen)) : null,
    unusedSen: null, status: inv.status, held: false, holdReason: null,
  };
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--fg-muted)', marginBottom: 2 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const paymentWhat = (p: BillPayment): string =>
  p.kind === 'SCN' ? 'Credit note knocked off' : p.fromAdvance ? 'Advance knocked off' : 'Payment';

export function ApBillPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const cameFrom = useWorkspaceOpener();
  const q = useApInvoiceDetail(id || null);
  const d = q.data;
  const accountsQ = useAccounts();
  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const eventLabelsQ = useEventLabels((d?.lines ?? []).map((l) => l.project_id ?? null));
  const post = usePostApInvoice();
  const cancel = useCancelApInvoice();
  const update = useUpdateApInvoice();
  const create = useCreateApInvoice();
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create') || can('scm.payment_voucher.write');
  const canPost = can('scm.payment_voucher.post');
  const canCancel = can('scm.payment_voucher.cancel');
  const [form, setForm] = useState<'edit' | 'copy' | null>(null);
  /* One Idempotency-Key per opened copy form: a second press answers the first copy. */
  const createKey = useMemo(() => (form ? newIdempotencyKey() : null), [form]);
  const [addingTask, setAddingTask] = useState(false);
  const [planning, setPlanning] = useState(false);

  const accountName = (code: string): string | null => (accountsQ.data?.accounts ?? []).find((a) => a.account_code === code)?.account_name ?? null;
  const lineAccounts = useMemo(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);

  /* Print (step 8): the AP BILL with its stored files after it — or without,
     the operator's call in the preview card, as on the voucher page. Files not
     counted yet: the Worker appends whatever the bill keeps. */
  const filesQ = useApInvoiceFiles(id || null);
  const fileCount = filesQ.data?.files.length ?? null;
  const [includeFiles, setIncludeFiles] = useState(true);
  const prints = useSupplierBillsPrint();
  const deliverPrint = (action: PdfAction) => prints.print(
    [{ kind: 'API', id, number: d?.invoice.invoice_number ?? 'AP bill' }],
    includeFiles && fileCount !== 0,
    action,
  );
  const print = usePrintPreview(deliverPrint);
  useOpenPrintPreviewFromUrl(print.openPreview, !!d);

  if (q.isLoading) return <div className={mo.hint}>Reading the bill…</div>;
  if (q.isError || !d) {
    return (
      <div className="space-y-4">
        <PageHeader back eyebrow="Finance · Money out" title="Bill" />
        <div className={mo.hint} role="alert">The bill did not load — {q.error instanceof Error ? q.error.message : 'it is not in the company you are working in.'}</div>
      </div>
    );
  }

  const inv = d.invoice;
  const row = asRow(d);
  const life = lifeOf(inv.status);
  const dn = inv.doc_kind === 'DN';
  const paper = dn ? 'Supplier debit note' : 'AP bill';
  const tag = billTag(row, todayMY());
  const outstanding = Math.max(0, Number(inv.total_sen) - Number(inv.paid_sen));
  const payments = d.payments ?? [];
  const debits = [...new Set(d.lines.map((l) => l.debit_account_code))].map((c) => (accountName(c) ? `${c} ${accountName(c)}` : c)).join(', ');
  const credit = d.controlCode ? (accountName(d.controlCode) ? `${d.controlCode} ${accountName(d.controlCode)}` : d.controlCode) : 'the supplier’s control';
  const booksState = life === 'posted' ? 'Posted' : life === 'cancelled' ? (inv.je_no ? 'Reversed' : 'Never posted') : 'Posts when posted';
  /* When we plan to pay it, against the supplier's due date (the design: · Nd early / · Nd late). */
  const planned = life === 'posted' && outstanding > 0 ? inv.planned_on ?? null : null;
  const planGap = planned && inv.due_date ? Math.round((Date.parse(planned) - Date.parse(inv.due_date)) / 86_400_000) : 0;

  const onPost = async () => {
    if (!(await askConfirm({
      title: `Post ${inv.invoice_number}?`,
      body: 'Books Dr each line\'s account / Cr the supplier\'s AP control, dated by the invoice. From then on it is paid through an AP Payment.',
      confirmLabel: 'Post',
    }))) return;
    try { await post.mutateAsync(inv.id); } catch (e) {
      void notify({ title: 'Post failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCancel = async () => {
    if (!(await askConfirm({
      title: `Cancel ${inv.invoice_number}?`,
      body: life === 'posted' ? 'The journal is reversed with a contra — the ledger keeps both sides. A bill with a payment on it refuses.' : 'The draft is closed; nothing was ever posted.',
      confirmLabel: dn ? 'Cancel debit note' : 'Cancel bill', cancelLabel: 'Keep it', danger: true,
    }))) return;
    try { await cancel.mutateAsync(inv.id); } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const submitForm = async (values: ApFormSubmit) => {
    try {
      if (form === 'edit') {
        const res = await update.mutateAsync({ id: inv.id, body: values });
        setForm(null);
        void notify({
          title: `${res.invoice.invoice_number} saved`,
          body: res.reposted ? `The bill was re-posted — the old journal got its contra and ${res.jeNo ?? 'a fresh entry'} books it as saved.` : 'The draft is updated.',
          tone: 'info',
        });
        return;
      }
      /* A copy is a new paper — a debit note's copy is a debit note — and opens on its own page. */
      const res = await create.mutateAsync({ ...(dn ? { ...values, docKind: 'DN' as const } : values), idempotencyKey: createKey });
      setForm(null);
      navigate(`/scm/ap-invoices/${res.invoice.id}`);
      void notify({ title: `${res.invoice.invoice_number} raised`, body: `${fmtSen(res.invoice.total_sen)} as a draft, copied from ${inv.invoice_number} — post it to put it on the books.`, tone: 'info' });
    } catch (e) {
      void notify({ title: 'Bill not saved', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const formTitle = form === 'edit' ? `Edit ${inv.invoice_number}` : `New ${dn ? 'supplier debit note' : 'AP bill'} — copied from ${inv.invoice_number}`;

  return (
    <div className="space-y-4">
      <PageHeader back
        beforeBack={() => {
          /* Opened as a document from another page: back to THAT page and its tab. */
          const href = cameFrom ? returnToWorkspaceOpener() : null;
          if (href) { navigate(href); return false; }
          return true;
        }}
        eyebrow={paper}
        title={inv.invoice_number}
        actions={(
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span className={`${mo.tag} ${TONE[tag.tone]}`}>{tag.text}</span>
            {canCreate && life !== 'cancelled' && <Button variant="ghost" size="md" onClick={() => setForm('edit')}><Pencil {...ICON} /> Edit</Button>}
            {canCreate && <Button variant="ghost" size="md" onClick={() => setForm('copy')}><Copy {...ICON} /> Copy</Button>}
            <Button variant="ghost" size="md" onClick={() => setAddingTask(true)}><ListPlus {...ICON} /> Add task</Button>
            <Button variant="ghost" size="md" onClick={print.openPreview}><Printer {...ICON} /> Print</Button>
            {canCreate && life === 'posted' && outstanding > 0 && (
              <Button variant="ghost" size="md" onClick={() => setPlanning(true)}><CalendarClock {...ICON} /> Plan date</Button>
            )}
            {canCancel && life !== 'cancelled' && Number(inv.paid_sen) === 0 && (
              <Button variant="ghost" size="md" onClick={() => void onCancel()} disabled={cancel.isPending}><Ban {...ICON} /> Cancel…</Button>
            )}
            {canPost && life === 'draft' && (
              <Button variant="primary" size="md" onClick={() => void onPost()} disabled={post.isPending}><Send {...ICON} /> {post.isPending ? 'Posting…' : 'Post'}</Button>
            )}
            {canCreate && life === 'posted' && outstanding > 0 && (
              <Button variant="primary" size="md" onClick={() => navigate(`/scm/payment-vouchers/new?type=ap&supplier=${encodeURIComponent(inv.supplier_id)}&pi=${encodeURIComponent(inv.id)}`)}>
                <Wallet {...ICON} /> Make voucher
              </Button>
            )}
          </div>
        )}
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Details</h2></div>
        <div className={styles.cardBody}>
          <div className={styles.formGrid3}>
            <Fact label="Supplier">{d.supplier ? `${d.supplier.code} · ${d.supplier.name}` : '—'}</Fact>
            <Fact label={dn ? 'Supplier’s debit note no.' : 'Supplier’s invoice no.'}>{inv.supplier_invoice_ref ?? '—'}</Fact>
            <Fact label={dn ? 'Date' : 'Invoice date'}>{fmtDateOrDash(inv.invoice_date)}</Fact>
            <Fact label="Due date">{fmtDateOrDash(inv.due_date)}</Fact>
            <Fact label="Planned payment">
              {planned ? <>{fmtDateOrDash(planned)}{planGap !== 0 ? <span className={mo.hint}> · {Math.abs(planGap)}d {planGap < 0 ? 'early' : 'late'}</span> : null}</> : life === 'posted' && outstanding > 0 ? 'By the due date' : '—'}
            </Fact>
            <Fact label="Outstanding"><span className={mo.money}>{life === 'posted' ? fmtSen(outstanding) : '—'}</span></Fact>
            <Fact label="Journal">{inv.je_no ?? (life === 'cancelled' ? 'Never posted' : 'Written when posted')}</Fact>
            <Fact label="Description">{inv.notes ?? '—'}</Fact>
            {/* 欠正式单 asks after an official INVOICE — a debit note is its own paper. */}
            {life !== 'cancelled' && !dn && (
              <Fact label="Official invoice"><OfficialDocActions kind="API" id={inv.id} state={inv.official_doc ?? null} note={inv.official_doc_note ?? null} /></Fact>
            )}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Lines ({d.lines.length})</h2></div>
        <div className={styles.cardBody} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <th style={{ padding: '6px 8px', width: 36 }}>#</th>
                <th style={{ padding: '6px 8px' }}>Account</th>
                <th style={{ padding: '6px 8px' }}>Description</th>
                <th style={{ padding: '6px 8px' }}>Event</th>
                <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {d.lines.map((l) => (
                <tr key={l.id} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '6px 8px', color: 'var(--fg-muted)' }}>{l.line_no}</td>
                  <td style={{ padding: '6px 8px' }}><AccountCell code={l.debit_account_code} name={accountName(l.debit_account_code)} /></td>
                  <td style={{ padding: '6px 8px' }}>{l.description ?? '—'}</td>
                  <td style={{ padding: '6px 8px', color: l.project_id == null ? 'var(--fg-muted)' : undefined }}>{eventCellText(eventLabelsQ.data, l.project_id)}</td>
                  <td style={{ padding: '6px 8px', textAlign: 'right' }} className={mo.money}>{fmtSen(l.amount_sen)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--line)' }}>
                <td colSpan={4} style={{ padding: '6px 8px', fontWeight: 600 }}>Total · paid {fmtSen(inv.paid_sen)}</td>
                <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700 }} className={mo.money}>{fmtSen(inv.total_sen)}</td>
              </tr>
            </tbody>
          </table>
          <div className={mo.booksLine}>
            <b>{booksState}</b> · Dr {debits || '—'} · Cr {credit} · {fmtSen(inv.total_sen)}
          </div>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Payments</h2></div>
        <div className={styles.cardBody}>
          {payments.length === 0 ? (
            <div className={mo.hint}>{life === 'draft' ? 'Post the bill before paying it.' : life === 'cancelled' ? 'Cancelled.' : 'Nothing paid yet.'}</div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 'var(--fs-11)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <th style={{ padding: '6px 8px' }}>Paid by</th>
                  <th style={{ padding: '6px 8px' }}>Date</th>
                  <th style={{ padding: '6px 8px' }}>What</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={`${p.kind}-${p.id}-${p.amountSen}`} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '6px 8px' }}>
                      <Link className={mo.docLink} to={p.kind === 'PV' ? `/scm/payment-vouchers/${p.id}` : `/scm/supplier-notes/${p.id}`}>{p.number}</Link>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{fmtDateOrDash(p.date)}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <span className={mo.tags}>{paymentWhat(p)} <span className={`${mo.tag} ${p.stage === 'Approved' || p.stage === 'Posted' ? mo.toneCalm : p.stage === 'Cancelled' ? mo.toneLate : mo.toneInfo}`}>{p.stage}</span></span>
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }} className={mo.money}>{fmtSen(p.amountSen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <ApInvoiceFilesCard invoiceId={inv.id} canWrite={canCreate} locked={Number(inv.paid_sen) > 0} closed={life === 'cancelled'} />

      {/* The trail from the bill's own stamps and what paid it (AP bills write no entity audit). */}
      <section className={styles.card}>
        <div className={styles.cardHeader}><h2 className={styles.cardTitle}>Trail</h2></div>
        <div className={styles.cardBody}>
          <ol className={mo.trail}>
            <li><b>Raised</b><span className={mo.trailWho}> · {inv.created_by ?? 'System'}{inv.created_at ? ` · ${fmtDateTime(inv.created_at)}` : ''}</span></li>
            {inv.posted_at && <li><b>Posted</b><span className={mo.trailWho}> · {inv.posted_by ?? 'System'} · {fmtDateTime(inv.posted_at)}</span>{inv.je_no && <div className={mo.trailNote}>{inv.je_no}</div>}</li>}
            {payments.map((p) => (
              <li key={`t-${p.kind}-${p.id}-${p.amountSen}`}><b>{paymentWhat(p)}</b><span className={mo.trailWho}> · {p.number} · {p.stage}{p.date ? ` · ${fmtDateOrDash(p.date)}` : ''} · {fmtSen(p.amountSen)}</span></li>
            ))}
            {inv.cancelled_at && <li><b>Cancelled</b><span className={mo.trailWho}> · {inv.cancelled_by ?? 'System'} · {fmtDateTime(inv.cancelled_at)}</span></li>}
          </ol>
        </div>
      </section>

      {/* Mounted while open only — the page's own pop-outs stay the one dialog on it otherwise. */}
      {print.open && <PrintPreviewModal
        open
        onClose={print.close}
        docTitle={paper}
        docNo={inv.invoice_number}
        rows={[
          { label: 'Supplier', value: d.supplier ? `${d.supplier.code} · ${d.supplier.name}` : '—' },
          { label: dn ? 'Date' : 'Invoice date', value: fmtDateOrDash(inv.invoice_date) },
          { label: 'Due date', value: fmtDateOrDash(inv.due_date) },
          { label: 'Total', value: fmtSen(inv.total_sen) },
          {
            label: 'Files',
            /* The exclude toggle sits where the decision is made, as on the voucher page. */
            value: fileCount === 0 ? 'none attached' : (
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)}
                  aria-label="Include attached files in the print" style={{ width: 14, height: 14, accentColor: '#16695f' }} />
                {fileCount == null ? 'include its attached files after the bill page' : `include the ${fileCount} attached file(s) after the bill page`}
              </label>
            ),
          },
        ]}
        {...print.handlers}
      />}

      {planning && (
        <BillPlanDialog onClose={() => setPlanning(false)}
          bill={{ kind: 'API', id: inv.id, number: inv.invoice_number, supplierName: d.supplier?.name ?? null, outstandingSen: outstanding, due: inv.due_date, planned }} />
      )}
      {addingTask && (
        <VoucherTaskDrawer onClose={() => setAddingTask(false)}
          link={{ type: 'Supplier bill', no: inv.invoice_number, name: d.supplier?.name ?? '', to: `/scm/ap-invoices/${inv.id}` }} />
      )}

      {form && (
        <Modal title={formTitle} onClose={() => setForm(null)} ariaLabel={formTitle}>
          <ApInvoiceForm
            key={`${form}-${inv.id}`}
            mode={form}
            initial={fromDetail(d, form === 'copy')}
            suppliers={suppliersQ.data ?? []}
            suppliersLoading={suppliersQ.isLoading}
            lineAccounts={lineAccounts}
            posted={form === 'edit' && life !== 'draft'}
            paidSen={form === 'edit' ? Number(inv.paid_sen) : undefined}
            selfId={form === 'edit' ? inv.id : null}
            requestId={null}
            saving={update.isPending || create.isPending}
            onSubmit={(values) => submitForm(values)}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
}
