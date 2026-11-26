import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SUPPLIER_FINANCE_BODY_KEYS, SUPPLIER_FINANCE_COLUMNS } from './supplier-finance-fields';

describe('the two copies of supplier-finance-fields are the same file', () => {
  test('backend/src/scm/shared/supplier-finance-fields.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/supplier-finance-fields.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/supplier-finance-fields.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  test('the column list and the body-key list name the same eleven fields', () => {
    expect(SUPPLIER_FINANCE_COLUMNS).toHaveLength(11);
    const camel = SUPPLIER_FINANCE_COLUMNS.map((c) => c.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()));
    expect(camel).toEqual([...SUPPLIER_FINANCE_BODY_KEYS]);
  });
});
