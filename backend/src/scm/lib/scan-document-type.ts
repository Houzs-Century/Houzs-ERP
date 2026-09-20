// The scan pipeline's document-type dimension. Today the only live path is the
// Sales Order scanner ('SO'); the Goods Receipt ('GR') and Purchase Invoice
// ('PI') scanners are built on top of this seam in later slices
// (tasks/PLAN-ocr-scan-gr-pi.md). Keeping the vocabulary in one place means the
// GR/PI slices import the type and validator instead of re-declaring string
// literals that could drift apart from the column default.

export const SCAN_DOCUMENT_TYPES = ['SO', 'GR', 'PI'] as const;

export type ScanDocumentType = (typeof SCAN_DOCUMENT_TYPES)[number];

// The column default across scm.scan_jobs / scm.so_scan_samples /
// scm.so_scan_rules — the SO path threads this so nothing about SO changes.
export const DEFAULT_SCAN_DOCUMENT_TYPE: ScanDocumentType = 'SO';

// Narrow an unknown (a request field, a DB column read back in either casing)
// to a ScanDocumentType, falling back to SO. Coerce-and-default rather than
// throw: a legacy scan_jobs row predating the column reads back null, and the
// SO path must survive that exactly as it did before the column existed.
export function coerceScanDocumentType(value: unknown): ScanDocumentType {
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if ((SCAN_DOCUMENT_TYPES as readonly string[]).includes(upper)) {
      return upper as ScanDocumentType;
    }
  }
  return DEFAULT_SCAN_DOCUMENT_TYPE;
}

// Strict predicate for callers that must reject an unknown value rather than
// silently default it (the GR/PI enqueue routes validate the requested type
// this way before it reaches the pipeline).
export function isScanDocumentType(value: unknown): value is ScanDocumentType {
  return (
    typeof value === 'string' &&
    (SCAN_DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}
