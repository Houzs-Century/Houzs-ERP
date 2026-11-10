// ----------------------------------------------------------------------------
// ap-bill-pdf — the AP BILL print (Money out › Supplier bills in the owner's
// Claude Design, batch 4 step 8). One A4 page per bill, on the payment
// voucher's letterhead and dress (payment-voucher-pdf.ts): the number and the
// date on the right, the supplier with the control it sits on, the supplier's
// invoice no., the due date, what is still outstanding and the journal, the
// lines (account code with its name below, description, amount), the TOTAL in
// figures and in words, and who raised and posted it. A Draft carries a band
// saying it is not on the books yet, a Cancelled one a band saying so — the
// design's two bands. A supplier's debit note is the same paper under its own
// heading, SUPPLIER DEBIT NOTE.
//
// apBillSheet is the page as data — pure, so a test reads every word without
// drawing; renderApBillInto draws it into a shared doc (the voucher's
// contract), so Supplier bills can print several documents, and each one's
// files, as ONE file.
// ----------------------------------------------------------------------------

import { fmtDateTime } from '@2990s/shared';
import { docPageLabel,
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, amountInWordsMyr, drawHeader, ensurePdfCjkFont,
  fmtDocDate, fmtRm,
} from './pdf-common';

/** What the bill page reads (GET /ap-invoices/:id) — only the fields the paper prints. */
export type ApBillPdfData = {
  invoice: {
    invoice_number: string; doc_kind?: 'INV' | 'DN' | null; status: string;
    invoice_date: string | null; due_date: string | null; supplier_invoice_ref: string | null;
    currency?: string | null; total_sen: number; paid_sen: number; notes: string | null;
    je_no?: string | null;
    created_at?: string | null; created_by?: string | null;
    posted_at?: string | null; posted_by?: string | null;
    cancelled_at?: string | null; cancelled_by?: string | null;
  };
  lines: Array<{ description: string | null; debit_account_code: string; amount_sen: number }>;
  supplier: { code: string | null; name: string | null } | null;
  /** The control the bill credits — 400-0000 or 405-0000 by the supplier's code. */
  controlCode?: string | null;
};

/** account code → its name, from the chart (null when the chart does not know it). */
export type AccountNamer = (code: string) => string | null;

export type ApBillSheet = {
  title: string;
  meta: Array<{ label: string; value: string }>;
  /** Draft or Cancelled: the band under the letterhead; null on a posted bill. */
  band: { text: string; tone: 'draft' | 'cancelled' } | null;
  supplier: { name: string; lines: string[] };
  factsTitle: string;
  facts: Array<[string, string]>;
  head: string[];
  body: string[][];
  total: string;
  /** RINGGIT MALAYSIA … ONLY — MYR only; spelling another currency as ringgit would be false. */
  words: string | null;
  stamp: string;
  footerDate: string;
};

/** The page as data: every word the AP BILL prints, in the order it prints. */
export function apBillSheet(d: ApBillPdfData, accountName: AccountNamer): ApBillSheet {
  const inv = d.invoice;
  const dn = inv.doc_kind === 'DN';
  const draft = inv.status === 'DRAFT';
  const cancelled = inv.status === 'CANCELLED';
  const currency = (inv.currency ?? 'MYR').toUpperCase();
  const total = Number(inv.total_sen);
  const outstanding = Math.max(0, total - Number(inv.paid_sen));
  const supplierName = d.supplier?.name?.trim() || '—';
  const controlName = d.controlCode ? accountName(d.controlCode) : null;

  /* Who raised it, who posted it, who cancelled it — the stamps the bill keeps.
     The raise stamp keeps the signed-in account's id, not a name: an id never
     prints as a person, so that stamp says when only. */
  const personOf = (who: string | null | undefined): string | null => {
    const w = who?.trim() ?? '';
    return w === '' || /^\d+$/.test(w) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(w) ? null : w;
  };
  const stampOf = (what: string, who: string | null | undefined, at: string | null | undefined): string | null => {
    if (!at) return null;
    const person = personOf(who);
    return `${what}${person ? ` by ${person}` : ''} ${fmtDateTime(at)}`;
  };

  return {
    title: dn ? 'SUPPLIER DEBIT NOTE' : 'AP BILL',
    meta: [
      { label: 'No', value: inv.invoice_number },
      { label: dn ? 'Note date' : 'Invoice date', value: fmtDocDate(inv.invoice_date) },
    ],
    band: draft ? { text: 'DRAFT · not posted to the ledger', tone: 'draft' }
      : cancelled ? { text: inv.je_no ? 'CANCELLED · its journal was reversed' : 'CANCELLED · never posted', tone: 'cancelled' }
        : null,
    supplier: {
      name: supplierName,
      lines: [
        [d.supplier?.code ? d.supplier.code : null, d.controlCode ? `Control ${d.controlCode}` : null].filter(Boolean).join(' · '),
        controlName ?? '',
      ].filter((l) => l !== ''),
    },
    factsTitle: dn ? 'NOTE DETAILS' : 'BILL DETAILS',
    facts: [
      [dn ? 'Supplier’s debit note no.' : 'Supplier’s invoice no.', inv.supplier_invoice_ref?.trim() || '—'],
      ['Due date', fmtDocDate(inv.due_date)],
      ['Outstanding', draft || cancelled ? '—' : fmtRm(outstanding, currency)],
      ['Journal', inv.je_no ?? (cancelled ? 'Never posted' : 'Written when posted')],
      ...(inv.notes?.trim() ? [['Description', inv.notes.trim()] as [string, string]] : []),
    ],
    head: ['Account', 'Description', 'Amount (RM)'],
    /* The account as the owner reads it: the code on one line, its name below. */
    body: d.lines.map((l) => {
      const name = accountName(l.debit_account_code);
      return [name ? `${l.debit_account_code}\n${name}` : l.debit_account_code, l.description?.trim() || '—', fmtRm(Number(l.amount_sen), currency)];
    }),
    total: fmtRm(total, currency),
    words: currency === 'MYR' ? amountInWordsMyr(total) : null,
    stamp: [stampOf('Created', inv.created_by, inv.created_at), stampOf('Posted', inv.posted_by, inv.posted_at), stampOf('Cancelled', inv.cancelled_by, inv.cancelled_at)]
      .filter(Boolean).join(' · '),
    footerDate: fmtDocDate(inv.invoice_date),
  };
}

/* The design's bands: warn for a draft, late for a cancelled bill. */
const BAND_TONE: Record<'draft' | 'cancelled', { fill: [number, number, number]; line: [number, number, number]; ink: [number, number, number] }> = {
  draft: { fill: [247, 241, 227], line: [229, 214, 179], ink: [122, 90, 30] },
  cancelled: { fill: [251, 238, 238], line: [229, 196, 196], ink: [168, 52, 52] },
};

type JsPdf = import('jspdf').jsPDF;

/** SUPPLIER on the left, the bill's facts on the right — the voucher's info
    block in its type sizes, with the facts' labels measured so a long label
    never runs into its value, and every value wrapped to its column. */
function drawSupplierAndFacts(doc: JsPdf, startY: number, s: ApBillSheet): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const midX = pageW / 2 + 2;
  const leftW = midX - margin - 6;
  const rightW = pageW - margin - midX;

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(95);
  doc.text('SUPPLIER', margin, startY);
  doc.text(s.factsTitle, midX, startY);
  doc.setTextColor(0);

  let ly = startY + 5.5;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  const nameLines = doc.splitTextToSize(s.supplier.name, leftW) as string[];
  doc.text(nameLines, margin, ly);
  ly += nameLines.length * 4.8;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  for (const line of s.supplier.lines) {
    const wrapped = doc.splitTextToSize(line, leftW) as string[];
    doc.text(wrapped, margin, ly);
    ly += wrapped.length * 4;
  }

  let ry = startY + 5;
  doc.setFontSize(8.5);
  const labelW = Math.max(...s.facts.map(([label]) => doc.getTextWidth(label))) + 4;
  for (const [label, value] of s.facts) {
    doc.setFont('helvetica', 'normal'); doc.setTextColor(110);
    doc.text(label, midX, ry);
    doc.setTextColor(0); doc.setFont('helvetica', 'bold');
    const wrapped = doc.splitTextToSize(value, Math.max(20, rightW - labelW)) as string[];
    doc.text(wrapped, midX + labelW, ry);
    ry += Math.max(1, wrapped.length) * 4;
  }
  doc.setFont('helvetica', 'normal');
  return Math.max(ly, ry) + 3;
}

/* Draw ONE bill into `doc`. Does NOT make the doc or deliver it — the caller
   finalises once, so Supplier bills can put several documents (and each
   one's files) into one file. Footer pages run from `startPage` for the same
   reason the voucher's do. */
export async function renderApBillInto(
  doc: JsPdf,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- autotable fn loosely typed (matches the voucher generator)
  autoTable: any,
  d: ApBillPdfData,
  accountName: AccountNamer,
): Promise<void> {
  const s = apBillSheet(d, accountName);
  await ensurePdfCjkFont(doc, [s.title, s.meta, s.supplier, s.facts, s.body, s.stamp]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  let y = drawHeader(doc, { docTitle: s.title, rightMeta: s.meta });

  if (s.band) {
    const tone = BAND_TONE[s.band.tone];
    doc.setFillColor(...tone.fill); doc.setDrawColor(...tone.line); doc.setLineWidth(0.25);
    doc.roundedRect(margin, y - 1, pageW - margin * 2, 8, 1, 1, 'FD');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...tone.ink);
    doc.text(s.band.text, margin + 3, y + 4.2);
    doc.setTextColor(0); doc.setDrawColor(0); doc.setLineWidth(0.2);
    y += 11;
  }

  /* The design's heavy rule over the supplier and the facts. */
  doc.setDrawColor(0); doc.setLineWidth(0.4);
  doc.line(margin, y, pageW - margin, y);
  doc.setLineWidth(0.2);
  y = drawSupplierAndFacts(doc, y + 5, s);

  autoTable(doc, {
    startY: y,
    head: [s.head],
    body: s.body,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 52 },
      2: { cellWidth: 34, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;
  if (ty > 262) { doc.addPage(); ty = 20; }

  const totalsX = pageW - margin - 70;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL', totalsX, ty + 3);
  doc.text(s.total, pageW - margin, ty + 3, { align: 'right' });
  ty += 9;
  if (s.words) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    const words = doc.splitTextToSize(s.words, pageW - margin * 2) as string[];
    doc.text(words, margin, ty);
    ty += words.length * 4;
  }

  if (s.stamp) {
    ty += 10;
    if (ty > 276) { doc.addPage(); ty = 20; }
    doc.setDrawColor(190); doc.line(margin, ty - 4, pageW - margin, ty - 4);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(95);
    doc.text(doc.splitTextToSize(s.stamp, pageW - margin * 2) as string[], margin, ty);
    doc.setTextColor(0); doc.setDrawColor(0);
  }

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(d.invoice.invoice_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${s.footerDate}`, pageW / 2, 290, { align: 'center' });
    doc.text(docPageLabel(p, startPage, pageCount), pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
  doc.setPage(pageCount);
}
