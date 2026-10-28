import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PO_LINE_IMPORT_FIELDS } from './po-line-import';

/* The PO line import (owner ruling 2026-09-15) has ONE column mapping and two
 * copies: backend/src/scm/lib/po-line-import.ts is what the server classifies
 * and writes by, and this one is what the import dialog reads the file with. If
 * they drift, the dialog reads a column the server ignores, or parses a date the
 * server then refuses. Same shape as do-header-lock.canonical.test.ts. */
describe('the two copies of po-line-import are the same file', () => {
  const norm = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

  test('backend/src/scm/lib/po-line-import.ts is byte-identical to this one', () => {
    expect(norm('../backend/src/scm/lib/po-line-import.ts')).toBe(norm('src/vendor/scm/lib/po-line-import.ts'));
  });

  test('this pin is not vacuous — both files are real and carry the mapping', () => {
    for (const p of ['src/vendor/scm/lib/po-line-import.ts', '../backend/src/scm/lib/po-line-import.ts']) {
      const t = norm(p);
      expect(t.length).toBeGreaterThan(1000);
      expect(t).toContain('PO_LINE_IMPORT_FIELDS');
      expect(t).toContain('PO_ESTIMATE_DELIVERY_DATE_FIELDS');
    }
    expect(PO_LINE_IMPORT_FIELDS.map((f) => f.header)).toEqual([
      'Delivery Date', 'Estimate Delivery Date', 'Supplier Delivery Date 2', 'Supplier Delivery Date 3',
      'Item Description 2', 'Remarks',
    ]);
  });
});
