// Payment Voucher PDF — the money-out document, printed WITH its evidence.
//
// The owner (2026-09-03): 我发现没有办法 print pv? 我希望可以 print pv include
// ocr 的文件一起 — so this generator does two things no other one does:
//   1. the voucher page itself, with the FOUR-LAYER strip printed as the
//      signature block (Prepared / Checked / Approved carry the recorded name
//      and date; Received by stays blank for the payee's pen);
//   2. the voucher's stored files appended AFTER it (pdf-attach.ts) — the PV
//      page first, then its bills in sort_no order, one PDF out.
//
// Layout follows the unified "Hookka-tidy" family (PI/PO/DO/SI): letterhead
// drawHeader, drawInfoColumns info block, plain B&W table, footer with
// doc no · portal · page n of m. A4 portrait. Layout is my draft on the
// owner's 就你做吧 — he adjusts later.
//
// renderPaymentVoucherInto draws into a shared doc (same contract as
// renderPurchaseInvoiceInto) so the batch screen can put several vouchers in
// ONE file; generatePaymentVoucherPdf finalizes a single voucher, merging its
// attachments when given any.

import {
  COMPANY, DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, amountInWordsMyr,
  deliverPdf, deliverPdfBlob, drawHeader, drawInfoColumns, ensurePdfCjkFont,
  fmtDocDate, fmtRm, safeName, type PdfAction,
} from './pdf-common';
/* The status WORD comes from the one home for it (POSTED prints "Approved" —
   the four-layer vocabulary, docs/modules/document-status-vocabulary.md). */
import { statusLabel } from './status-pill';
import { mergePdfWithAttachments, type PdfAttachment } from './pdf-attach';

export type PvPdfHeader = {
  pv_number: string; status: string; voucher_date: string | null;
  payee_name: string; notes?: string | null;
  currency?: string | null; exchange_rate?: string | number | null;
  credit_account_code: string; total_sen?: number | null;
  supplier?: { code: string; name: string } | null;
  /* The four layers — names as recorded by the approval routes. */
  submitted_at?: string | null; submitted_by?: string | null;
  checked_at?: string | null;   checked_by?: string | null;
  approved_at?: string | null;  approved_by?: string | null;
};
export type PvPdfLine = { description?: string | null; debit_account_code: string; amount_sen: number };
export type PvPdfAllocation = { invoiceNumber: string | null; supplierInvoiceRef: string | null; amountSen: number };

/* account code -> "code · name", from whatever account list the caller has;
   an unknown code prints as itself (never blank — it IS the GL address). */
export type AccountLabeller = (code: string) => string;

/* The four-layer strip: one dashed box per layer, the recorded name + date
   INSIDE the box where a wet signature would go. drawSignatureBoxes is the
   two-box shape; the voucher needs four, so it is drawn here. */
function drawFourLayerStrip(doc: import('jspdf').jsPDF, startY: number, h: PvPdfHeader): number {
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  let ty = startY;
  if (ty > 240) { doc.addPage(); ty = 20; }
  const gap = 5;
  const boxW = (pageW - margin * 2 - gap * 3) / 4;
  const cells = [
    { label: 'Prepared by', who: h.submitted_by ?? null, at: h.submitted_at ?? null },
    { label: 'Checked by',  who: h.checked_by ?? null,   at: h.checked_at ?? null },
    { label: 'Approved by', who: h.approved_by ?? null,  at: h.approved_at ?? null },
    { label: 'Received by', who: null, at: null },
  ];
  cells.forEach((cel, i) => {
    const x = margin + i * (boxW + gap);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(0);
    doc.text(cel.label, x, ty);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.setDrawColor(120);
    doc.rect(x, ty + 2, boxW, 24);
    doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    if (cel.who) doc.text(String(cel.who), x + boxW / 2, ty + 14, { align: 'center', maxWidth: boxW - 4 });
    doc.setTextColor(110);
    doc.text(cel.at ? fmtDocDate(cel.at) : 'Name / Date', x + boxW / 2, ty + 23, { align: 'center' });
    doc.setTextColor(0);
  });
  return ty + 32;
}

/* Draw ONE voucher's content into `doc`. Does NOT make the doc or deliver it —
   the caller finalizes ONCE, so the batch screen can put several vouchers (and
   each one's files) into one combined file. Footer pages run from `startPage`
   for the same reason renderPurchaseInvoiceInto's do. */
export async function renderPaymentVoucherInto(
  doc: import('jspdf').jsPDF,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- autotable fn loosely typed (matches the PI generator)
  autoTable: any,
  header: PvPdfHeader,
  lines: PvPdfLine[],
  allocations: PvPdfAllocation[],
  accountLabel: AccountLabeller,
): Promise<void> {
  await ensurePdfCjkFont(doc, [header, lines, allocations]);

  const startPage = doc.getNumberOfPages();
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const currency = (header.currency ?? 'MYR').toUpperCase();
  const isForeign = currency !== 'MYR';
  const rate = Number(header.exchange_rate ?? 1) || 1;
  const totalSen = Number(header.total_sen ?? 0) || lines.reduce((s, l) => s + Number(l.amount_sen), 0);

  /* An AP Payment IS a payment voucher wearing its settlement — the owner's
     AutoCount vocabulary keeps both under one printed title. */
  let y = drawHeader(doc, {
    docTitle: 'PAYMENT VOUCHER',
    rightMeta: [
      { label: 'PV No', value: header.pv_number },
      { label: 'Date',  value: fmtDocDate(header.voucher_date) },
    ],
  });

  y = drawInfoColumns(doc, y,
    {
      title: 'PAY TO',
      rows: [
        ['Payee', header.payee_name],
        ['Supplier', header.supplier ? `${header.supplier.code} · ${header.supplier.name}` : null],
        ['Note', header.notes ?? null],
      ],
    },
    {
      title: 'VOUCHER DETAILS',
      rows: [
        ['PV No', header.pv_number],
        ['Date', fmtDocDate(header.voucher_date)],
        ['Paid From', accountLabel(header.credit_account_code)],
        ['Currency', isForeign ? `${currency} @ ${rate}` : 'MYR'],
        ['Status', statusLabel('pv', header.status)],
      ],
    },
  );

  const rows = lines.map((l, idx) => [
    String(idx + 1),
    l.description?.trim() ? l.description : '—',
    accountLabel(l.debit_account_code),
    fmtRm(Number(l.amount_sen), currency),
  ]);
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Account (Debit)', 'Amount']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 8.5 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 84 },
      2: { cellWidth: 56 },
      3: { cellWidth: 34, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL', totalsX, ty + 3);
  doc.text(fmtRm(totalSen, currency), pageW - margin, ty + 3, { align: 'right' });
  ty += 8;
  if (isForeign) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text('≈ posted to GL', totalsX, ty);
    doc.text(fmtRm(Math.round(totalSen * rate), 'MYR'), pageW - margin, ty, { align: 'right' });
    doc.setTextColor(0);
    ty += 5;
  }

  /* Amount in words — the voucher convention the owner reads in AutoCount.
     MYR only: spelling a yuan figure as RINGGIT would be a false sentence. */
  if (!isForeign) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text(amountInWordsMyr(totalSen), margin, ty, { maxWidth: pageW - margin * 2 });
    ty += 8;
  }

  if (allocations.length > 0) {
    autoTable(doc, {
      startY: ty,
      head: [['Settles invoice', 'Supplier ref', 'Applied']],
      body: allocations.map((a) => [
        a.invoiceNumber ?? '—',
        a.supplierInvoiceRef ?? '—',
        fmtRm(Number(a.amountSen), currency),
      ]),
      theme: 'plain',
      rowPageBreak: 'avoid',
      styles: { ...DOC_TABLE_STYLES, fontSize: 8 },
      headStyles: DOC_TABLE_HEAD_STYLES,
      columnStyles: { 0: { cellWidth: 60 }, 1: { cellWidth: 60 }, 2: { cellWidth: 34, halign: 'right' } },
      margin: { left: margin, right: margin },
    });
    ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? ty) + 6;
  }

  drawFourLayerStrip(doc, ty + 4, header);

  const pageCount = doc.getNumberOfPages();
  for (let p = startPage; p <= pageCount; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(110);
    doc.text(header.pv_number, margin, 290);
    doc.text(`${COMPANY.portalLabel} · ${fmtDocDate(header.voucher_date)}`, pageW / 2, 290, { align: 'center' });
    doc.text(`Page ${p} of ${pageCount}`, pageW - margin, 290, { align: 'right' });
    doc.setTextColor(0);
  }
}

/* Single voucher → its own file; attachments (when given) merge AFTER the
   voucher page, in the order handed in (= sort_no = attach order). */
export async function generatePaymentVoucherPdf(
  header: PvPdfHeader,
  lines: PvPdfLine[],
  allocations: PvPdfAllocation[],
  accountLabel: AccountLabeller,
  opts?: { action?: PdfAction; attachments?: PdfAttachment[] },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await renderPaymentVoucherInto(doc, autoTable, header, lines, allocations, accountLabel);
  const fileName = `${header.pv_number}-${safeName(header.payee_name)}.pdf`;
  const attachments = opts?.attachments ?? [];
  if (attachments.length === 0) {
    deliverPdf(doc, fileName, opts?.action);
    return;
  }
  const merged = await mergePdfWithAttachments(doc.output('arraybuffer'), attachments);
  deliverPdfBlob(new Blob([merged as unknown as BlobPart], { type: 'application/pdf' }), fileName, opts?.action);
}
