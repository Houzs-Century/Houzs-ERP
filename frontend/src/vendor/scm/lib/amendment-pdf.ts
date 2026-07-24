// ----------------------------------------------------------------------------
// Amendment document PDF — ONE client-side template shared by the Sales Order
// amendment and the Purchase Order amendment (owner-approved layout, 2026-07-24).
//
// Houzs has no server-side PDF path (every SO/PO/DO/GRN document is rendered in
// the browser via jsPDF — see purchase-order-pdf.ts / sales-order-pdf.ts), so the
// amendment document is built the SAME way. The operator downloads / prints /
// WhatsApps it themselves; there is no server email.
//
// The document, top to bottom:
//   • Letterhead (HOUZS branding) + title "Sales order amendment" /
//     "Purchase order amendment" + meta (amendment no, issue date, status).
//   • Reference block: original SO/PO doc no, customer / supplier, revision
//     old -> new.
//   • CHANGE TABLE: per line -> item, field, BEFORE (red tint), AFTER (green
//     tint). Added lines show a dash before; removed lines show "Removed" after.
//   • Reason / remark line.
//   • Approval block: requested by + timestamp, approved by + timestamp (or
//     "Pending"), revision no.
//   • Footer: "Supersedes revision N".
//
// NO EMOJI anywhere (owner rule, extends to all product copy).
// ----------------------------------------------------------------------------

import { COMPANY, drawHeader, ensurePdfCjkFont, fmtDocDate, fmtDocStamp } from './pdf-common';

/* One changed line on the amendment. `kind` drives the tint semantics: a CHANGE
   shows before (red) -> after (green); an ADD has no before; a REMOVE has no
   after. `field` is a human label ("Quantity", "Unit price", "Delivery date",
   "Spec", "Line"). */
export type AmendmentChangeRow = {
  item: string;
  field: string;
  before: string;
  after: string;
  kind?: 'ADD' | 'REMOVE' | 'CHANGE';
};

export type AmendmentPdfInput = {
  kind: 'SO' | 'PO';
  amendmentNo: string;
  issueDate: string | null;
  status: string;
  /** Original document number the amendment revises. */
  docNo: string;
  /** 'Customer' for an SO amendment, 'Supplier' for a PO amendment. */
  partyLabel: string;
  partyName: string | null;
  revisionFrom: number;
  revisionTo: number;
  changes: AmendmentChangeRow[];
  reason?: string | null;
  requestedBy?: string | null;
  requestedAt?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
};

// Owner-approved tints (match the change-table mockup): a light red wash on the
// BEFORE value, a light green wash on the AFTER value, each with a darker,
// readable ink. Kept muted so a mono printer still renders them as clean greys.
const RED_FILL: [number, number, number] = [252, 226, 226];
const RED_INK: [number, number, number] = [153, 27, 27];
const GREEN_FILL: [number, number, number] = [220, 244, 226];
const GREEN_INK: [number, number, number] = [22, 101, 52];
const MUTED_INK: [number, number, number] = [120, 120, 120];

const titleFor = (kind: 'SO' | 'PO'): string =>
  kind === 'SO' ? 'Sales order amendment' : 'Purchase order amendment';

export async function generateAmendmentPdf(input: AmendmentPdfInput): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  // CJK-safe: a China supplier's name or a Chinese item description is the likely
  // non-WinAnsi text here. No-op / no fetch for a pure-Latin document.
  await ensurePdfCjkFont(doc, [
    input.partyName, input.reason, input.requestedBy, input.approvedBy,
    ...input.changes.flatMap((r) => [r.item, r.field, r.before, r.after]),
  ]);

  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;

  // ── Header: letterhead + title + meta ────────────────────────────────────
  let y = drawHeader(doc, {
    docTitle: titleFor(input.kind).toUpperCase(),
    rightMeta: [
      { label: 'Amendment No', value: input.amendmentNo || '—' },
      { label: 'Issue Date', value: fmtDocDate(input.issueDate) },
      { label: 'Status', value: input.status || '—' },
    ],
  });

  // ── Reference block: original doc, party, revision old -> new ─────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('REFERENCE', margin, y);
  doc.text('REVISION', pageW / 2, y);
  y += 4;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const refLines = [
    `${input.kind === 'SO' ? 'Sales Order' : 'Purchase Order'} No: ${input.docNo || '—'}`,
    `${input.partyLabel}: ${input.partyName || '—'}`,
  ];
  refLines.forEach((l, i) => doc.text(l, margin, y + i * 5));
  doc.text(`Revision ${input.revisionFrom} → ${input.revisionTo}`, pageW / 2, y);
  y = y + Math.max(refLines.length * 5, 5) + 4;

  doc.setDrawColor(200); doc.line(margin, y, pageW - margin, y);
  y += 6;

  // ── Change table: item | field | before (red) | after (green) ────────────
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('REQUESTED CHANGES', margin, y);
  y += 2;

  const body = input.changes.length > 0
    ? input.changes.map((r) => [r.item || '—', r.field || '—', r.before, r.after])
    : [['—', 'No line changes', '—', '—']];

  autoTable(doc, {
    startY: y + 2,
    head: [['Item', 'Field', 'Before', 'After']],
    body,
    theme: 'grid',
    margin: { left: margin, right: margin },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 58 },
      1: { cellWidth: 34 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 'auto' },
    },
    // BEFORE tinted red, AFTER tinted green — per the owner's mockup. An ADD has
    // no before (muted dash); a REMOVE's after reads "Removed".
    didParseCell: (data: any) => {
      if (data.section !== 'body') return;
      const row = input.changes[data.row.index];
      if (!row) return;
      if (data.column.index === 2) {
        if (row.kind === 'ADD') { data.cell.styles.textColor = MUTED_INK; }
        else { data.cell.styles.fillColor = RED_FILL; data.cell.styles.textColor = RED_INK; }
      }
      if (data.column.index === 3) {
        if (row.kind === 'REMOVE') { data.cell.styles.fillColor = RED_FILL; data.cell.styles.textColor = RED_INK; }
        else { data.cell.styles.fillColor = GREEN_FILL; data.cell.styles.textColor = GREEN_INK; }
      }
    },
  });

  // autotable stashes the final Y on the doc.
  y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 8;

  // ── Reason / remark ───────────────────────────────────────────────────────
  if (input.reason && input.reason.trim()) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('REASON', margin, y);
    y += 5;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const wrapped = doc.splitTextToSize(input.reason.trim(), pageW - margin * 2) as string[];
    doc.text(wrapped, margin, y);
    y += wrapped.length * 5 + 4;
  }

  // ── Approval block ────────────────────────────────────────────────────────
  doc.setDrawColor(200); doc.line(margin, y, pageW - margin, y);
  y += 6;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
  doc.text('APPROVAL', margin, y);
  y += 5;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  const approvedLine = input.approvedBy
    ? `Approved by: ${input.approvedBy}${input.approvedAt ? `  (${fmtDocDate(input.approvedAt)})` : ''}`
    : 'Approved by: Pending';
  const approvalLines = [
    `Requested by: ${input.requestedBy || '—'}${input.requestedAt ? `  (${fmtDocDate(input.requestedAt)})` : ''}`,
    approvedLine,
    `Revision: ${input.revisionFrom} → ${input.revisionTo}`,
  ];
  approvalLines.forEach((l, i) => doc.text(l, margin, y + i * 5));
  y += approvalLines.length * 5 + 8;

  // ── Footer: supersedes + generated stamp ──────────────────────────────────
  doc.setFontSize(8); doc.setTextColor(120);
  doc.text(
    `Supersedes revision ${input.revisionFrom}.    Generated ${fmtDocStamp()}    ${COMPANY.name}`,
    pageW / 2, 287, { align: 'center' },
  );
  doc.setTextColor(0);

  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
  doc.save(`${safe(input.amendmentNo || `${input.kind}-amendment`)}.pdf`);
}
