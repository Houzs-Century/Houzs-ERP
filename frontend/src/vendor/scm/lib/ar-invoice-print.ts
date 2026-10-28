// ----------------------------------------------------------------------------
// ar-invoice-print — the AR Invoices page's ticked rows as ONE document (owner
// 2026-10-06: ar invoice 点不开、没有办法 print → open a row and print it, or
// tick several and print them together). Each row prints as its own document
// does — a sales invoice as the Sales Invoice print, a debtor bill as the
// debtor-bill print — starting on a page of its own, in the order given.
// ----------------------------------------------------------------------------

import { authedFetch } from './authed-fetch';
import type { ArBillDetail, ArListRow } from './ar-invoice-queries';
import type { SiHeader, SiItem } from './sales-invoice-pdf';

/* How many documents are fetched at once — each read is its own request. */
const FETCH_AT_ONCE = 4;

type SiBundle = { salesInvoice: SiHeader; items: SiItem[] };
type Fetched = { kind: 'SI'; si: SiBundle } | { kind: 'ODB'; bill: ArBillDetail };

const fetchOne = async (r: ArListRow): Promise<Fetched> =>
  r.kind === 'SI'
    ? { kind: 'SI', si: await authedFetch<SiBundle>(`/sales-invoices/${encodeURIComponent(r.id)}`) }
    : { kind: 'ODB', bill: await authedFetch<ArBillDetail>(`/ar-invoices/bills/${encodeURIComponent(r.id)}`) };

/** Every row's document in one PDF, in the rows' order. */
export async function arInvoicesPdfBlob(rows: ArListRow[], accountName: (code: string) => string | null | undefined): Promise<Blob> {
  const fetched: Fetched[] = new Array<Fetched>(rows.length);
  let next = 0;
  const lane = async () => {
    while (next < rows.length) {
      const i = next++;
      fetched[i] = await fetchOne(rows[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, rows.length) }, lane));

  const [{ jsPDF }, autoTableModule, { renderSalesInvoiceInto }, { renderDebtorBillInto }] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), import('./sales-invoice-pdf'), import('./debtor-bill-pdf'),
  ]);
  const autoTable = autoTableModule.default;
  /* The debtor-bill print types its table function narrowly, as its own generator does. */
  const billTable = autoTable as unknown as Parameters<typeof renderDebtorBillInto>[1];
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  for (const [i, f] of fetched.entries()) {
    if (i > 0) doc.addPage('a4', 'portrait');
    if (f.kind === 'SI') {
      await renderSalesInvoiceInto(doc, autoTable, f.si.salesInvoice, f.si.items);
    } else {
      await renderDebtorBillInto(doc, billTable, { bill: f.bill.bill, debtor: f.bill.debtor ?? { name: '(debtor)', phone: null }, accountName });
    }
  }
  return doc.output('blob');
}
