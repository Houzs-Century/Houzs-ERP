// ----------------------------------------------------------------------------
// ap-invoice-listing-pdf — "Print listing" for the Finance supplier-invoice
// list (owner 2026-09-06: print listing 功能我也想要 — AutoCount's A/P Invoice
// Listing). It prints WHAT THE SCREEN SHOWS: the rows left after the kind and
// supplier filters, in list order, with the three money columns totalled —
// so the paper and the screen can never disagree. Landscape A4 on the shared
// letterhead; the table is the same autoTable dress every document wears.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, fmtRm, type PdfAction,
} from './pdf-common';
import type { ApListRow } from './ap-invoice-queries';
import { todayMyt } from './dates';
import { PDF_COMPRESS } from './pdf-options';

/** `showing`: the filter in words, as the page has it ("AP bills · All suppliers · Unpaid"). */
export type ApListingFilter = { showing: string };

/** One printed row — an AP bill, a purchase invoice or a supplier credit note
    (Money out › Supplier bills, the redesign); the page decides the words. */
export type ApListingRow = {
  kindWord: string; number: string; supplierName: string | null; supplierCode: string | null;
  /** The control it sits on: 400 or 405. */
  control: string;
  ref: string | null; date: string | null; due: string | null; planned: string | null; description: string | null;
  currency: string; totalSen: number; paidSen: number;
  /** Blank on a draft, a cancelled bill and a credit note. */
  outstandingSen: number | null;
  status: string;
};

/** A supplier debit-note list row as printed (the CN / DN page's Debit notes view). */
export const listingRowOfAp = (r: ApListRow): ApListingRow => ({
  kindWord: r.kind === 'PI' ? 'Purchase invoice' : r.docKind === 'DN' ? 'Debit note' : 'AP bill',
  number: r.invoiceNumber, supplierName: r.supplierName, supplierCode: r.supplierCode,
  control: r.controlRole === 'AP_OTHER' ? '405' : r.controlRole === 'AP' ? '400' : '',
  ref: r.supplierInvoiceRef, date: r.invoiceDate, due: r.dueDate, planned: null, description: r.description,
  currency: r.currency, totalSen: r.totalSen, paidSen: r.paidSen,
  outstandingSen: r.status === 'DRAFT' || r.status === 'CANCELLED' ? null : r.outstandingSen, status: r.status,
});

export const AP_LISTING_HEAD = ['Kind', 'No.', 'Supplier', 'Control', 'Ref', 'Date', 'Due', 'Planned', 'Description', 'Total', 'Paid', 'Outstanding', 'Status'] as const;

/** The table exactly as drawn — pure, so a test reads the cells and the
    totals without rendering a PDF. */
export function apListingTable(rows: ApListingRow[]): {
  head: readonly string[];
  body: string[][];
  totals: { count: number; totalSen: number; paidSen: number; outstandingSen: number };
} {
  const body = rows.map((r) => [
    r.kindWord,
    r.number,
    `${r.supplierName ?? '—'}${r.supplierCode ? ` (${r.supplierCode})` : ''}`,
    r.control,
    r.ref ?? '',
    fmtDocDate(r.date),
    fmtDocDate(r.due),
    fmtDocDate(r.planned),
    r.description ?? '',
    fmtRm(r.totalSen, r.currency),
    fmtRm(r.paidSen, r.currency),
    r.outstandingSen == null ? '' : fmtRm(r.outstandingSen, r.currency),
    r.status,
  ]);
  const totals = rows.reduce(
    (t, r) => ({ count: t.count + 1, totalSen: t.totalSen + r.totalSen, paidSen: t.paidSen + r.paidSen, outstandingSen: t.outstandingSen + (r.outstandingSen ?? 0) }),
    { count: 0, totalSen: 0, paidSen: 0, outstandingSen: 0 },
  );
  return { head: AP_LISTING_HEAD, body, totals };
}

export async function generateApListingPdf(rows: ApListingRow[], filter: ApListingFilter, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, rows);
  const y = drawHeader(doc, {
    docTitle: 'SUPPLIER BILLS LISTING',
    rightMeta: [
      { label: 'Printed', value: fmtDocStamp() },
      { label: 'Showing', value: filter.showing },
      { label: 'Rows', value: String(rows.length) },
    ],
  });
  const t = apListingTable(rows);
  /* Totals are MYR sums of the sen columns — the list is MYR in this first
     cut (AP invoices are MYR-only; a foreign purchase invoice prints its own
     currency per row and the foot says so). */
  const foreign = rows.some((r) => r.currency !== 'MYR');
  autoTable(doc, {
    startY: y + 2,
    head: [[...t.head]],
    body: t.body,
    foot: [[
      '', '', '', '', '', '', '', '',
      `${t.totals.count} row(s)${foreign ? ' — mixed currencies, sums are of the printed figures' : ''}`,
      fmtRm(t.totals.totalSen), fmtRm(t.totals.paidSen), fmtRm(t.totals.outstandingSen), '',
    ]],
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    /* The foot wears the head's dress — bold, ruled above and below. */
    footStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 20 },
      1: { cellWidth: 30 },
      2: { cellWidth: 42 },
      3: { cellWidth: 12 },
      4: { cellWidth: 20 },
      5: { cellWidth: 18 },
      6: { cellWidth: 18 },
      7: { cellWidth: 18 },
      9: { cellWidth: 22, halign: 'right' },
      10: { cellWidth: 20, halign: 'right' },
      11: { cellWidth: 22, halign: 'right' },
      12: { cellWidth: 20 },
    },
  });
  const stamp = todayMyt();
  deliverPdf(doc, `supplier-bills-listing-${stamp}.pdf`, opts?.action ?? 'preview');
}
