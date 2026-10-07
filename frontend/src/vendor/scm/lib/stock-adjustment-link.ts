/** DO-cancel and DR-resync add-backs are ALSO source_doc_type 'ADJUSTMENT', but
    they carry their DO / DR number, so only an SA-numbered row is an adjustment
    document with a page of its own. */
export const isStockAdjustmentDocNo = (docNo: string | null | undefined): boolean =>
  /(^|-)SA-\d{4}-\d+$/.test(docNo ?? '');

export const stockAdjustmentHref = (m: { source_doc_id: string | null; source_doc_no: string | null }): string =>
  m.source_doc_id && isStockAdjustmentDocNo(m.source_doc_no) ? `/scm/stock-adjustments/${m.source_doc_id}` : '/scm/stock-adjustments';
