import { describe, expect, test } from 'vitest';
import {
  SCAN_DOCUMENT_TYPES,
  DEFAULT_SCAN_DOCUMENT_TYPE,
  coerceScanDocumentType,
  isScanDocumentType,
} from './scan-document-type';

// Slice 1 of the OCR scan -> GR/PI feature only adds a document-type dimension.
// The one piece of real logic is this vocabulary + its two guards; the rest of
// the slice threads a constant. These pin the guards so the GR/PI slices build
// on a stable seam.

describe('the scan document-type vocabulary', () => {
  test('SO is the default the SO path threads', () => {
    expect(DEFAULT_SCAN_DOCUMENT_TYPE).toBe('SO');
    expect(SCAN_DOCUMENT_TYPES).toEqual(['SO', 'GR', 'PI']);
  });
});

describe('coerceScanDocumentType — coerce-and-default, never throw', () => {
  test('passes the three known types through unchanged', () => {
    expect(coerceScanDocumentType('SO')).toBe('SO');
    expect(coerceScanDocumentType('GR')).toBe('GR');
    expect(coerceScanDocumentType('PI')).toBe('PI');
  });

  test('a legacy row reads back null -> falls back to SO (the pre-column shape)', () => {
    expect(coerceScanDocumentType(null)).toBe('SO');
    expect(coerceScanDocumentType(undefined)).toBe('SO');
  });

  test('normalises case and surrounding whitespace', () => {
    expect(coerceScanDocumentType('so')).toBe('SO');
    expect(coerceScanDocumentType('  gr ')).toBe('GR');
    expect(coerceScanDocumentType('Pi')).toBe('PI');
  });

  test('an unknown or wrong-typed value defaults to SO rather than leaking through', () => {
    expect(coerceScanDocumentType('CN')).toBe('SO');
    expect(coerceScanDocumentType('')).toBe('SO');
    expect(coerceScanDocumentType(42)).toBe('SO');
    expect(coerceScanDocumentType({})).toBe('SO');
  });
});

describe('isScanDocumentType — strict predicate for the GR/PI enqueue routes', () => {
  test('true only for an exact known literal', () => {
    expect(isScanDocumentType('SO')).toBe(true);
    expect(isScanDocumentType('GR')).toBe(true);
    expect(isScanDocumentType('PI')).toBe(true);
  });

  test('false for case variants, unknowns and non-strings (no coercion here)', () => {
    expect(isScanDocumentType('so')).toBe(false);
    expect(isScanDocumentType('CN')).toBe(false);
    expect(isScanDocumentType(null)).toBe(false);
    expect(isScanDocumentType(undefined)).toBe(false);
    expect(isScanDocumentType(1)).toBe(false);
  });
});
