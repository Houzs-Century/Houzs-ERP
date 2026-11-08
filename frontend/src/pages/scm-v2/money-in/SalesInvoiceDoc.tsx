// ----------------------------------------------------------------------------
// SalesInvoiceDoc — /scm/ar-invoices/sales/:id, a sales invoice read from
// Sales (the owner's Claude Design, batch 5 §8; it was a pop-out over the AR
// invoices list). Raised, edited and cancelled in Sales — this page only reads:
// who it bills, its dates and order, the order's deposit applied to it, the
// credit notes knocked off it (owner 2026-11-03: 「要」) and those closing its
// deposits, what is paid and outstanding, its lines, its journal, and the page
// as it prints, with Print, Save PDF and `Open in Sales`.
// ----------------------------------------------------------------------------

import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useSalesInvoiceDetail } from '../../../vendor/scm/lib/sales-invoice-queries';
import { useSalesInvoiceCreditNotes, type SalesInvoiceCreditNote } from '../../../vendor/scm/lib/ar-invoice-queries';
import { siCreditNotesSen, siOutstandingSen } from '../../../vendor/scm/lib/si-outstanding';
import { FinanceDocLink } from '../finance/FinanceDocLink';
import type { SiHeader, SiItem } from '../../../vendor/scm/lib/sales-invoice-pdf';
import { useAccounts } from '../../../vendor/scm/lib/accounting-queries';
import type { PdfAction } from '../../../vendor/scm/lib/pdf-common';
import { fmtDate, fmtSen, todayMY } from '../../../vendor/shared/format';
import { DataTable, type Column } from '../../../components/DataTable';
import {
  DocBooks, DocSection, DocState, MoneyInDocPage, PaperPreview, byTime, journalTrail, personOf,
  type DocFact, type TrailStep,
} from './MoneyInDocPage';
import { useDocJournals } from './moneyInDocQueries';
import { salesInvoiceTag } from './moneyInStatus';
import { moneyInDocHref } from './moneyInDocs';
import ui from '../MoneyIn.module.css';
import s from './MoneyInDoc.module.css';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

type Header = SiHeader & { id?: string; created_at?: string | null; created_by?: string | null };

/* The notes on it (the design's Credit notes section): each knock-off, and each
   close-out of its order's deposit invoices — said for what it is, the deposit
   having lowered the invoice already. */
const NOTE_COLUMNS: Column<SalesInvoiceCreditNote>[] = [
  { key: 'note', label: 'Note', getValue: (n) => n.number, render: (n) => <FinanceDocLink to={moneyInDocHref('note', n.id)}>{n.number}</FinanceDocLink> },
  { key: 'date', label: 'Date', render: (n) => <span className={ui.muted}>{fmtDate(n.date)}</span>, getValue: (n) => n.date ?? '' },
  { key: 'what', label: 'What', width: '320px', render: (n) => <span className={ui.muted}>{n.what}</span>, getValue: (n) => n.what },
  {
    key: 'knocked_off', label: 'Knocked off', align: 'right', render: (n) => <span className={ui.money}>{fmtSen(n.amountSen)}</span>, getValue: (n) => n.amountSen,
    total: (rows) => fmtSen(rows.reduce((s2, n) => s2 + n.amountSen, 0)),
  },
];

const LINE_COLUMNS: Column<SiItem>[] = [
  { key: 'item', label: 'Item', render: (l) => l.item_code, getValue: (l) => l.item_code },
  { key: 'description', label: 'Description', width: '320px', render: (l) => l.description ?? '—', getValue: (l) => l.description ?? '' },
  { key: 'qty', label: 'Qty', align: 'right', render: (l) => String(l.qty), getValue: (l) => l.qty },
  { key: 'price', label: 'Unit price', align: 'right', render: (l) => fmtSen(l.unit_price_sen), getValue: (l) => l.unit_price_sen },
  { key: 'amount', label: 'Amount', align: 'right', render: (l) => fmtSen(l.line_total_sen), getValue: (l) => l.line_total_sen },
];

export const SalesInvoiceDoc = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const q = useSalesInvoiceDetail(id || null);
  const header = q.data?.salesInvoice as Header | undefined;
  const items = q.data?.items as SiItem[] | undefined;
  const journals = useDocJournals('SI', header?.invoice_number);
  const notesQ = useSalesInvoiceCreditNotes(id || null);
  const accountsQ = useAccounts();
  const [printing, setPrinting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const accountName = useMemo(() => {
    const names = new Map((accountsQ.data?.accounts ?? []).map((a) => [a.account_code, a.account_name]));
    return (code: string): string | null => names.get(code) ?? null;
  }, [accountsQ.data]);
  const draw = useMemo(() => (header && items
    ? () => import('../../../vendor/scm/lib/sales-invoice-pdf').then(({ salesInvoicePdfBlob }) => salesInvoicePdfBlob(header, items))
    : null), [header, items]);

  if (!header || !items) return <DocState kind="salesInvoice" loading={q.isLoading} error={q.error} />;

  const deliver = async (action: PdfAction) => {
    if (printing) return;
    setPrinting(true); setFailure(null);
    try {
      const { generateSalesInvoicePdf } = await import('../../../vendor/scm/lib/sales-invoice-pdf');
      await generateSalesInvoicePdf(header, items, { action });
    } catch (e) { setFailure(errText(e)); } finally { setPrinting(false); }
  };

  /* The AR list's own figures: paid = the invoice's receipts plus the order's
     deposit applied; the credit notes knocked off it apart; outstanding = what
     is left (backend ar-invoices.ts shapeSi). */
  const total = Number(header.total_sen);
  const own = Number(header.paid_sen);
  const deposit = Number(header.so_deposit_applied_sen ?? 0);
  const credited = siCreditNotesSen(header);
  const outstanding = siOutstandingSen(total, own, deposit, credited);
  const today = todayMY();
  const due = String(header.due_date ?? '').slice(0, 10);
  const late = outstanding > 0 && due !== '' && due < today;
  const facts: DocFact[] = [
    { label: 'Invoice date', value: fmtDate(header.invoice_date) },
    { label: 'Due date', value: due ? fmtDate(due) : '—', tone: late ? 'late' : null },
    { label: 'Sales order', value: header.so_doc_no ?? '—', to: header.so_doc_no ? `/scm/sales-orders/${encodeURIComponent(header.so_doc_no)}` : null },
    { label: 'Deposit applied', value: deposit > 0 ? fmtSen(deposit) : '—', title: deposit > 0 ? `${fmtSen(deposit)} was collected on ${header.so_doc_no ?? 'the sales order'} and settles this invoice.` : undefined },
    { label: 'Credit notes', value: credited > 0 ? fmtSen(credited) : '—', title: credited > 0 ? `${fmtSen(credited)} was knocked off this invoice by credit notes.` : undefined },
    { label: 'Paid', value: fmtSen(own) },
    { label: 'Outstanding', value: fmtSen(outstanding), tone: outstanding > 0 ? 'brass' : null },
  ];
  const trail: TrailStep[] = byTime([
    ...(header.created_at ? [{ key: 'raised', act: 'Raised in Sales', who: personOf(header.created_by), when: header.created_at }] : []),
    ...journalTrail(journals.data),
  ]);
  const cityLine = [header.postcode, header.city].filter(Boolean).join(' ');

  return (
    <MoneyInDocPage
      kind="salesInvoice" kindLabel="Sales invoice" number={header.invoice_number}
      tag={salesInvoiceTag({ outstandingSen: outstanding, paidSen: own + deposit + credited, dueDate: header.due_date, status: header.status }, today)}
      sub="raised in Sales · edit or cancel it there"
      taskLink={{ type: 'Sales invoice', no: header.invoice_number, name: header.debtor_name, to: moneyInDocHref('salesInvoice', id) }}
      printJob={{
        /* f4: Sales' own print — the paper the customer gets does not change. */
        title: 'Sales invoice', docNo: header.invoice_number, papers: ['A4'],
        rows: [{ label: 'Bill to', value: header.debtor_name }, { label: 'Amount', value: fmtSen(total) }],
        deliver,
      }}
      printing={printing}
      actions={[{ label: 'Open in Sales', onClick: () => navigate(`/scm/sales-invoices/${encodeURIComponent(id)}`) }]}
      notice={failure ? <div role="alert" className={`${s.note} ${s.toneLate}`}>The invoice was not printed — {failure}</div> : null}
      party={{
        label: 'Bill to', name: header.debtor_name,
        lines: [header.debtor_code, header.address1, header.address2, cityLine, header.state, [header.phone, header.email].filter(Boolean).join(' · ')],
      }}
      amount={{ label: 'Amount', value: fmtSen(total), sub: outstanding > 0 ? `${fmtSen(outstanding)} outstanding` : null }}
      facts={facts}
      books={<DocBooks journals={journals.data} loading={journals.isLoading} accountName={accountName} />}
      trail={trail}
    >
      <DocSection title="Lines">
        <DataTable<SiItem> tableId="mi-si-lines" embedded columns={LINE_COLUMNS} rows={items} getRowKey={(l) => `${l.item_code}-${items.indexOf(l)}`}
          emptyLabel="No lines on this invoice." />
      </DocSection>
      <DocSection title="Credit notes">
        {notesQ.isLoading ? <div className={s.empty}>Reading the credit notes…</div>
          : notesQ.isError ? <div role="alert" className={`${s.empty} ${s.toneLate}`}>The credit notes did not load — {errText(notesQ.error)}</div>
            : (notesQ.data?.creditNotes ?? []).length === 0 ? <div className={s.empty}>No credit note knocks this invoice off.</div>
              : <DataTable<SalesInvoiceCreditNote> tableId="mi-si-notes" embedded columns={NOTE_COLUMNS} rows={notesQ.data?.creditNotes ?? []} getRowKey={(n) => n.id} />}
      </DocSection>
      <DocSection title="As printed" buttons={(
        <button type="button" className={`${ui.btn} ${ui.btnSmall}`} onClick={() => void deliver('save')} disabled={printing}>Save PDF</button>
      )}>
        <PaperPreview title={`Sales invoice ${header.invoice_number} as printed`} draw={draw} />
      </DocSection>
    </MoneyInDocPage>
  );
};
