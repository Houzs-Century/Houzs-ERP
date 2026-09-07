// ----------------------------------------------------------------------------
// AP Invoices — /scm/ap-invoices, the Finance side's supplier bills.
//
// The owner's design (2026-09-06, AutoCount in hand), confirmed line by line:
// 可以不可以像 autocount 这样 purchase invoice 一边,然后再多一个 AP invoice …
// 我想要两个都看到, 现有的 purchase invoice remain. So: ONE table, a Kind
// column — the operational purchase invoices as a read-only mirror (they are
// raised and edited on Procurement → Purchase Invoices, which this page never
// touches; a row links there) beside the AP INVOICES raised HERE (rent, a
// service, an other creditor's bill — Draft → Post → paid down by the same AP
// Payment → Paid, or Cancelled). Lines pick their own accounts; posting books
// Dr each line / Cr the supplier's AP control by its code.
//
// The bill's paper (owner 2026-09-06: 做,附件也一起做,bundle 也带上): the form
// READS a bill with the voucher's own OCR (supplier match, number, dates,
// lines; the account from vendor memory only) and attaches the read pages on
// save; the detail shows the shared Files card; the AP Payment's print bundle
// carries these files after the voucher's own.
//
// Round 2 (same evening, screenshots in hand): the supplier box wears the
// form's own input dress, the lines are a table in HIS order — account
// number, description, amount — the bill carries an overall Description that
// the list shows, the list filters by supplier, and Print listing prints what
// the list shows.
//
// Round 3 (same night): a bill OPENS OVER the list (我点开时他是跑上去,我希望是
// pop out 出来) instead of pushing a card in above it; every field can be
// EDITED, a posted bill re-posting; a bill can be COPIED; the one form behind
// New / Edit / Copy lives in ApInvoiceForm.tsx (Insert adds a line, amounts
// read 1,800.00).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import { useAccounts, isControlSpecial, type Account } from '../../vendor/scm/lib/accounting-queries';
import { useSuppliers } from '../../vendor/scm/lib/suppliers-queries';
import {
  useApInvoices, useApInvoiceDetail, useCreateApInvoice, useUpdateApInvoice, usePostApInvoice, useCancelApInvoice,
  useApInvoiceFiles, useUploadApInvoiceFile, useDeleteApInvoiceFile, fetchApInvoiceFileBlobUrl,
  type ApListKind, type ApListRow, type ApInvoiceHeader, type ApInvoiceLine,
} from '../../vendor/scm/lib/ap-invoice-queries';
import type { PvFilePayload } from '../../vendor/scm/lib/payment-voucher-queries';
import { generateApListingPdf } from '../../vendor/scm/lib/ap-invoice-listing-pdf';
import { DocFilesCard } from '../../vendor/scm/components/DocFilesCard';
import { Modal } from '../../vendor/scm/components/Modal';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { ApInvoiceForm, emptyApForm, type ApFormMode, type ApFormSubmit, type ApFormValues } from './ApInvoiceForm';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const KIND_LABEL: Record<ApListRow['kind'], string> = { API: 'AP Invoice', PI: 'Purchase Invoice' };
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-13)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
/* One table dress for the detail and the list. */
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const right: React.CSSProperties = { textAlign: 'right', ...mono };
const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 };

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div className={styles.fieldLabel}>{label}</div>
    <div>{value}</div>
  </div>
);

type Detail = { invoice: ApInvoiceHeader; lines: ApInvoiceLine[]; supplier: { id: string; code: string; name: string } | null };
/** The form's values from a bill: an EDIT keeps everything, a COPY keeps the
    supplier, description and lines and starts the paper afresh — no supplier
    number, today's date, no due date, a new number on save. */
const fromDetail = (d: Detail, copy: boolean): ApFormValues => ({
  supplierId: d.invoice.supplier_id,
  supplierRef: copy ? '' : (d.invoice.supplier_invoice_ref ?? ''),
  invoiceDate: copy ? myt() : d.invoice.invoice_date,
  dueDate: copy ? '' : (d.invoice.due_date ?? ''),
  description: d.invoice.notes ?? '',
  lines: d.lines.map((l, i) => ({ rid: i + 1, description: l.description ?? '', debitAccountCode: l.debit_account_code, amountSen: l.amount_sen })),
});

type FormState = { mode: ApFormMode; initial: ApFormValues; invoiceId?: string; invoiceNumber?: string; posted?: boolean; paidSen?: number };

export const ApInvoices = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create') || can('scm.payment_voucher.write');
  const canPost = can('scm.payment_voucher.post');
  const canCancel = can('scm.payment_voucher.cancel');

  const [kind, setKind] = useState<ApListKind>('ALL');
  const listQ = useApInvoices(kind);
  const rows = listQ.data?.rows ?? [];
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailQ = useApInvoiceDetail(detailId);
  const detail = detailQ.data;

  /* The supplier filter (owner: supplier 筛选) — the suppliers ON the list,
     never the whole registry, so every choice shows something. */
  const [supplierFilter, setSupplierFilter] = useState('');
  const supplierOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) if (r.supplierId && r.supplierName) seen.set(r.supplierId, `${r.supplierCode ? `${r.supplierCode} · ` : ''}${r.supplierName}`);
    const named = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: '', label: 'All suppliers' }, ...named];
  }, [rows]);
  const visibleRows = useMemo(() => (supplierFilter ? rows.filter((r) => r.supplierId === supplierFilter) : rows), [rows, supplierFilter]);
  const filteredSupplierName = supplierFilter ? (rows.find((r) => r.supplierId === supplierFilter)?.supplierName ?? null) : null;

  const suppliersQ = useSuppliers({ status: 'ACTIVE' });
  const accountsQ = useAccounts();
  /* A line debits an ordinary LEAF: active, not a control (由模块过账) and
     not a header (父户不记账) — the same door the PV's lines walk. */
  const lineAccounts = useMemo<Account[]>(() => {
    const all = accountsQ.data?.accounts ?? [];
    const parents = new Set(all.map((a) => a.parent_code).filter((p): p is string => !!p));
    return all.filter((a) => a.is_active && !isControlSpecial(a.special_type) && !parents.has(a.account_code));
  }, [accountsQ.data]);
  /* The detail names accounts off the UNFILTERED chart — a posted bill on a
     since-inactive account must still print that account's name. */
  const accountName = (code: string): string => (accountsQ.data?.accounts ?? []).find((a) => a.account_code === code)?.account_name ?? '';

  const create = useCreateApInvoice();
  const update = useUpdateApInvoice();
  const post = usePostApInvoice();
  const cancel = useCancelApInvoice();
  const uploadFile = useUploadApInvoiceFile();

  /* The one form — New, Edit, Copy — in its own pop-out over the list. */
  const [form, setForm] = useState<FormState | null>(null);
  const openNew = () => setForm({ mode: 'new', initial: emptyApForm() });
  const openEdit = (d: Detail) => setForm({
    mode: 'edit', initial: fromDetail(d, false), invoiceId: d.invoice.id, invoiceNumber: d.invoice.invoice_number,
    posted: d.invoice.status !== 'DRAFT', paidSen: Number(d.invoice.paid_sen),
  });
  const openCopy = (d: Detail) => setForm({ mode: 'copy', initial: fromDetail(d, true), invoiceNumber: d.invoice.invoice_number });

  const submitForm = async (values: ApFormSubmit, pendingFiles: PvFilePayload[]) => {
    if (!form) return;
    try {
      if (form.mode === 'edit' && form.invoiceId) {
        const res = await update.mutateAsync({ id: form.invoiceId, body: values });
        setForm(null);
        void notify({
          title: `${res.invoice.invoice_number} saved`,
          body: res.reposted ? `The bill was re-posted — the old journal got its contra and ${res.jeNo ?? 'a fresh entry'} books it as saved.` : 'The draft is updated.',
          tone: 'info',
        });
        return;
      }
      const res = await create.mutateAsync(values);
      /* Attach the scanned bill AFTER the invoice exists — sequentially, so
         sort_no (= print order) is the scan order. A failed upload never
         un-saves the bill: the notice says what still needs adding, and the
         detail's Files card takes it; nothing stays pending for the NEXT
         bill this form raises. */
      let attached = 0;
      let attachErr: string | null = null;
      for (const f of pendingFiles) {
        try {
          await uploadFile.mutateAsync({ invoiceId: res.invoice.id, file: f });
          attached += 1;
        } catch (e) {
          attachErr = e instanceof Error ? e.message : 'The file could not be uploaded.';
          break;
        }
      }
      setForm(null);
      setDetailId(res.invoice.id);
      void notify({
        title: `${res.invoice.invoice_number} raised`,
        body: [
          `${fmtSen(res.invoice.total_sen)} as a draft — post it to put it on the books.`,
          form.mode === 'copy' && form.invoiceNumber ? `Copied from ${form.invoiceNumber}.` : null,
          attached > 0 ? `${attached} scanned file(s) attached.` : null,
          attachErr ? `${pendingFiles.length - attached} file(s) did not attach (${attachErr}) — add them from the bill's Files card.` : null,
        ].filter(Boolean).join(' '),
        tone: attachErr ? 'error' : 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill not saved', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onPost = async (id: string, no: string) => {
    const ok = await askConfirm({
      title: `Post ${no}?`,
      body: 'Books Dr each line\'s account / Cr the supplier\'s AP control, dated by the invoice. From then on it is paid through an AP Payment.',
      confirmLabel: 'Post',
    });
    if (!ok) return;
    try {
      await post.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Post failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };
  const onCancel = async (id: string, no: string, posted: boolean) => {
    const ok = await askConfirm({
      title: `Cancel ${no}?`,
      body: posted ? 'The journal is reversed with a contra — the ledger keeps both sides. A bill with a payment on it refuses.' : 'The draft is closed; nothing was ever posted.',
      confirmLabel: 'Cancel bill', danger: true,
    });
    if (!ok) return;
    try {
      await cancel.mutateAsync(id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Print listing (owner: print listing 功能我也想要) — exactly the rows on
     screen, kind and supplier filters applied, totalled. */
  const printListing = () => {
    void generateApListingPdf(visibleRows, { kind, supplierName: filteredSupplierName }).catch((e: unknown) => {
      void notify({ title: 'Listing not printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    });
  };

  const formTitle = form?.mode === 'edit'
    ? `Edit ${form.invoiceNumber ?? 'AP invoice'}`
    : form?.mode === 'copy' ? `New AP invoice — copied from ${form.invoiceNumber ?? 'a bill'}` : 'New AP invoice — 非库存的供应商账单';

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="AP Invoices"
        actions={canCreate ? (
          <button type="button" onClick={openNew} style={linkBtn}>
            <Plus {...ICON} /> New AP invoice
          </button>
        ) : undefined}
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Supplier invoices — both kinds</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {([['ALL', 'All'], ['API', 'AP invoices'], ['PI', 'Purchase invoices']] as const).map(([v, label]) => (
              <button key={v} type="button" style={chip(kind === v)} onClick={() => setKind(v)}>{label}</button>
            ))}
            <div style={{ minWidth: 260 }}>
              <SearchCombo options={supplierOptions} value={supplierFilter} onChange={setSupplierFilter}
                className={styles.fieldInput} aria-label="Filter by supplier" placeholder="All suppliers" />
            </div>
            <Button variant="secondary" size="sm" onClick={printListing} disabled={visibleRows.length === 0}>
              <Printer {...ICON} /> Print listing
            </Button>
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {listQ.isLoading && <div style={{ fontSize: 'var(--fs-13)' }}>Loading…</div>}
          {/* A refused or failed read says so — an empty sentence over a 403 hid
             docs/bugs/0648 for an afternoon. */}
          {listQ.isError && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--c-red, #b3261e)' }}>The list could not be loaded — {listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}</div>
          )}
          {!listQ.isLoading && !listQ.isError && visibleRows.length === 0 && (
            <div style={{ fontSize: 'var(--fs-13)', color: 'var(--fg-muted)' }}>
              {rows.length > 0
                ? 'No supplier invoices match this filter — pick another supplier or kind.'
                : 'No supplier invoices here yet — purchase invoices show once posted on the Procurement side; raise an AP invoice for a non-stock bill.'}
            </div>
          )}
          {visibleRows.length > 0 && (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
              <thead>
                <tr>
                  <th style={th}>Kind</th>
                  <th style={th}>No.</th>
                  <th style={th}>Supplier</th>
                  <th style={th}>Ref</th>
                  <th style={th}>Description</th>
                  <th style={th}>Date</th>
                  <th style={th}>Due</th>
                  <th style={{ ...th, textAlign: 'right' }}>Total</th>
                  <th style={{ ...th, textAlign: 'right' }}>Outstanding</th>
                  <th style={th}>Status</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} style={{ borderBottom: '1px solid var(--border-weak, #f0eee8)', opacity: r.status === 'CANCELLED' ? 0.55 : 1 }}>
                    <td style={{ ...td, fontSize: 'var(--fs-11)', fontWeight: 600, whiteSpace: 'nowrap' }}>{KIND_LABEL[r.kind]}</td>
                    <td style={{ ...td, ...mono, whiteSpace: 'nowrap' }}>
                      {r.kind === 'PI'
                        ? <Link to={`/scm/purchase-invoices/${r.id}`} style={{ color: 'inherit' }}>{r.invoiceNumber}</Link>
                        : <button type="button" onClick={() => setDetailId(r.id)} style={{ ...linkBtn, ...mono }}>{r.invoiceNumber}</button>}
                    </td>
                    <td style={td}>{r.supplierName ?? '—'}{r.supplierCode ? <span style={soft}> · {r.supplierCode}</span> : null}</td>
                    <td style={td}>{r.supplierInvoiceRef ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description ?? undefined}>{r.description ?? '—'}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDateOrDash(r.invoiceDate)}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtDateOrDash(r.dueDate)}</td>
                    <td style={{ ...td, ...right }}>{fmtSen(r.totalSen)}</td>
                    <td style={{ ...td, ...right, fontWeight: r.outstandingSen > 0 ? 700 : 400 }}>{fmtSen(r.outstandingSen)}</td>
                    <td style={{ ...td, fontSize: 'var(--fs-11)' }}>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* The bill, popped out over the list (owner: 我希望是 pop out 出来). */}
      {detailId && detail && (
        <Modal
          title={`${detail.invoice.invoice_number} · ${detail.supplier?.name ?? '—'}`}
          onClose={() => setDetailId(null)}
          ariaLabel={`AP invoice ${detail.invoice.invoice_number}`}
          actions={(
            <>
              <span style={soft}>{detail.invoice.status}</span>
              {canCreate && detail.invoice.status !== 'CANCELLED' && (
                <Button variant="secondary" size="sm" onClick={() => openEdit(detail)}>Edit</Button>
              )}
              {canCreate && (
                <Button variant="secondary" size="sm" onClick={() => openCopy(detail)}>Copy</Button>
              )}
              {canPost && detail.invoice.status === 'DRAFT' && (
                <Button variant="primary" size="sm" onClick={() => void onPost(detail.invoice.id, detail.invoice.invoice_number)} disabled={post.isPending}>
                  {post.isPending ? 'Posting…' : 'Post'}
                </Button>
              )}
              {canCancel && detail.invoice.status !== 'CANCELLED' && Number(detail.invoice.paid_sen) === 0 && (
                <Button variant="ghost" size="sm" onClick={() => void onCancel(detail.invoice.id, detail.invoice.invoice_number, detail.invoice.status !== 'DRAFT')} disabled={cancel.isPending}>
                  Cancel bill
                </Button>
              )}
            </>
          )}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Supplier" value={<span><span style={mono}>{detail.supplier?.code ?? ''}</span> {detail.supplier?.name ?? '—'}</span>} />
            <Meta label="Supplier's invoice no." value={detail.invoice.supplier_invoice_ref ?? '—'} />
            <Meta label="Invoice date" value={fmtDateOrDash(detail.invoice.invoice_date)} />
            <Meta label="Due date" value={fmtDateOrDash(detail.invoice.due_date)} />
            <Meta label="Description" value={detail.invoice.notes ?? '—'} />
          </div>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--fs-13)' }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 36 }}>#</th>
                <th style={th}>Account</th>
                <th style={th}>Description</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {detail.lines.map((l) => (
                <tr key={l.id}>
                  <td style={{ ...td, ...mono, color: 'var(--fg-muted)' }}>{l.line_no}</td>
                  <td style={td}><span style={mono}>{l.debit_account_code}</span>{accountName(l.debit_account_code) ? <span style={soft}> · {accountName(l.debit_account_code)}</span> : null}</td>
                  <td style={td}>{l.description ?? '—'}</td>
                  <td style={{ ...td, ...right }}>{fmtSen(l.amount_sen)}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                <td colSpan={3} style={{ ...td, fontWeight: 600 }}>Total · paid {fmtSen(detail.invoice.paid_sen)}</td>
                <td style={{ ...td, ...right, fontWeight: 700 }}>{fmtSen(detail.invoice.total_sen)}</td>
              </tr>
            </tbody>
          </table>
          <ApInvoiceFilesCard invoiceId={detail.invoice.id} canWrite={canCreate}
            locked={detail.invoice.status !== 'DRAFT' && detail.invoice.status !== 'CANCELLED'}
            closed={detail.invoice.status === 'CANCELLED'} />
        </Modal>
      )}

      {form && (
        <Modal title={formTitle} onClose={() => setForm(null)} ariaLabel={formTitle}>
          <ApInvoiceForm
            key={`${form.mode}-${form.invoiceId ?? 'new'}`}
            mode={form.mode}
            initial={form.initial}
            suppliers={suppliersQ.data ?? []}
            suppliersLoading={suppliersQ.isLoading}
            lineAccounts={lineAccounts}
            posted={form.posted}
            paidSen={form.paidSen}
            saving={create.isPending || update.isPending || uploadFile.isPending}
            onSubmit={submitForm}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};

/* ── Files card — the supplier's bill behind this AP invoice (mig
   20260906T2100): the voucher's DocFilesCard bound to this document's hooks
   and rule — a POSTED bill keeps its files (no check layer; the ledger is its
   lock) but still takes a late scan, a CANCELLED one takes no more. */
const ApInvoiceFilesCard = ({ invoiceId, canWrite, locked, closed }: { invoiceId: string; canWrite: boolean; locked: boolean; closed: boolean }) => {
  const filesQ = useApInvoiceFiles(invoiceId);
  const upload = useUploadApInvoiceFile();
  const remove = useDeleteApInvoiceFile();
  return (
    <DocFilesCard
      files={filesQ.data?.files ?? []}
      canWrite={canWrite} locked={locked} closed={closed}
      lockedNote=" · locked with the posted bill"
      emptyNote="No files yet. A bill scanned on the New form attaches its pages here by itself; use Attach file for anything else."
      removeBody="The stored file is deleted with its row. A posted bill refuses this — evidence locks with the document."
      attachAriaLabel="Attach bill files"
      uploading={upload.isPending} removing={remove.isPending}
      onUpload={(file) => upload.mutateAsync({ invoiceId, file })}
      onRemove={(fileId) => remove.mutateAsync({ invoiceId, fileId })}
      openUrl={(fileId) => fetchApInvoiceFileBlobUrl(invoiceId, fileId)}
    />
  );
};
