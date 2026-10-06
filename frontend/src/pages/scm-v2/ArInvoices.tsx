// ----------------------------------------------------------------------------
// AR Invoices — /scm/ar-invoices, the Finance side's customer invoices, the
// AP Invoices page's twin (AutoCount's A/R Invoice).
//
// The owner's design (2026-09-29): 可以把 sales invoice 和 other debtor bill 做
// 一个类似 ap invoice 这样让我 finance 这边看两个一起吗 — ONE table, a Kind
// column: the operational SALES INVOICES as a read-only mirror (raised and
// edited on Sales Order → Sales Invoices, which this page never touches; a
// row links there) beside the OTHER DEBTOR BILLS raised HERE. Then, the same
// evening: 我希望 other debtor 那边只是 maintain other debtor 就好, 开 other
// debtor 的 bill 就直接在 ar invoice 页面 — the Other Debtors page keeps the
// registry; New debtor bill lives here (the debtor picked first, then the
// same DebtorBillForm — Insert adds a line, amounts read 1,800.00); a bill
// opens in a pop-out OVER the list with Print / Edit / Copy / Cancel; its
// money is received on the Receipts page. Deposit invoices stay on their own
// page (留着); credit and debit notes are not here (对). A party filter, the
// kind chips and Print listing print exactly what the list shows.
// `?debtor=<id>` opens the page filtered to one debtor — the registry and
// the Receipts page link here that way.
//
// Every row OPENS (owner 2026-10-06: ar invoice 点不开、没有办法 print — only a
// sales invoice's number was a link, drawn as plain text, and nothing here
// printed one): a click anywhere on a row opens it over the list — a debtor
// bill in its pop-out, a sales invoice as the page it prints, with Print,
// Save PDF and its full page a link away. Ticked rows print as ONE document,
// each as its own print, in list order (ar-invoice-print.ts).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, postableAccounts, useOtherDebtors, useCreateDebtorBill, useUpdateDebtorBill, useCancelDebtorBill,
  type Account, type DebtorBill,
} from '../../vendor/scm/lib/accounting-queries';
import { useArInvoices, useArBillDetail, type ArBillDetail, type ArListKind, type ArListRow } from '../../vendor/scm/lib/ar-invoice-queries';
import { generateArListingPdf } from '../../vendor/scm/lib/ar-invoice-listing-pdf';
import { generateDebtorBillPdf } from '../../vendor/scm/lib/debtor-bill-pdf';
import { useSalesInvoiceDetail } from '../../vendor/scm/lib/sales-invoice-queries';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { Modal } from '../../vendor/scm/components/Modal';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../vendor/scm/components/ConfirmDialog';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { DataTable, type Column } from '../../components/DataTable';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { DebtorBillForm, emptyBillForm, type BillFormMode, type BillFormSubmit, type BillFormValues } from './DebtorBillForm';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const KIND_LABEL: Record<ArListRow['kind'], string> = { SI: 'Sales Invoice', ODB: 'Debtor Bill' };
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-13)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
/* One table dress for the detail and the list — the AP page's. */
const th: React.CSSProperties = {
  padding: '6px 8px', textAlign: 'left', fontSize: 'var(--fs-11)', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--fg-muted)', borderBottom: '1px solid var(--border-weak, #e3e1da)', whiteSpace: 'nowrap',
};
const td: React.CSSProperties = { padding: '6px 8px', verticalAlign: 'middle' };
const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };
const right: React.CSSProperties = { textAlign: 'right', ...mono };
const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 };

const danger = 'var(--c-festive-b, #B8331F)';
const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/* A sales invoice opened from the list: the page as it prints (the browser's
   own PDF viewer), Print and Save PDF, and its full page a link away. */
const SalesInvoicePopOut = ({ id, onClose }: { id: string; onClose: () => void }) => {
  const q = useSalesInvoiceDetail(id);
  const notify = useNotify();
  const header = q.data?.salesInvoice;
  const items = q.data?.items;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!header || !items) return;
    let live = true;
    let made: string | null = null;
    setFailed(null);
    void import('../../vendor/scm/lib/sales-invoice-pdf')
      .then(({ salesInvoicePdfBlob }) => salesInvoicePdfBlob(header, items))
      .then((blob) => { if (!live) return; made = URL.createObjectURL(blob); setUrl(made); })
      .catch((e: unknown) => { if (live) setFailed(errText(e)); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [header, items]);
  const deliver = async (action: PdfAction) => {
    if (!header || !items || busy) return;
    setBusy(true);
    try {
      const { generateSalesInvoicePdf } = await import('../../vendor/scm/lib/sales-invoice-pdf');
      await generateSalesInvoicePdf(header, items, { action });
    } catch (e) {
      void notify({ title: 'Invoice not printed', body: errText(e), tone: 'error' });
    } finally { setBusy(false); }
  };
  const number = header ? String(header.invoice_number ?? '') : '';
  return (
    <Modal
      title={header ? `${number} · ${String(header.debtor_name ?? '—')}` : 'Sales invoice'}
      onClose={onClose}
      width="min(980px, 100%)"
      ariaLabel={number ? `Sales invoice ${number}` : 'Sales invoice'}
      actions={header ? (
        <>
          <span style={soft}>{humaniseStatusKey(String(header.status ?? ''))}</span>
          <Button size="sm" onClick={() => void deliver('print')} disabled={busy}><Printer {...ICON} /> {busy ? 'Preparing…' : 'Print'}</Button>
          <Button variant="ghost" size="sm" onClick={() => void deliver('save')} disabled={busy}>Save PDF</Button>
          <Link to={`/scm/sales-invoices/${id}`} style={linkBtn}>Open full page</Link>
        </>
      ) : undefined}
    >
      {q.isLoading && <div style={soft}>Loading…</div>}
      {q.isError && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The invoice did not load — {errText(q.error)}</div>}
      {failed && <div style={{ fontSize: 'var(--fs-13)', color: danger }}>The invoice could not be drawn — {failed}</div>}
      {header && !failed && (url
        ? <iframe title={`Sales invoice ${number} as printed`} src={url}
            style={{ width: '100%', height: '72vh', border: '1px solid var(--border-weak, #e3e1da)', borderRadius: 6, background: '#fff' }} />
        : <div style={soft}>Drawing the invoice…</div>)}
    </Modal>
  );
};

const Meta = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div>
    <div className={styles.fieldLabel}>{label}</div>
    <div>{value}</div>
  </div>
);

/** The form's values from a bill: an EDIT keeps everything, a COPY keeps the
    description and lines and starts the paper afresh — today's date, a new
    number on post. */
const fromBill = (b: DebtorBill, copy: boolean): BillFormValues => ({
  billDate: copy ? myt() : b.bill_date,
  notes: b.notes ?? '',
  lines: (b.lines ?? []).map((l, i) => ({ rid: i + 1, description: l.description ?? '', creditAccountCode: l.credit_account_code ?? '', amountSen: l.amount_sen, projectId: l.project_id ?? null })),
});

type FormState = {
  mode: BillFormMode; initial: BillFormValues;
  /** The debtor the bill belongs to — picked on New, carried over on Copy, fixed on Edit. */
  debtorId: string; debtorName?: string;
  billId?: string; billNumber?: string; receivedSen?: number;
};

export const ArInvoices = () => {
  const askConfirm = useConfirm();
  const notify = useNotify();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');
  const canWrite = can('scm.payment_voucher.write') || canCreate;
  const canCancel = can('scm.payment_voucher.cancel');

  const [kind, setKind] = useState<ArListKind>('ALL');
  const listQ = useArInvoices(kind);
  const rows = listQ.data?.rows ?? [];
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailQ = useArBillDetail(detailId);
  const detail = detailQ.data;
  /* A sales invoice opened over the list. */
  const [siId, setSiId] = useState<string | null>(null);
  const openRow = (r: ArListRow) => { if (r.kind === 'SI') setSiId(r.id); else setDetailId(r.id); };
  /* Ticked rows, by the table's row key. */
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [printing, setPrinting] = useState(false);
  const rowKey = (r: ArListRow) => `${r.kind}-${r.id}`;

  const debtorsQ = useOtherDebtors();
  const debtors = debtorsQ.data?.debtors ?? [];
  const activeDebtors = useMemo(() => debtors.filter((d) => d.is_active), [debtors]);

  /* The party filter — the customers and debtors ON the list, plus every
     active debtor off the registry, so `?debtor=` from the registry or the
     Receipts page always names one, even a debtor with no bill yet. */
  const [params] = useSearchParams();
  const [partyFilter, setPartyFilter] = useState<string>(() => {
    const d = params.get('debtor');
    return d ? `D:${d}` : '';
  });
  const partyOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of activeDebtors) seen.set(`D:${d.id}`, d.name);
    for (const r of rows) if (r.partyName) seen.set(r.partyKey, r.partyCode ? `${r.partyCode} · ${r.partyName}` : r.partyName);
    const named = [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    return [{ value: '', label: 'All customers and debtors' }, ...named];
  }, [rows, activeDebtors]);
  const visibleRows = useMemo(() => (partyFilter ? rows.filter((r) => r.partyKey === partyFilter) : rows), [rows, partyFilter]);
  /* What the table shows after its own funnels: the listing prints exactly that. */
  const [shownRows, setShownRows] = useState<ArListRow[] | null>(null);
  const filteredPartyName = partyFilter
    ? (rows.find((r) => r.partyKey === partyFilter)?.partyName ?? debtors.find((d) => `D:${d.id}` === partyFilter)?.name ?? null)
    : null;

  const accountsQ = useAccounts();
  /* A line credits an ordinary LEAF: active, not a control (由模块过账) and
     not a header (父户不记账) — the one home (postableAccounts, docs/bugs/0693). */
  const lineAccounts = useMemo<Account[]>(() => postableAccounts(accountsQ.data?.accounts ?? []), [accountsQ.data]);
  /* The detail names accounts off the UNFILTERED chart — a posted bill on a
     since-inactive account must still print that account's name. */
  const accountNameOf = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);

  const createBill = useCreateDebtorBill();
  const updateBill = useUpdateDebtorBill();
  const cancelBill = useCancelDebtorBill();

  /* The one form — New, Edit, Copy — in its own pop-out over the list. */
  const [form, setForm] = useState<FormState | null>(null);
  const openNew = () => setForm({ mode: 'new', initial: emptyBillForm(), debtorId: partyFilter.startsWith('D:') ? partyFilter.slice(2) : '' });
  const openEdit = (d: ArBillDetail) => setForm({
    mode: 'edit', initial: fromBill(d.bill, false), debtorId: d.debtor?.id ?? '', debtorName: d.debtor?.name,
    billId: d.bill.id, billNumber: d.bill.bill_number, receivedSen: Number(d.bill.received_sen),
  });
  const openCopy = (d: ArBillDetail) => setForm({ mode: 'copy', initial: fromBill(d.bill, true), debtorId: d.debtor?.id ?? '', billNumber: d.bill.bill_number });

  const submitBill = async (values: BillFormSubmit) => {
    if (!form) return;
    try {
      if (form.mode === 'edit' && form.billId) {
        const res = await updateBill.mutateAsync({ billId: form.billId, body: values });
        setForm(null);
        void notify({ title: `${res.bill.billNumber} saved`, body: `Re-posted — the old journal got its contra and ${res.jeNo ?? 'a fresh entry'} books it as saved; ${fmtSen(res.bill.totalSen)} now on 305-0000.`, tone: 'info' });
        return;
      }
      if (!form.debtorId) {
        void notify({ title: 'Pick the debtor', body: 'A bill belongs to one other debtor — pick who owes it before posting.', tone: 'error' });
        return;
      }
      const res = await createBill.mutateAsync({ debtorId: form.debtorId, ...values });
      setForm(null);
      void notify({
        title: `${res.bill.billNumber} posted`,
        body: `${fmtSen(res.bill.totalSen)} now owing — the GL carries it on 305-0000.${form.mode === 'copy' && form.billNumber ? ` Copied from ${form.billNumber}.` : ''}`,
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  const onCancelBill = async (b: DebtorBill) => {
    const ok = await askConfirm({ title: `Cancel ${b.bill_number}?`, body: 'The ODB journal is reversed; a bill with money received refuses.', confirmLabel: 'Cancel bill', danger: true });
    if (!ok) return;
    try {
      await cancelBill.mutateAsync(b.id);
    } catch (e) {
      void notify({ title: 'Cancel failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    }
  };

  /* Print listing — exactly the rows on screen, kind and party filters applied, totalled. */
  const printListing = () => {
    void generateArListingPdf(shownRows ?? visibleRows, { kind, partyName: filteredPartyName }).catch((e: unknown) => {
      void notify({ title: 'Listing not printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    });
  };
  /* The ticked rows the table shows, in its order, as ONE document. */
  const tickedRows = (shownRows ?? visibleRows).filter((r) => ticked.has(rowKey(r)));
  const printTicked = async (action: PdfAction) => {
    if (tickedRows.length === 0 || printing) return;
    setPrinting(true);
    try {
      const [{ arInvoicesPdfBlob }, { deliverPdfBlob }] = await Promise.all([
        import('../../vendor/scm/lib/ar-invoice-print'), import('../../vendor/scm/lib/pdf-common'),
      ]);
      deliverPdfBlob(await arInvoicesPdfBlob(tickedRows, accountNameOf), `ar-invoices-${myt()}.pdf`, action);
    } catch (e) {
      void notify({ title: 'Invoices not printed', body: errText(e), tone: 'error' });
    } finally { setPrinting(false); }
  };
  const printBill = (d: ArBillDetail) => {
    void generateDebtorBillPdf({ bill: d.bill, debtor: d.debtor ?? { name: '(debtor)', phone: null }, accountName: accountNameOf }, { action: 'print' }).catch((e: unknown) => {
      void notify({ title: 'Bill not printed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
    });
  };

  const arColumns = useMemo<Column<ArListRow>[]>(() => [
    { key: 'kind', label: 'Kind', render: (r) => <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600 }}>{KIND_LABEL[r.kind]}</span>, getValue: (r) => KIND_LABEL[r.kind] },
    {
      key: 'number', label: 'No.',
      /* Both kinds open the same way the row does — the number reads as the link it is. */
      render: (r) => <button type="button" onClick={(e) => { e.stopPropagation(); openRow(r); }} className={cancelledDocNoClass(r.status)} style={{ ...linkBtn, ...mono }}>{r.invoiceNumber}</button>,
      getValue: (r) => r.invoiceNumber,
    },
    {
      key: 'party', label: 'Customer / Debtor',
      render: (r) => <>{r.partyName ?? '—'}{r.partyCode ? <span style={soft}> · {r.partyCode}</span> : null}</>,
      getValue: (r) => r.partyName ?? '',
    },
    { key: 'ref', label: 'Ref', render: (r) => r.ref ? <span style={mono}>{r.ref}</span> : '—', getValue: (r) => r.ref ?? '' },
    { key: 'description', label: 'Description', width: '260px', render: (r) => r.description ?? '—', getValue: (r) => r.description ?? '' },
    { key: 'date', label: 'Date', render: (r) => fmtDateOrDash(r.invoiceDate), getValue: (r) => r.invoiceDate, exportFormat: 'date' },
    { key: 'due', label: 'Due', render: (r) => fmtDateOrDash(r.dueDate), getValue: (r) => r.dueDate, exportFormat: 'date' },
    {
      key: 'total', label: 'Total', align: 'right', render: (r) => fmtSen(r.totalSen),
      getValue: (r) => r.totalSen, exportValue: (r) => r.totalSen / 100, exportFormat: 'money',
    },
    {
      key: 'outstanding', label: 'Outstanding', align: 'right',
      /* The SI list's own figure and its own marker: when the order's deposit
         settles part of the invoice the cell SAYS so (siDepositAppliedSen). */
      render: (r) => (
        <span style={{ fontWeight: r.outstandingSen > 0 ? 700 : 400 }}
          title={r.depositAppliedSen > 0 ? `${fmtSen(r.depositAppliedSen)} was collected on ${r.ref ?? 'the sales order'} and settles this invoice.` : undefined}>
          {fmtSen(r.outstandingSen)}
          {r.depositAppliedSen > 0 && (
            <span className="rounded-sm bg-surface-2 px-1 font-mono text-[9px] font-semibold uppercase tracking-brand text-ink-muted" style={{ marginLeft: 4 }}>dep</span>
          )}
        </span>
      ),
      getValue: (r) => r.outstandingSen, exportValue: (r) => r.outstandingSen / 100, exportFormat: 'money',
    },
    { key: 'status', label: 'Status', render: (r) => <span style={{ fontSize: 'var(--fs-11)' }}>{humaniseStatusKey(r.status)}</span>, getValue: (r) => r.status },
  ], []);

  const debtorOptions = useMemo(() => activeDebtors.map((d) => ({ value: d.id, label: d.name })), [activeDebtors]);
  const formTitle = form?.mode === 'edit'
    ? `Edit ${form.billNumber ?? 'bill'} — ${form.debtorName ?? ''}`
    : form?.mode === 'copy' ? `New debtor bill — copied from ${form.billNumber ?? 'a bill'}` : 'New debtor bill — 明细行自由选户口';

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Finance"
        title="AR Invoices"
        actions={canCreate ? (
          <button type="button" onClick={openNew} style={linkBtn}>
            <Plus {...ICON} /> New debtor bill
          </button>
        ) : undefined}
      />

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>Customer invoices — both kinds</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {([['ALL', 'All'], ['SI', 'Sales invoices'], ['ODB', 'Debtor bills']] as const).map(([v, label]) => (
              <button key={v} type="button" style={chip(kind === v)} onClick={() => setKind(v)}>{label}</button>
            ))}
            <div style={{ minWidth: 260 }}>
              <SearchCombo options={partyOptions} value={partyFilter} onChange={setPartyFilter}
                className={styles.fieldInput} aria-label="Filter by customer or debtor" placeholder="All customers and debtors" />
            </div>
            <Button variant="secondary" size="sm" onClick={printListing} disabled={(shownRows ?? visibleRows).length === 0}>
              <Printer {...ICON} /> Print listing
            </Button>
          </div>
        </div>
        <div className={styles.cardBody} style={{ overflowX: 'auto' }}>
          {tickedRows.length > 0 && (
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--fs-13)', marginBottom: 'var(--space-2)' }} aria-label="Ticked invoices">
              <span>{tickedRows.length} ticked</span>
              <Button size="sm" onClick={() => void printTicked('print')} disabled={printing}>{printing ? 'Preparing…' : `Print ${tickedRows.length}`}</Button>
              <Button variant="ghost" size="sm" onClick={() => void printTicked('save')} disabled={printing}>Save PDF</Button>
              <Button variant="ghost" size="sm" onClick={() => setTicked(new Set())} disabled={printing}>Clear</Button>
            </div>
          )}
          {/* A refused or failed read says so — an empty sentence over a 403 hid
             docs/bugs/0648 for an afternoon. */}
          <DataTable<ArListRow>
            tableId="ar-invoices"
            exportName="ar-invoices"
            exportXlsx
            columns={arColumns}
            rows={listQ.data ? visibleRows : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The list could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0
              ? 'No customer invoices match this filter — pick another party or kind.'
              : 'No customer invoices here yet — sales invoices show once issued on the Sales side; raise a debtor bill for money owed by someone outside the trade.'}
            getRowKey={rowKey}
            getRowClassName={(r) => cancelledRowClass(r.status)}
            getRowStyle={(r) => (r.status === 'CANCELLED' ? { opacity: 0.55 } : undefined)}
            onFilteredRowsChange={setShownRows}
            onRowClick={openRow}
            selection={{
              selectedIds: ticked,
              onToggle: (key) => setTicked((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n; }),
              onToggleAll: (keys, all) => setTicked(all ? new Set() : new Set(keys)),
              rowLabel: (r) => `Tick ${r.invoiceNumber}`,
            }}
          />
        </div>
      </section>

      {/* The bill, popped out over the list — the AP page's shape. */}
      {detailId && detail && (
        <Modal
          title={`${detail.bill.bill_number} · ${detail.debtor?.name ?? '—'}`}
          onClose={() => setDetailId(null)}
          ariaLabel={`Debtor bill ${detail.bill.bill_number}`}
          actions={(
            <>
              <span style={soft}>{humaniseStatusKey(detail.bill.status)}</span>
              <Button variant="secondary" size="sm" onClick={() => printBill(detail)}><Printer {...ICON} /> Print</Button>
              {canWrite && detail.bill.status !== 'CANCELLED' && (
                <Button variant="secondary" size="sm" onClick={() => openEdit(detail)}>Edit</Button>
              )}
              {canCreate && (
                <Button variant="secondary" size="sm" onClick={() => openCopy(detail)}>Copy</Button>
              )}
              {canCancel && detail.bill.status !== 'CANCELLED' && Number(detail.bill.received_sen) === 0 && (
                <Button variant="ghost" size="sm" onClick={() => void onCancelBill(detail.bill)} disabled={cancelBill.isPending}>
                  Cancel bill
                </Button>
              )}
            </>
          )}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--space-3)', fontSize: 'var(--fs-13)' }}>
            <Meta label="Debtor" value={detail.debtor?.name ?? '—'} />
            <Meta label="Bill date" value={fmtDateOrDash(detail.bill.bill_date)} />
            <Meta label="Description" value={detail.bill.notes ?? '—'} />
            <Meta label="Received" value={<span style={mono}>{fmtSen(detail.bill.received_sen)}</span>} />
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
              {(detail.bill.lines ?? []).map((l) => (
                <tr key={l.id}>
                  <td style={{ ...td, ...mono, color: 'var(--fg-muted)' }}>{l.line_no}</td>
                  <td style={td}>
                    {l.credit_account_code
                      ? <><span style={mono}>{l.credit_account_code}</span>{accountNameOf(l.credit_account_code) ? <span style={soft}> · {accountNameOf(l.credit_account_code)}</span> : null}</>
                      : <span style={soft}>text line</span>}
                  </td>
                  <td style={td}>{l.description ?? '—'}</td>
                  <td style={{ ...td, ...right }}>{l.credit_account_code ? fmtSen(l.amount_sen) : ''}</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid var(--border-weak, #e3e1da)' }}>
                <td colSpan={3} style={{ ...td, fontWeight: 600 }}>Total · outstanding {fmtSen(Math.max(0, detail.bill.total_sen - detail.bill.received_sen))}</td>
                <td style={{ ...td, ...right, fontWeight: 700 }}>{fmtSen(detail.bill.total_sen)}</td>
              </tr>
            </tbody>
          </table>
        </Modal>
      )}

      {siId && <SalesInvoicePopOut id={siId} onClose={() => setSiId(null)} />}

      {form && (
        <Modal title={formTitle} onClose={() => setForm(null)} ariaLabel={formTitle}>
          {form.mode !== 'edit' && (
            <label className={styles.field} style={{ maxWidth: 420, marginBottom: 'var(--space-3)' }}>
              <span className={styles.fieldLabel}>Debtor *</span>
              <SearchCombo options={debtorOptions} value={form.debtorId} onChange={(id) => setForm((prev) => (prev ? { ...prev, debtorId: id } : prev))}
                className={styles.fieldInput} aria-label="Bill debtor" placeholder="— who owes this bill —" />
            </label>
          )}
          <DebtorBillForm
            key={`${form.mode}-${form.billId ?? 'new'}`}
            mode={form.mode}
            initial={form.initial}
            accounts={lineAccounts}
            receivedSen={form.receivedSen}
            saving={createBill.isPending || updateBill.isPending}
            onSubmit={submitBill}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};
