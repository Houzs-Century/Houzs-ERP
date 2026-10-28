// ----------------------------------------------------------------------------
// ar-invoice-listing-pdf — "Print listing" for the Finance customer-invoice
// list (the AP listing's twin, owner 2026-09-29 — AutoCount's A/R Invoice
// Listing). It prints WHAT THE SCREEN SHOWS: the rows left after the kind and
// party filters, in list order, with the three money columns totalled — so
// the paper and the screen can never disagree. Landscape A4 on the shared
// letterhead; the table is the same autoTable dress every document wears.
// ----------------------------------------------------------------------------

import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, deliverPdf, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtDocStamp, fmtRm, type PdfAction,
} from './pdf-common';
import type { ArListKind, ArListRow } from './ar-invoice-queries';

export type ArListingFilter = { kind: ArListKind; partyName?: string | null };

const KIND_WORD: Record<ArListRow['kind'], string> = { SI: 'Sales Invoice', ODB: 'Debtor Bill' };
const SHOWING: Record<ArListKind, string> = { ALL: 'Both kinds', SI: 'Sales invoices', ODB: 'Debtor bills' };

export const AR_LISTING_HEAD = ['Kind', 'No.', 'Customer / Debtor', 'Ref', 'Date', 'Due', 'Description', 'Total', 'Paid', 'Outstanding', 'Status'] as const;

/** The table exactly as drawn — pure, so a test reads the cells and the
    totals without rendering a PDF. */
export function arListingTable(rows: ArListRow[]): {
  head: readonly string[];
  body: string[][];
  totals: { count: number; totalSen: number; paidSen: number; outstandingSen: number };
} {
  const body = rows.map((r) => [
    KIND_WORD[r.kind],
    r.invoiceNumber,
    `${r.partyName ?? '—'}${r.partyCode ? ` (${r.partyCode})` : ''}`,
    r.ref ?? '',
    fmtDocDate(r.invoiceDate),
    fmtDocDate(r.dueDate),
    r.description ?? '',
    fmtRm(r.totalSen, r.currency),
    fmtRm(r.paidSen, r.currency),
    fmtRm(r.outstandingSen, r.currency),
    r.status,
  ]);
  const totals = rows.reduce(
    (t, r) => ({ count: t.count + 1, totalSen: t.totalSen + r.totalSen, paidSen: t.paidSen + r.paidSen, outstandingSen: t.outstandingSen + r.outstandingSen }),
    { count: 0, totalSen: 0, paidSen: 0, outstandingSen: 0 },
  );
  return { head: AR_LISTING_HEAD, body, totals };
}

export async function generateArListingPdf(rows: ArListRow[], filter: ArListingFilter, opts?: { action?: PdfAction }): Promise<void> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  await ensurePdfCjkFont(doc, rows);
  const y = drawHeader(doc, {
    docTitle: 'CUSTOMER INVOICE LISTING',
    rightMeta: [
      { label: 'Printed', value: fmtDocStamp() },
      { label: 'Showing', value: SHOWING[filter.kind] },
      { label: 'Party', value: filter.partyName ?? 'All customers and debtors' },
      { label: 'Rows', value: String(rows.length) },
    ],
  });
  const t = arListingTable(rows);
  /* Totals are MYR sums of the sen columns — a bill is MYR; a foreign sales
     invoice prints its own currency per row and the foot says so. */
  const foreign = rows.some((r) => r.currency !== 'MYR');
  autoTable(doc, {
    startY: y + 2,
    head: [[...t.head]],
    body: t.body,
    foot: [[
      '', '', '', '', '', '',
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
      0: { cellWidth: 24 },
      1: { cellWidth: 34 },
      2: { cellWidth: 50 },
      3: { cellWidth: 28 },
      4: { cellWidth: 20 },
      5: { cellWidth: 20 },
      7: { cellWidth: 24, halign: 'right' },
      8: { cellWidth: 22, halign: 'right' },
      9: { cellWidth: 26, halign: 'right' },
      10: { cellWidth: 26 },
    },
  });
  const stamp = new Date().toISOString().slice(0, 10);
  deliverPdf(doc, `customer-invoice-listing-${stamp}.pdf`, opts?.action ?? 'preview');
}
