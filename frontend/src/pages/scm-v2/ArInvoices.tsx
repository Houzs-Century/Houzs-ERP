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
// Every row OPENS (owner 2026-10-06: ar invoice 点不开、没有办法 print) — since
// the redesign (owner's Claude Design, batch 5 §8) as the document's own page,
// in its own tab: a debtor bill at /scm/ar-invoices/bills/:id (Print, Copy,
// Edit, Cancel), a sales invoice at /scm/ar-invoices/sales/:id (the page as it
// prints, Print, Save PDF, Open in Sales). Ticked rows print as ONE document,
// each as its own print, in list order (ar-invoice-print.ts).
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Printer } from 'lucide-react';
import { Button } from '@2990s/design-system';
import {
  useAccounts, postableAccounts, useOtherDebtors, useCreateDebtorBill,
  type Account,
} from '../../vendor/scm/lib/accounting-queries';
import { useArInvoices, type ArListKind, type ArListRow } from '../../vendor/scm/lib/ar-invoice-queries';
import { generateArListingPdf } from '../../vendor/scm/lib/ar-invoice-listing-pdf';
import type { PdfAction } from '../../vendor/scm/lib/pdf-common';
import { Modal } from '../../vendor/scm/components/Modal';
import { SearchCombo } from '../../vendor/scm/components/SearchCombo';
import { useAuth as useHouzsAuth } from '../../auth/AuthContext';
import { useNotify } from '../../vendor/scm/components/NotifyDialog';
import { fmtSen, fmtDateOrDash } from '../../vendor/shared/format';
import { useOpenDocInTab } from '../../lib/openDocInTab';
import { FinanceDocLink } from './finance/FinanceDocLink';
import { moneyInDocHref } from './money-in/moneyInDocs';
import styles from './SalesOrderDetail.module.css';
import { PageHeader } from '../../components/Layout';
import { humaniseStatusKey } from '../../vendor/scm/lib/status-pill';
import { DataTable, type Column } from '../../components/DataTable';
import { cancelledDocNoClass, cancelledRowClass } from '../../lib/scm';
import { DebtorBillForm, emptyBillForm, type BillFormSubmit, type BillFormValues } from './DebtorBillForm';

const ICON = { size: 16, strokeWidth: 1.75 } as const;
const myt = (): string => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

const KIND_LABEL: Record<ArListRow['kind'], string> = { SI: 'Sales Invoice', ODB: 'Debtor Bill' };
const soft: React.CSSProperties = { fontSize: 'var(--fs-12)', color: 'var(--fg-muted)' };
const chip = (on: boolean): React.CSSProperties => ({
  padding: '4px 10px', borderRadius: 999, fontSize: 'var(--fs-13)', cursor: 'pointer',
  border: '1px solid var(--c-line, rgba(34,31,32,0.2))',
  background: on ? 'var(--c-ink)' : 'transparent', color: on ? 'var(--c-cream)' : 'var(--c-ink)',
});
const linkBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--c-orange)', fontWeight: 600, cursor: 'pointer', fontSize: 'var(--fs-13)', background: 'none', border: 'none', padding: 0 };

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/* New debtor bill (or debit note) — Edit and Copy live on the bill's own page. */
type FormState = {
  initial: BillFormValues;
  /** The debtor the bill belongs to — picked here. */
  debtorId: string;
  /** A new paper raised as a debit note to the debtor — on the CN / DN page's tab. */
  docKind?: 'DN';
};

/* A debit note to an other debtor (owner 2026-10-28: Customer & Other Debtor CN / DN)
   is a debtor bill of its own kind (series {co}ODN-), received by the same receipts;
   the list calls it so, and `docKind="DN"` is this page narrowed to them, shown on
   the CN / DN page's Other debtor DN tab. */
const kindLabelOf = (r: ArListRow): string => (r.kind === 'ODB' && r.docKind === 'DN' ? 'Debit note' : KIND_LABEL[r.kind]);

/** docKind="DN": the other debtors' debit notes alone, inside the CN / DN page (no page header of its own). */
export const ArInvoices = ({ docKind }: { docKind?: 'DN' } = {}) => {
  const debitNotes = docKind === 'DN';
  const notify = useNotify();
  const openInTab = useOpenDocInTab();
  const { can } = useHouzsAuth();
  const canCreate = can('scm.payment_voucher.create');

  const [kind, setKind] = useState<ArListKind>('ALL');
  const listQ = useArInvoices(debitNotes ? 'ODB' : kind, debitNotes ? 'DN' : undefined);
  const rows = listQ.data?.rows ?? [];
  /* A row opens its document's page in its own tab. */
  const docHref = (r: ArListRow) => moneyInDocHref(r.kind === 'SI' ? 'salesInvoice' : 'debtorBill', r.id);
  const openRow = (r: ArListRow) => openInTab(docHref(r));
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

  /* New debtor bill, in its pop-out over the list (the in-page form comes with batch 5 step 5). */
  const [form, setForm] = useState<FormState | null>(null);
  const openNew = () => setForm({ initial: emptyBillForm(), debtorId: partyFilter.startsWith('D:') ? partyFilter.slice(2) : '', ...(debitNotes ? { docKind: 'DN' as const } : {}) });

  const submitBill = async (values: BillFormSubmit) => {
    if (!form) return;
    try {
      if (!form.debtorId) {
        void notify({ title: 'Pick the debtor', body: 'A bill belongs to one other debtor — pick who owes it before posting.', tone: 'error' });
        return;
      }
      const res = await createBill.mutateAsync({ debtorId: form.debtorId, ...values, ...(form.docKind === 'DN' ? { docKind: 'DN' as const } : {}) });
      setForm(null);
      void notify({
        title: `${res.bill.billNumber} posted`,
        body: `${fmtSen(res.bill.totalSen)} now owing — the GL carries it on 305-0000.`,
        tone: 'info',
      });
    } catch (e) {
      void notify({ title: 'Bill failed', body: e instanceof Error ? e.message : 'Something went wrong.', tone: 'error' });
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
  const arColumns = useMemo<Column<ArListRow>[]>(() => [
    { key: 'kind', label: 'Kind', render: (r) => <span style={{ fontSize: 'var(--fs-11)', fontWeight: 600 }}>{kindLabelOf(r)}</span>, getValue: (r) => kindLabelOf(r) },
    {
      key: 'number', label: 'No.',
      /* Both kinds open the same way the row does — the number reads as the link it is. */
      render: (r) => <span className={cancelledDocNoClass(r.status)}><FinanceDocLink to={docHref(r)}>{r.invoiceNumber}</FinanceDocLink></span>,
      getValue: (r) => r.invoiceNumber,
    },
    {
      key: 'party', label: 'Customer / Debtor',
      render: (r) => <>{r.partyName ?? '—'}{r.partyCode ? <span style={soft}> · {r.partyCode}</span> : null}</>,
      getValue: (r) => r.partyName ?? '',
    },
    { key: 'ref', label: 'Ref', render: (r) => r.ref ?? '—', getValue: (r) => r.ref ?? '' },
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
            <span className="rounded-sm bg-surface-2 px-1 text-[9px] font-semibold uppercase tracking-brand text-ink-muted" style={{ marginLeft: 4 }}>dep</span>
          )}
        </span>
      ),
      getValue: (r) => r.outstandingSen, exportValue: (r) => r.outstandingSen / 100, exportFormat: 'money',
    },
    { key: 'status', label: 'Status', render: (r) => <span style={{ fontSize: 'var(--fs-11)' }}>{humaniseStatusKey(r.status)}</span>, getValue: (r) => r.status },
  ], []);

  const debtorOptions = useMemo(() => activeDebtors.map((d) => ({ value: d.id, label: d.name })), [activeDebtors]);
  const formTitle = form?.docKind === 'DN' ? 'New debit note to an other debtor — 多收 other debtor 的钱' : 'New debtor bill — 明细行自由选户口';

  return (
    <div className="space-y-4">
      {!debitNotes && <PageHeader
        eyebrow="Finance · Money in"
        title="AR invoices"
        actions={canCreate ? (
          <button type="button" onClick={openNew} style={linkBtn}>
            <Plus {...ICON} /> New debtor bill
          </button>
        ) : undefined}
      />}

      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h2 className={styles.cardTitle}>{debitNotes ? 'Debit notes to other debtors — they owe more' : 'Customer invoices — both kinds'}</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {debitNotes && canCreate && (
              <button type="button" onClick={openNew} style={linkBtn}>
                <Plus {...ICON} /> New debit note
              </button>
            )}
            {!debitNotes && ([['ALL', 'All'], ['SI', 'Sales invoices'], ['ODB', 'Debtor bills']] as const).map(([v, label]) => (
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
            tableId={debitNotes ? 'other-debtor-debit-notes' : 'ar-invoices'}
            exportName={debitNotes ? 'other-debtor-debit-notes' : 'ar-invoices'}
            exportXlsx
            columns={arColumns}
            rows={listQ.data ? visibleRows : null}
            loading={listQ.isLoading}
            error={listQ.isError ? `The list could not be loaded — ${listQ.error instanceof Error ? listQ.error.message : 'something went wrong.'}` : null}
            emptyLabel={rows.length > 0
              ? 'No customer invoices match this filter — pick another party or kind.'
              : debitNotes
                ? 'No debit note to an other debtor yet — New debit note raises one; it is received through the Receipts page like a bill.'
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

      {form && (
        <Modal title={formTitle} onClose={() => setForm(null)} ariaLabel={formTitle}>
          <label className={styles.field} style={{ maxWidth: 420, marginBottom: 'var(--space-3)' }}>
            <span className={styles.fieldLabel}>Debtor *</span>
            <SearchCombo options={debtorOptions} value={form.debtorId} onChange={(id) => setForm((prev) => (prev ? { ...prev, debtorId: id } : prev))}
              className={styles.fieldInput} aria-label="Bill debtor" placeholder="— who owes this bill —" />
          </label>
          <DebtorBillForm
            key="new"
            mode="new"
            initial={form.initial}
            accounts={lineAccounts}
            saving={createBill.isPending}
            onSubmit={submitBill}
            onCancel={() => setForm(null)}
          />
        </Modal>
      )}
    </div>
  );
};
