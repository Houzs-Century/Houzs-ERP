import { deliverPdf, safeName, type PdfAction } from './pdf-common';
import { loadSupplierDocData } from './supplier-doc-data';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';
import { drawGrnInto, type GrnHeader, type GrnItem, type GrnPdfSources } from '../../../../../shared/src/vendor/scm/lib/grn-pdf-render';

const browserSources: GrnPdfSources = {
  supplierDocData: (supplierId, items) => loadSupplierDocData(supplierId, items),
};

export function renderGrnInto(
  doc: import('jspdf').jsPDF,
  autoTable: Parameters<typeof drawGrnInto>[1],
  header: GrnHeader,
  items: GrnItem[],
  opts?: { docTitle?: string; docNoLabel?: string },
): Promise<void> {
  return drawGrnInto(doc, autoTable, browserSources, header, items, opts);
}

export async function generateGrnPdf(
  header: GrnHeader,
  items: GrnItem[],
  opts?: { docTitle?: string; docNoLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderGrnInto(doc, autoTable, header, items, opts);
  deliverPdf(doc, `${header.grn_number}-${safeName(header.supplier?.name ?? 'supplier')}.pdf`, opts?.action);
}

export async function generateCombinedGrnPdf(
  docs: Array<{ header: GrnHeader; items: GrnItem[] }>,
  opts?: { fileName?: string; docTitle?: string; docNoLabel?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderGrnInto(doc, autoTable, docs[i]!.header, docs[i]!.items, opts);
  }
  deliverPdf(doc, opts?.fileName ?? 'goods-received.pdf', opts?.action);
}
