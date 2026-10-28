import { coerceScanDocumentType } from '../lib/scan-document-type';

// Snake/camel-tolerant scan_jobs row -> API shape (dual-read both casings — the
// #1 recurring result-column bug class). Lives beside scan-so.ts so the growing
// document-type dimension does not push that file past its size ceiling.
export function jobToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    salesperson: r.salesperson ?? null,
    soDocNo: r.soDocNo ?? r.so_doc_no ?? null,
    // Document-type dimension (migration 20260919T1000). documentType defaults
    // to 'SO' for rows predating the column; linkedDocNo is the generic
    // produced-doc link (== soDocNo for SO scans).
    documentType: coerceScanDocumentType(r.documentType ?? r.document_type),
    linkedDocNo: r.linkedDocNo ?? r.linked_doc_no ?? r.soDocNo ?? r.so_doc_no ?? null,
    error: r.error ?? null,
    sampleId: r.sampleId ?? r.sample_id ?? null,
    // Duplicate-upload warning (migration 0068) — doc_no of the suspected
    // original SO; the mobile Scan screen surfaces it on the job card.
    duplicateOf: r.duplicateOf ?? r.duplicate_of ?? null,
    imageKeys: r.imageKeys ?? r.image_keys ?? [],
    // Multi-receipt (migration 0141) — the R2 keys of the uploads the OCR
    // classified as payment receipts (one payment booked per key). [] for a
    // draft-only scan or a row predating the column.
    receiptImageKeys: r.receiptImageKeys ?? r.receipt_image_keys ?? [],
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}
