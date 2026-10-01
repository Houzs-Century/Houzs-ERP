// ----------------------------------------------------------------------------
// Rack label sheet — one QR sticker per rack, printed once and stuck on the
// shelf, so the storekeeper can scan the SHELF at put-away instead of writing
// the rack number on paper for the purchaser to re-type into the GRN
// (owner 2026-10-01, plan A: storekeeper drafts the GRN, purchaser confirms).
//
// THE QR CARRIES THE LABEL, NOT THE ROW ID. A rack label is fanned out to one
// `warehouse_racks` row per warehouse record that shares the physical shelf
// (Display / KL goods / ...), and a GRN line must take the rack row of the
// GRN's OWN warehouse. A row id would tie the sticker to one of those records
// and refuse the others; the label resolves inside whichever warehouse the
// receipt is for. The prefix lets a scanner tell a shelf from a DO or packing
// list QR, which encode URLs.
//
// A4, 2 x 5 stickers, dashed cut lines. The rack number is printed as large as
// fits, since it is read from across an aisle; the QR is drawn as vectors by
// the shared drawQrIntoPdf.
// ----------------------------------------------------------------------------

import { deliverPdf, ensurePdfCjkFont, safeName, type PdfAction } from './pdf-common';
import { drawQrIntoPdf } from './pdf-qr';
import { compareRackLabels } from './warehouse-floorplan';

export const RACK_QR_PREFIX = 'HZRACK:';

export const rackQrPayload = (label: string): string => `${RACK_QR_PREFIX}${label.trim()}`;

const PAGE_W = 210;
const PAGE_H = 297;
const MARGIN = 10;
const COLS = 2;
const ROWS = 5;
export const LABELS_PER_PAGE = COLS * ROWS;
const CELL_W = (PAGE_W - MARGIN * 2) / COLS;
const CELL_H = (PAGE_H - MARGIN * 2) / ROWS;
const PAD = 5;
const QR_MM = 42;

/** Where sticker `index` (0-based, print order) lands. */
export function rackLabelCell(index: number): { page: number; x: number; y: number } {
  const page = Math.floor(index / LABELS_PER_PAGE);
  const slot = index % LABELS_PER_PAGE;
  return {
    page,
    x: MARGIN + (slot % COLS) * CELL_W,
    y: MARGIN + Math.floor(slot / COLS) * CELL_H,
  };
}

/** Labels in print order: natural rack order (L2 before L10), blanks dropped. */
export function rackLabelsInPrintOrder(labels: string[]): string[] {
  return labels.map((l) => l.trim()).filter(Boolean).sort(compareRackLabels);
}

export async function generateRackLabelsPdf(
  labels: string[],
  opts: { warehouseCode: string; action?: PdfAction },
): Promise<void> {
  const ordered = rackLabelsInPrintOrder(labels);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  await ensurePdfCjkFont(doc, { ordered, warehouse: opts.warehouseCode });

  ordered.forEach((label, i) => {
    const { page, x, y } = rackLabelCell(i);
    if (page > 0 && i % LABELS_PER_PAGE === 0) doc.addPage();

    doc.setDrawColor(190);
    doc.setLineWidth(0.2);
    doc.setLineDashPattern([1.5, 1.5], 0);
    doc.rect(x, y, CELL_W, CELL_H, 'S');
    doc.setLineDashPattern([], 0);

    const qr = drawQrIntoPdf(doc, rackQrPayload(label), x + PAD, y + (CELL_H - QR_MM) / 2, QR_MM);

    const textX = x + PAD + qr + PAD;
    const textW = x + CELL_W - PAD - textX;
    let size = 48;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    while (size > 12 && doc.getTextWidth(label) > textW) {
      size -= 2;
      doc.setFontSize(size);
    }
    doc.setTextColor(0);
    doc.text(label, textX, y + CELL_H / 2 + 2);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(110);
    doc.text(opts.warehouseCode, textX, y + CELL_H / 2 + 11);
    doc.text('Scan to put away', textX, y + CELL_H / 2 + 16);
  });

  deliverPdf(doc, `${safeName(`rack-labels-${opts.warehouseCode}`)}.pdf`, opts.action);
}
