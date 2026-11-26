import { deliverPdf, safeName, type PdfAction } from './pdf-common';
import { getBrandingCache } from '../../../lib/branding';
import { loadCustomerFabricMaps } from './supplier-doc-data';
import { PDF_COMPRESS } from '../../../../../shared/src/vendor/scm/lib/pdf-options';
import { drawSalesInvoiceInto, type SiHeader, type SiItem, type SiPdfSources } from '../../../../../shared/src/vendor/scm/lib/sales-invoice-pdf-render';

export { paymentsReceivedLines, type SiHeader, type SiItem, type SiReceipt, type SiReceipts } from '../../../../../shared/src/vendor/scm/lib/sales-invoice-pdf-render';

const browserSources: SiPdfSources = {
  customerFabricMaps: (items) => loadCustomerFabricMaps(items),
  customerPaymentDetails: () => getBrandingCache().customerPaymentDetails,
};

export function renderSalesInvoiceInto(
  doc: import('jspdf').jsPDF,
  autoTable: Parameters<typeof drawSalesInvoiceInto>[1],
  header: SiHeader,
  items: SiItem[],
): Promise<void> {
  return drawSalesInvoiceInto(doc, autoTable, browserSources, header, items);
}

export async function generateSalesInvoicePdf(
  header: SiHeader,
  items: SiItem[],
  opts?: { action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderSalesInvoiceInto(doc, autoTable, header, items);
  deliverPdf(doc, `${header.invoice_number}-${safeName(header.debtor_name)}.pdf`, opts?.action);
}

/** The same pages as bytes — what a sales invoice opened from the AR Invoices
    list shows before anyone prints (owner 2026-10-06: ar invoice 点不开). */
export async function salesInvoicePdfBlob(header: SiHeader, items: SiItem[]): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  await renderSalesInvoiceInto(doc, autoTable, header, items);
  return doc.output('blob');
}

export async function generateCombinedSalesInvoicePdf(
  docs: Array<{ header: SiHeader; items: SiItem[] }>,
  opts?: { fileName?: string; action?: PdfAction },
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ ...PDF_COMPRESS, unit: 'mm', format: 'a4' });
  for (let i = 0; i < docs.length; i += 1) {
    if (i > 0) doc.addPage();
    await renderSalesInvoiceInto(doc, autoTable, docs[i]!.header, docs[i]!.items);
  }
  deliverPdf(doc, opts?.fileName ?? 'sales-invoices.pdf', opts?.action);
}
