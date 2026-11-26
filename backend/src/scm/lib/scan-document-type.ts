
export const SCAN_DOCUMENT_TYPES = ['SO', 'GR', 'PI'] as const;

export type ScanDocumentType = (typeof SCAN_DOCUMENT_TYPES)[number];

/** How each type reads on screen (the IT OCR page). */
export const SCAN_DOCUMENT_TYPE_LABEL: Record<ScanDocumentType, string> = {
  SO: 'Sales slip (SO)',
  GR: 'Supplier delivery order (GR)',
  PI: 'Supplier invoice (PI)',
};

export const DEFAULT_SCAN_DOCUMENT_TYPE: ScanDocumentType = 'SO';

export function coerceScanDocumentType(value: unknown): ScanDocumentType {
  if (typeof value === 'string') {
    const upper = value.trim().toUpperCase();
    if ((SCAN_DOCUMENT_TYPES as readonly string[]).includes(upper)) {
      return upper as ScanDocumentType;
    }
  }
  return DEFAULT_SCAN_DOCUMENT_TYPE;
}

export function isScanDocumentType(value: unknown): value is ScanDocumentType {
  return (
    typeof value === 'string' &&
    (SCAN_DOCUMENT_TYPES as readonly string[]).includes(value)
  );
}
