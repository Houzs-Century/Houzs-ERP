
export { setPdfHost, type PdfHost, type PdfLogo, type PdfLetterhead } from "../../../shared/src/vendor/scm/lib/pdf-host";
export { letterheadFromBranding, type LetterheadBranding } from "../../../shared/src/vendor/scm/lib/pdf-letterhead";
export { safeName } from "../../../shared/src/vendor/scm/lib/pdf-core";
export { PDF_COMPRESS } from "../../../shared/src/vendor/scm/lib/pdf-options";
export { sniffImageMime, type PdfPhotoImage } from "../../../shared/src/vendor/scm/lib/pdf-item-photos";
export { makeSupplierDocLoaders, type ScmJsonGetter } from "../../../shared/src/vendor/scm/lib/supplier-doc-data-core";
export { salesOrderPrintBundle, purchaseOrderPrintBundle, type PrintBundle } from "../../../shared/src/vendor/scm/lib/print-bundle";
export { drawSalesOrderInto, type SoPdfSources } from "../../../shared/src/vendor/scm/lib/sales-order-pdf-render";
export { drawPurchaseOrderInto, finalizePoPdf, type PoPdfSources } from "../../../shared/src/vendor/scm/lib/purchase-order-pdf-render";
export { poDisplayNumber } from "../../../shared/src/vendor/scm/lib/po-status";
export type { ProductCategory } from "../../../shared/src/vendor/shared/product-categories";
