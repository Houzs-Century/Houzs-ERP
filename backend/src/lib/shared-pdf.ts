// ----------------------------------------------------------------------------
// shared-pdf — the ONE door from the Worker into the browser's document layout
// code (frontend/src/vendor/scm/lib). The AI Connector's get_pdf draws Sales
// Orders and Purchase Orders with the very generator the ERP page uses, so the
// file a person downloads through the connector is the file the Print button
// makes. Everything re-exported here is DOM-free by rule (pdf-host.ts header);
// the backend typecheck (no DOM lib) fails if one of them ever reaches for the
// browser.
//
// Deploy coupling: a change under these frontend paths changes the Worker, so
// .github/workflows/ci.yml (changes) and deploy.yml (backend filter) treat
// frontend/src/vendor/scm/lib/** and frontend/src/vendor/shared/** as backend
// too.
// ----------------------------------------------------------------------------

export { setPdfHost, type PdfHost, type PdfLogo, type PdfLetterhead } from "../../../frontend/src/vendor/scm/lib/pdf-host";
export { letterheadFromBranding, type LetterheadBranding } from "../../../frontend/src/vendor/scm/lib/pdf-letterhead";
export { safeName } from "../../../frontend/src/vendor/scm/lib/pdf-core";
export { PDF_COMPRESS } from "../../../frontend/src/vendor/scm/lib/pdf-options";
export { sniffImageMime, type PdfPhotoImage } from "../../../frontend/src/vendor/scm/lib/pdf-item-photos";
export { makeSupplierDocLoaders, type ScmJsonGetter } from "../../../frontend/src/vendor/scm/lib/supplier-doc-data-core";
export { salesOrderPrintBundle, purchaseOrderPrintBundle, type PrintBundle } from "../../../frontend/src/vendor/scm/lib/print-bundle";
export { drawSalesOrderInto, type SoPdfSources } from "../../../frontend/src/vendor/scm/lib/sales-order-pdf-render";
export { drawPurchaseOrderInto, finalizePoPdf, type PoPdfSources } from "../../../frontend/src/vendor/scm/lib/purchase-order-pdf-render";
export { poDisplayNumber } from "../../../frontend/src/vendor/scm/lib/po-status";
