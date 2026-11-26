// ----------------------------------------------------------------------------
// Purchase Order PDF in the BROWSER. The layout (and its long design notes)
// lives in purchase-order-pdf-render.ts, shared with the Worker's AI Connector
// get_pdf; this file supplies the browser's lookups (the page's session, the
// canvas photo transcode, the bundled sofa artwork) and the exits (save / print
// / preview, and the base64 the supplier email attaches).
// ----------------------------------------------------------------------------

import { deliverPdf, safeName, type PdfAction } from './pdf-common';
import { poDisplayNumber } from './po-status';
import { ensureBrandingForActiveCompany } from '../../../hooks/useBranding';
import { loadSupplierDocData } from './supplier-doc-data';
import { loadSofaCompartmentArtForPrint, fetchPoItemPhotoBlob } from './sales-order-queries';
import { blobToSquarePdfImage, PDF_EMAIL_PHOTO_PX, pdfImageAt } from './pdf-item-photos-canvas';
import type { PoEmailPhotos } from './po-email-photos';
import { PDF_COMPRESS } from './pdf-options';
import { drawPurchaseOrderInto, finalizePoPdf, type PoPages, type PoPdfSources } from './purchase-order-pdf-render';

export { poUrgencyLabel } from './purchase-order-pdf-render';

type RenderArgs = Parameters<typeof drawPurchaseOrderInto>;
type JsPdf = RenderArgs[0];
type AutoTableFn = RenderArgs[1];
type PoHeader = RenderArgs[3];
type PoItem = RenderArgs[4][number];
type PoRenderOpts = RenderArgs[5];

/* The browser's lookups: the tab's company letterhead, the page's own session
   for every read, the canvas transcode for photos, the sofa artwork loader. */
const browserSources: PoPdfSources = {
  letterheadReady: () => ensureBrandingForActiveCompany(),
  supplierDocData: (supplierId, items) => loadSupplierDocData(supplierId, items),
  linePhoto: (poId, itemId, key) => fetchPoItemPhotoBlob(poId, itemId, key),
  photoImage: (blob, maxPx) => (maxPx != null ? pdfImageAt(maxPx)(blob) : blobToSquarePdfImage(blob)),
  sofaArt: (codes) => loadSofaCompartmentArtForPrint(codes),
};

function renderPurchaseOrderInto(
  doc: JsPdf,
  autoTable: AutoTableFn,
  header: PoHeader,
  items: PoItem[],
  opts?: PoRenderOpts,
): ReturnType<typeof drawPurchaseOrderInto> {
  return drawPurchaseOrderInto(doc, autoTable, browserSources, header, items, opts);
}

/* Single PO → its own file (unchanged behaviour). */
export async function generatePurchaseOrderPdf(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; action?: PdfAction; sofaPhotos?: Record<string, string>; purchaseLocation?: string | null },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  const rendered = await renderPurchaseOrderInto(doc, autoTable, header, items, opts);
  finalizePoPdf(doc, [rendered]);
  const { supplierName } = rendered;
  // Was a private copy of the old ASCII-only scrub — a China supplier's name is
  // exactly the case it destroyed, and the PO is the document that goes to them.
  deliverPdf(
    doc,
    `${poDisplayNumber(header.po_number, header.revision)}-${safeName(supplierName)}.pdf`,
    opts?.action,
  );
}

/* The SAME PO PDF, returned as raw base64 instead of downloaded — for emailing it
   to the supplier. The backend bars a PDF engine, so the browser renders it here
   and posts the base64 to POST /:id/send-to-supplier, which attaches it. */
export async function purchaseOrderPdfBase64(
  header: PoHeader,
  items: PoItem[],
  opts?: { docTitle?: string; sofaPhotos?: Record<string, string>; photoMaxPx?: number },
): Promise<string> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  finalizePoPdf(doc, [await renderPurchaseOrderInto(doc, autoTable, header, items, opts)]);
  // 'datauristring' → "data:application/pdf;base64,XXXX"; keep the base64 tail.
  const uri = doc.output('datauristring');
  return uri.slice(uri.indexOf(',') + 1);
}

/* Mirrors PO_ATTACHMENT_CAP_BYTES in backend/src/scm/lib/po-email.ts — the send
   route refuses a larger PDF outright. */
export const PO_EMAIL_PDF_CAP_BYTES = 5 * 1024 * 1024;

export function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/* The PDF attached to the supplier email. The PDF grows by the size of each
   embedded photo, so a PO with many detailed photos passed the 5 MB cap and
   the whole send was refused. Smaller photos first; if even that is too big,
   the PO goes without its photos and the caller tells the operator. */
export async function purchaseOrderPdfForEmail(
  header: PoHeader,
  items: PoItem[],
): Promise<{ pdfBase64: string; photos: PoEmailPhotos }> {
  const full = await purchaseOrderPdfBase64(header, items);
  if (base64Bytes(full) <= PO_EMAIL_PDF_CAP_BYTES) return { pdfBase64: full, photos: 'full' };
  const reduced = await purchaseOrderPdfBase64(header, items, { photoMaxPx: PDF_EMAIL_PHOTO_PX });
  if (base64Bytes(reduced) <= PO_EMAIL_PDF_CAP_BYTES) return { pdfBase64: reduced, photos: 'reduced' };
  const bare = await purchaseOrderPdfBase64(header, items.map((it) => ({ ...it, photo_urls: [] })));
  return { pdfBase64: bare, photos: 'omitted' };
}

/* Several POs → ONE combined file, each PO starting on a new page. For the
   batch "Print documentation" action (send a supplier all their POs in one
   attachment). Each page carries its own PO number and its page within that
   PO, header and footer. */
export async function generateCombinedPurchaseOrderPdf(
  pos: Array<{ header: PoHeader; items: PoItem[] }>,
  opts?: { docTitle?: string; fileName?: string; action?: PdfAction; sofaPhotos?: Record<string, string> },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  const pages: PoPages[] = [];
  for (let i = 0; i < pos.length; i += 1) {
    if (i > 0) doc.addPage();
    pages.push(await renderPurchaseOrderInto(doc, autoTable, pos[i]!.header, pos[i]!.items, opts));
  }
  finalizePoPdf(doc, pages);
  deliverPdf(doc, opts?.fileName ?? 'purchase-orders.pdf', opts?.action);
}
