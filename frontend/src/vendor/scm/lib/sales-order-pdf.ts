import type { SoPwpCodeRow } from '@2990s/shared/so-line-display';
import { deliverPdf, safeName, type PdfAction } from './pdf-common';
import { loadFabricDescriptionMap, loadFabricSupplierMap } from './supplier-doc-data';
import { blobToSquarePdfImage } from './pdf-item-photos-canvas';
import { fetchSoItemPhotoBlob } from './sales-order-queries';
import {
  ensureBrandingLogoLoaded,
  ensureBrandLogoLoaded,
  getBrandLogoCache,
} from '../../../lib/branding';
import { PDF_COMPRESS } from './pdf-options';
import { drawSalesOrderInto, type SoPdfSources } from './sales-order-pdf-render';

// ----------------------------------------------------------------------------
// Sales Order PDF in the BROWSER. The layout lives in sales-order-pdf-render.ts
// (shared with the Worker's AI Connector get_pdf); this file supplies the
// browser's lookups (the page's session, canvas photo transcode, the branding
// logo memo) and the three exits (save / print / preview).
// ----------------------------------------------------------------------------

export {
  CONSIGNMENT_LOAN_TERMS,
  consignmentLoanTerms,
  CONSIGNMENT_ORDER_PDF_OPTS,
  soPdfPaidSen,
} from './sales-order-pdf-render';

/* Follow-up #83 introduced save / print / preview delivery HERE; every other
   document's generator only knew doc.save(). The Print preview rollout
   (2026-08-06) needs all of them to offer the same three exits, so the type and
   the iframe/blob plumbing now live in pdf-common alongside the letterhead
   helpers. Re-exported so the SO's existing importers keep their import path. */
export type { PdfAction } from './pdf-common';

type RenderArgs = Parameters<typeof drawSalesOrderInto>;
type SoHeader = RenderArgs[3];
type SoItem = RenderArgs[4][number];
type SoPayment = NonNullable<RenderArgs[5]>[number];
type SoRenderOpts = RenderArgs[7];

/* The browser's lookups: the page's own session for every read, the canvas
   transcode for photos, and the branding logo memos (fail-soft inside). */
const browserSources: SoPdfSources = {
  fabricDescriptionMap: (codes) => loadFabricDescriptionMap(codes),
  fabricSupplierMap: (codes) => loadFabricSupplierMap(codes),
  linePhoto: (docNo, itemId, key) => fetchSoItemPhotoBlob(docNo, itemId, key),
  photoImage: (blob) => blobToSquarePdfImage(blob),
  letterheadReady: () => ensureBrandingLogoLoaded(),
  brandLogo: async (key) => {
    await ensureBrandLogoLoaded(key);
    return getBrandLogoCache(key);
  },
};

/* Draw ONE sales order into `doc` with the browser's lookups. Same signature as
   before the layout moved to sales-order-pdf-render.ts. */
export function renderSalesOrderInto(
  doc: RenderArgs[0],
  autoTable: RenderArgs[1],
  header: SoHeader,
  allItems: SoItem[],
  payments: SoPayment[] = [],
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: SoRenderOpts,
): Promise<void> {
  return drawSalesOrderInto(doc, autoTable, browserSources, header, allItems, payments, pwpCodes, opts);
}

/* Single SO → its own file (or print / preview). EXACT same signature and
   behaviour as before the renderSalesOrderInto extraction — single-doc output
   is byte-identical to the pre-refactor generator. */
export async function generateSalesOrderPdf(
  header: SoHeader,
  items: SoItem[],
  payments: SoPayment[] = [],
  action: PdfAction = 'save',
  /* PWP vouchers this SO's trigger items issued (GET /:docNo `pwpCodes`) —
     used to mark trigger lines. Optional so older callers stay valid. */
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean },
): Promise<void> {
  // Dynamic import — code-split into a vendor chunk.
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderSalesOrderInto(doc, autoTable, header, items, payments, pwpCodes, opts);

  // Filename: SO-009001-DebtorName.pdf
  const filename = `${header.doc_no}-${safeName(header.debtor_name || 'customer')}.pdf`;
  deliverPdf(doc, filename, action);
}

/* Several SOs → ONE combined file, each SO starting on a new page. For the
   batch "Export PDF" action on the SO list (one combined attachment). Each SO's
   footer numbers its own pages; the whole file saves once. */
export async function generateCombinedSalesOrderPdf(
  docs: Array<{ header: SoHeader; items: SoItem[]; payments?: SoPayment[]; pwpCodes?: SoPwpCodeRow[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderSalesOrderInto(
      doc, autoTable,
      docs[i]!.header, docs[i]!.items,
      docs[i]!.payments ?? [], docs[i]!.pwpCodes ?? [],
      opts,
    );
  }
  deliverPdf(doc, opts?.fileName ?? 'sales-orders.pdf', opts?.action);
}
