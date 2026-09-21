// ----------------------------------------------------------------------------
// debtor-bill-pdf — the Other Debtor bill print (owner 2026-09-18: 需要打印功能
// — the invoice he hands a party outside the trade: 开和生意性质没有关系的
// invoice 给其他人). The paper the other side receives is an INVOICE: the
// letterhead, the number and date on the right, BILL TO (the debtor from the
// registry) beside the invoice details (amount, received, balance due,
// status), the lines as the reader needs them — a description and an amount,
// never our account codes — the total, the amount in words, the bill's note,
// an issued-by box. A CANCELLED bill prints with a diagonal CANCELLED
// watermark, so a voided paper can never pass for a live one. A4 portrait,
// the payment voucher's shape; the CJK font rides along for a Chinese name
// or description.
// ----------------------------------------------------------------------------

import {
  DOC_TABLE_HEAD_STYLES, DOC_TABLE_STYLES, amountInWordsMyr, deliverPdf, drawHeader, drawInfoColumns, drawPaymentDetails, drawSignatureBoxes,
  drawTermsBlock, ensurePdfCjkFont, fmtDocDate, fmtRm, safeName, type PdfAction,
} from './pdf-common';
import { getBrandingCache } from '../../../lib/branding';
import type { DebtorBill, OtherDebtor } from './accounting-queries';
import { partyAddressLines, type DebtorPartyColumns } from './debtor-party';

export type DebtorBillPdfData = {
  bill: DebtorBill;
  /** The registry row: the name and phone, and the party's data where filled (2026-09-21) — BILL TO prints what is there. */
  debtor: Pick<OtherDebtor, 'name' | 'phone'> & Partial<DebtorPartyColumns>;
  /** The chart's name for a line's account — the fallback description of a line left blank. */
  accountName?: (code: string) => string | null | undefined;
};

type JsPdf = import('jspdf').jsPDF;
type AutoTable = (doc: JsPdf, options: Record<string, unknown>) => void;

/** What the paper says about where the money stands. */
export const billStatusWord = (b: Pick<DebtorBill, 'status' | 'total_sen' | 'received_sen'>): string => {
  if (b.status === 'CANCELLED') return 'Cancelled';
  const received = Number(b.received_sen);
  if (b.total_sen > 0 && received >= b.total_sen) return 'Paid';
  if (received > 0) return 'Partly paid';
  return 'Unpaid';
};

/** Draw one bill onto the CURRENT page of `doc` (A4 portrait). */
export async function renderDebtorBillInto(doc: JsPdf, autoTable: AutoTable, d: DebtorBillPdfData): Promise<void> {
  await ensurePdfCjkFont(doc, [d.bill, d.debtor]);
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const lines = d.bill.lines ?? [];
  const totalSen = Number(d.bill.total_sen) || lines.reduce((s, l) => s + Number(l.amount_sen), 0);
  const receivedSen = Number(d.bill.received_sen);
  const dueSen = Math.max(0, totalSen - receivedSen);

  let y = drawHeader(doc, {
    docTitle: 'INVOICE',
    rightMeta: [
      { label: 'Invoice No', value: d.bill.bill_number },
      { label: 'Date', value: fmtDocDate(d.bill.bill_date) },
    ],
  });

  y = drawInfoColumns(doc, y,
    {
      title: 'BILL TO',
      rows: [
        ['Name', d.debtor.name],
        /* The address as the registry holds it; a blank label keeps the continuation lines under the first. */
        ...partyAddressLines(d.debtor).map((line, i): [string, string] => [i === 0 ? 'Address' : ' ', line]),
        ['Attention', d.debtor.attention || d.debtor.contact_person || null],
        ['Phone', [d.debtor.phone, d.debtor.mobile].filter((s) => s && s.trim()).join(' / ') || null],
        ['Email', d.debtor.email ?? null],
        ['TIN', d.debtor.tin_number ?? null],
        ['Reg No', d.debtor.business_reg_no ?? null],
      ],
    },
    {
      title: 'INVOICE DETAILS',
      rows: [
        ['Invoice No', d.bill.bill_number],
        ['Date', fmtDocDate(d.bill.bill_date)],
        ['Amount', fmtRm(totalSen)],
        ['Received', fmtRm(receivedSen)],
        ['Balance due', fmtRm(dueSen)],
        ['Status', billStatusWord(d.bill)],
      ],
    },
  );

  /* The reader's view of a line: what it was for and how much — our account
     is the bookkeeping behind it and stays off the paper. */
  /* A TEXT line (no account, amount zero) is words alone — no number, no amount; the money lines count on. */
  let n = 0;
  const rows = lines.map((l) => {
    if (l.credit_account_code == null && Number(l.amount_sen) === 0) return ['', l.description ?? '', ''];
    n += 1;
    return [
      String(n),
      l.description?.trim() ? l.description : (l.credit_account_code ? (d.accountName?.(l.credit_account_code) ?? '—') : '—'),
      fmtRm(Number(l.amount_sen)),
    ];
  });
  autoTable(doc, {
    startY: y,
    head: [['#', 'Description', 'Amount']],
    body: rows,
    theme: 'plain',
    rowPageBreak: 'avoid',
    styles: { ...DOC_TABLE_STYLES, fontSize: 9 },
    headStyles: DOC_TABLE_HEAD_STYLES,
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 36, halign: 'right' },
    },
    margin: { left: margin, right: margin },
  });
  let ty = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 6;

  const totalsX = pageW - margin - 70;
  doc.setDrawColor(0); doc.line(totalsX, ty - 2, pageW - margin, ty - 2);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  doc.text('TOTAL', totalsX, ty + 3);
  doc.text(fmtRm(totalSen), pageW - margin, ty + 3, { align: 'right' });
  ty += 8;
  if (receivedSen > 0) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(80);
    doc.text('Received', totalsX, ty);
    doc.text(fmtRm(receivedSen), pageW - margin, ty, { align: 'right' });
    ty += 5;
    doc.setFont('helvetica', 'bold'); doc.setTextColor(0);
    doc.text('BALANCE DUE', totalsX, ty);
    doc.text(fmtRm(dueSen), pageW - margin, ty, { align: 'right' });
    ty += 6;
  }
  doc.setTextColor(0);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('RINGGIT (IN WORDS)', margin, ty);
  doc.setFont('helvetica', 'normal');
  doc.text(amountInWordsMyr(totalSen), margin, ty + 4, { maxWidth: pageW - margin * 2 });
  ty += 10;

  if (d.bill.notes?.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('NOTE', margin, ty);
    doc.setFont('helvetica', 'normal');
    doc.text(d.bill.notes, margin, ty + 4, { maxWidth: pageW - margin * 2 });
    ty += 10;
  }

  /* Where to pay and on what terms (owner 2026-09-21: 不然别人不知道要还哪里):
     the OTHER DEBTOR set from Settings › Branding — a different account from
     the customers' — then the terms; a blank setting prints nothing. */
  const brand = getBrandingCache();
  ty = drawPaymentDetails(doc, ty + 2, brand.debtorPaymentDetails);
  ty = drawTermsBlock(doc, ty, brand.debtorInvoiceTerms);

  drawSignatureBoxes(doc, ty + 4, 'Issued by', 'Company chop');

  /* The watermark LAST, over everything: a void invoice must read as void. */
  if (d.bill.status === 'CANCELLED') {
    const pageH = doc.internal.pageSize.getHeight();
    doc.saveGraphicsState();
    doc.setGState(doc.GState({ opacity: 0.14 }));
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(72);
    doc.setTextColor(180, 30, 30);
    doc.text('CANCELLED', pageW / 2, pageH / 2, { align: 'center', angle: 30 });
    doc.restoreGraphicsState();
    doc.setTextColor(0, 0, 0);
  }
}

export async function generateDebtorBillPdf(d: DebtorBillPdfData, opts?: { action?: PdfAction }): Promise<void> {
  const [{ jsPDF }, autoTableModule] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const autoTable = autoTableModule.default as unknown as AutoTable;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  await renderDebtorBillInto(doc, autoTable, d);
  deliverPdf(doc, `${d.bill.bill_number}-${safeName(d.debtor.name)}.pdf`, opts?.action);
}
