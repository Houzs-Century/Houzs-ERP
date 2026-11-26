import { coerceScanDocumentType } from '../lib/scan-document-type';

export function jobToJson(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id ?? null,
    status: r.status ?? null,
    salesperson: r.salesperson ?? null,
    soDocNo: r.soDocNo ?? r.so_doc_no ?? null,
    documentType: coerceScanDocumentType(r.documentType ?? r.document_type),
    linkedDocNo: r.linkedDocNo ?? r.linked_doc_no ?? r.soDocNo ?? r.so_doc_no ?? null,
    error: r.error ?? null,
    sampleId: r.sampleId ?? r.sample_id ?? null,
    duplicateOf: r.duplicateOf ?? r.duplicate_of ?? null,
    imageKeys: r.imageKeys ?? r.image_keys ?? [],
    receiptImageKeys: r.receiptImageKeys ?? r.receipt_image_keys ?? [],
    createdAt: r.createdAt ?? r.created_at ?? null,
    updatedAt: r.updatedAt ?? r.updated_at ?? null,
  };
}
