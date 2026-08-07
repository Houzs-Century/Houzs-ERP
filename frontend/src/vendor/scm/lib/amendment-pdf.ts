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

import { COMPANY, deliverPdf, drawHeader, ensurePdfCjkFont, fmtDocDate, fmtDocStamp, safeName, type PdfAction } from './pdf-common';

/* One changed line on the amendment. `kind` drives the tint semantics: a CHANGE
   shows before (red) -> after (green); an ADD has no before; a REMOVE has no
   after. `field` is a human label ("Quantity", "Unit price", "Delivery date",
   "Spec", "Line"). `department` is the routing label (amendment-routing.ts) for
   the field this row changed — printed in the Dept column for accountability. */
export type AmendmentChangeRow = {
  item: string;
  field: string;
  before: string;
  after: string;
  kind?: 'ADD' | 'REMOVE' | 'CHANGE';
  department?: string | null;
};

/* The amendment TYPE + department-routing summary (amendment-routing.ts), folded
   by the mapper so the PDF template stays presentation-only. Drives the type
   badge row and the department-routing block. */
export type AmendmentPdfRouting = {
  /** Type labels to badge, e.g. ['Processing', 'Delivery / Commercial']. */
  typeLabels: string[];
  isMixed: boolean;
  /** Each responsible department against the field labels it owns. */
  departments: Array<{ department: string; fields: string[] }>;
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
  /** Type badges + department routing (advisory accountability, not a gate). */
  routing?: AmendmentPdfRouting | null;
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

export async function generateAmendmentPdf(
  input: AmendmentPdfInput,
  opts?: { action?: PdfAction },
): Promise<void> {
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

  // ── Amendment TYPE badge(s) ───────────────────────────────────────────────
  // Processing (WHAT is made) vs Delivery / Commercial (WHEN + terms). A mixed
  // amendment shows both. Advisory classification — it does not gate the apply.
  const routing = input.routing ?? null;
  if (routing && routing.typeLabels.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    doc.text('AMENDMENT TYPE', margin, y);
    let bx = margin + 34;
    if (routing.isMixed) {
      const w = doc.getTextWidth('MIXED') + 4;
      doc.setFillColor(235, 235, 235); doc.setTextColor(90, 90, 90);
      doc.roundedRect(bx, y - 3.4, w, 5, 0.8, 0.8, 'F');
      doc.text('MIXED', bx + 2, y);
      bx += w + 3;
    }
    for (const label of routing.typeLabels) {
      const up = label.toUpperCase();
      const w = doc.getTextWidth(up) + 4;
      doc.setFillColor(224, 231, 245); doc.setTextColor(30, 58, 110);
      doc.roundedRect(bx, y - 3.4, w, 5, 0.8, 0.8, 'F');
      doc.text(up, bx + 2, y);
      bx += w + 3;
    }
    doc.setTextColor(0);
    y += 6;
  }

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
    ? input.changes.map((r) => [r.item || '—', r.field || '—', r.before, r.after, r.department || '—'])
    : [['—', 'No line changes', '—', '—', '—']];

  autoTable(doc, {
    startY: y + 2,
    // Dept = the responsible department this changed field routes to (accountability).
    head: [['Item', 'Field', 'Before', 'After', 'Dept']],
    body,
    theme: 'grid',
    margin: { left: margin, right: margin },
    styles: { font: 'helvetica', fontSize: 9, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: [40, 40, 40], textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 44 },
      1: { cellWidth: 24 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 34 },
    },
    // BEFORE tinted red, AFTER tinted green — per the owner's mockup. An ADD has
    // no before (muted dash); a REMOVE's after reads "Removed". Dept column reads
    // muted — it labels responsibility, it is not part of the before/after delta.
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
      if (data.column.index === 4) { data.cell.styles.textColor = MUTED_INK; data.cell.styles.fontSize = 8; }
    },
  });

  // autotable stashes the final Y on the doc.
  y = ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y) + 8;

  // ── Department routing block ──────────────────────────────────────────────
  // Each responsible department against the fields it owns in this amendment —
  // the owner's 3-dept routing concept. Advisory: it shows WHO is accountable for
  // WHAT, it does not split the apply into per-department signatures.
  if (routing && routing.departments.length > 0) {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('DEPARTMENT ROUTING', margin, y);
    y += 5;
    doc.setFontSize(9);
    for (const d of routing.departments) {
      doc.setFont('helvetica', 'bold');
      doc.text(`${d.department}:`, margin, y);
      doc.setFont('helvetica', 'normal');
      const fields = d.fields.join(', ');
      const wrapped = doc.splitTextToSize(fields, pageW - margin * 2 - 42) as string[];
      doc.text(wrapped, margin + 42, y);
      y += Math.max(wrapped.length * 4.5, 4.5) + 1.5;
    }
    y += 4;
  }

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
  y += approvalLines.length * 5 + 3;

  // Single-signature accountability: ONE approver applies the WHOLE amendment,
  // so record that this approval covers every routed department. The routing
  // block above says which fields each department owns; this says the approver
  // signed for all of them.
  if (input.approvedBy && routing && routing.departments.length > 0) {
    doc.setFontSize(8.5); doc.setTextColor(120);
    const depts = routing.departments.map((d) => d.department).join(', ');
    const line = `Approval applies to all routed changes (${depts}) under a single authorized signature.`;
    const wrapped = doc.splitTextToSize(line, pageW - margin * 2) as string[];
    doc.text(wrapped, margin, y);
    doc.setTextColor(0);
    y += wrapped.length * 4.5 + 5;
  } else {
    y += 5;
  }

  // ── Footer: supersedes + generated stamp ──────────────────────────────────
  doc.setFontSize(8); doc.setTextColor(120);
  doc.text(
    `Supersedes revision ${input.revisionFrom}.    Generated ${fmtDocStamp()}    ${COMPANY.name}`,
    pageW / 2, 287, { align: 'center' },
  );
  doc.setTextColor(0);

  // Was a private copy of the old ASCII-only scrub; the shared helper keeps a
  // non-Latin amendment number readable instead of underscoring it away.
  deliverPdf(doc, `${safeName(input.amendmentNo || `${input.kind}-amendment`, 40)}.pdf`, opts?.action);
}
