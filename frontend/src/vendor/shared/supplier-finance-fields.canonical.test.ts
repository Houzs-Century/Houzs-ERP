import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SUPPLIER_FINANCE_BODY_KEYS, SUPPLIER_FINANCE_COLUMNS } from './supplier-finance-fields';

/* The referee for this vendored twin, in the shape the repo uses for the same
   problem (do-shipped-states.canonical.test.ts, total-height.canonical.test.ts):
   the server strips what backend/src/scm/shared/supplier-finance-fields.ts
   names, the screens hide what this copy names, and the two must be one list
   or a purchaser's save could write a Finance field the screen never showed. */
describe('the two copies of supplier-finance-fields are the same file', () => {
  test('backend/src/scm/shared/supplier-finance-fields.ts is byte-identical to this one', () => {
    const here = resolve(process.cwd(), 'src/vendor/shared/supplier-finance-fields.ts');
    const there = resolve(process.cwd(), '../backend/src/scm/shared/supplier-finance-fields.ts');
    const norm = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    expect(norm(there)).toBe(norm(here));
  });

  /* A byte comparison passes for the wrong reason if both reads came back
     empty; prove the lists are real and pair up. */
  test('the column list and the body-key list name the same seven fields', () => {
    expect(SUPPLIER_FINANCE_COLUMNS).toHaveLength(7);
    const camel = SUPPLIER_FINANCE_COLUMNS.map((c) => c.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()));
    expect(camel).toEqual([...SUPPLIER_FINANCE_BODY_KEYS]);
  });
});
