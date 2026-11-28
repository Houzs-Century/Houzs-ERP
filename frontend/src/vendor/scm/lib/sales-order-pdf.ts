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
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';
import { ensureProductCategories } from './product-categories-store';
import { drawSalesOrderInto, type SoPdfSources } from '../../../../../shared/src/vendor/scm/lib/sales-order-pdf-render';


export {
  CONSIGNMENT_LOAN_TERMS,
  consignmentLoanTerms,
  CONSIGNMENT_ORDER_PDF_OPTS,
  soPdfPaidSen,
} from '../../../../../shared/src/vendor/scm/lib/sales-order-pdf-render';

export type { PdfAction } from './pdf-common';

type RenderArgs = Parameters<typeof drawSalesOrderInto>;
type SoHeader = RenderArgs[3];
type SoItem = RenderArgs[4][number];
type SoPayment = NonNullable<RenderArgs[5]>[number];
type SoRenderOpts = RenderArgs[7];

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
  productCategories: () =>
    ensureProductCategories().catch((e: unknown) => {
      console.warn('product categories not loaded; headings read the code', e);
      return [];
    }),
};

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

export async function generateSalesOrderPdf(
  header: SoHeader,
  items: SoItem[],
  payments: SoPayment[] = [],
  action: PdfAction = 'save',
  pwpCodes: SoPwpCodeRow[] = [],
  opts?: { docTitle?: string; docNoLabel?: string; docNoun?: string; refLabel?: string; terms?: readonly string[]; money?: boolean },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderSalesOrderInto(doc, autoTable, header, items, payments, pwpCodes, opts);

  const filename = `${header.doc_no}-${safeName(header.debtor_name || 'customer')}.pdf`;
  deliverPdf(doc, filename, action);
}

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
