// ----------------------------------------------------------------------------
// supplier-bills-print — Money out › Supplier bills on paper (the owner's
// Claude Design, batch 4 step 8). The ticked rows — or one row, or the bill
// page — print as ONE document in the order given: an AP bill (or a
// supplier's debit note) as the AP BILL (ap-bill-pdf.ts), a purchase invoice
// as Procurement prints it (purchase-invoice-pdf.ts), a supplier credit note
// as the CN / DN page prints it (credit-note-pdf.ts).
//
// With files, each document's stored files follow its page — the voucher
// print's door (PaymentVouchers.tsx printVouchers): every document renders as
// its own jsPDF, the Worker appends the files where they live
// (POST /ap-invoices/print-bundle) and hands back one PDF. Without files
// nothing needs the Worker: one shared jsPDF, a fresh page per document.
//
// Each document is read fresh at print time; one that cannot be read fails
// the whole print with its number — a print quietly missing a document is the
// dishonest branch. Reached only through import(), so jsPDF and the
// generators stay out of the first load.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { authedFetch } from './authed-fetch';
import { deliverPdfBlob, ensurePdfCjkFont, type PdfAction } from './pdf-common';
import { renderApBillInto, type AccountNamer, type ApBillPdfData } from './ap-bill-pdf';
import { renderCreditNoteInto, type CreditNotePdfHeader, type CreditNotePdfLine } from './credit-note-pdf';
import { renderPurchaseInvoiceInto } from './purchase-invoice-pdf';
import { pdfBytesToBase64 } from './payment-voucher-pdf';
import { fetchPrintBundle } from './payment-voucher-queries';
import { PDF_COMPRESS } from './pdf-options';

/** One paper to print: what it is, its id, and its number (the file's name, and the refusal's). */
export type BillPrintDoc = { kind: 'API' | 'PI' | 'SCN'; id: string; number: string };

/* The print's namer reads the UNFILTERED chart — an old bill on a now-inactive
   account must still print that account's name. */
const chartNames = async (): Promise<AccountNamer> => {
  const r = await authedFetch<{ accounts: Array<{ account_code: string; account_name: string }> }>('/accounting/accounts');
  const names = new Map(r.accounts.map((a) => [a.account_code, a.account_name]));
  return (code) => names.get(code) ?? null;
};

/** Read one paper fresh and draw it into `doc` — on the page `doc` is at. */
async function renderPaper(doc: jsPDF, d: BillPrintDoc, nameOf: AccountNamer): Promise<void> {
  try {
    switch (d.kind) {
      case 'API': {
        const detail = await authedFetch<ApBillPdfData>(`/ap-invoices/${encodeURIComponent(d.id)}`);
        await renderApBillInto(doc, autoTable, detail, nameOf);
        return;
      }
      case 'SCN': {
        const { note, lines } = await authedFetch<{ note: CreditNotePdfHeader; lines: CreditNotePdfLine[] }>(`/credit-notes/${encodeURIComponent(d.id)}`);
        /* The note's own print embeds no CJK face; a supplier's Chinese name must not print as mojibake here. */
        await ensurePdfCjkFont(doc, [note, lines]);
        renderCreditNoteInto(doc, autoTable, note, lines, nameOf);
        return;
      }
      case 'PI': {
        const { purchaseInvoice, items } = await authedFetch<{ purchaseInvoice: unknown; items: unknown[] }>(`/purchase-invoices/${encodeURIComponent(d.id)}`);
        type A = Parameters<typeof renderPurchaseInvoiceInto>;
        await renderPurchaseInvoiceInto(doc, autoTable, purchaseInvoice as A[2], items as A[3]);
        return;
      }
    }
  } catch (e) {
    throw new Error(`${d.number} could not be printed — ${e instanceof Error ? e.message : 'something went wrong.'}`);
  }
}

/** Print the papers in the order given as ONE file; with files, each one's stored files follow its page. */
export async function printSupplierBills(docs: BillPrintDoc[], opts: { withFiles: boolean; action: PdfAction }): Promise<void> {
  if (docs.length === 0) return;
  const nameOf = await chartNames();
  const fileName = docs.length === 1 ? `${docs[0]!.number}.pdf` : 'supplier-bills.pdf';

  /* A purchase invoice keeps no files here, so a print of nothing else has none to fetch. */
  if (!opts.withFiles || docs.every((d) => d.kind === 'PI')) {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
    for (const [i, d] of docs.entries()) {
      if (i > 0) doc.addPage();
      await renderPaper(doc, d, nameOf);
    }
    deliverPdfBlob(doc.output('blob'), fileName, opts.action);
    return;
  }

  const parts: Array<{ kind: BillPrintDoc['kind']; id: string; pageBase64: string }> = [];
  for (const d of docs) {
    const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
    await renderPaper(doc, d, nameOf);
    parts.push({ kind: d.kind, id: d.id, pageBase64: pdfBytesToBase64(doc.output('arraybuffer')) });
  }
  deliverPdfBlob(await fetchPrintBundle('/ap-invoices/print-bundle', parts), fileName, opts.action);
}
