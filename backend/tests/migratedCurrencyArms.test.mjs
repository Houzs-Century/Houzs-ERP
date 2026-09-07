/* The wrong belief that killed the first production run of
 * repair-migrated-currency.mjs, held to account without a database.
 *
 * Run 34140077540 (2026-09-07 23:47+08) printed a correct plan for the 574
 * migrated purchase orders — `573 already agree with the book; 1 to change` —
 * and then died with `PostgresError: column "id" does not exist` on the sales
 * orders. scm.purchase_orders is keyed by a uuid `id`; scm.mfg_sales_orders has
 * NO `id` column, it is keyed by `doc_no`. One assumption applied to two tables
 * that never shared it.
 *
 * These assertions are cheap and they are the ones that were false.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

import { CURRENCY_ARMS, missingColumns, splitTable } from '../scripts/lib/migrated-currency-arms.mjs';

const arm = (kind) => CURRENCY_ARMS.find((a) => a.kind === kind);

describe('the currency repair addresses each table by ITS OWN key', () => {
  test('the sales-order arm is keyed by doc_no, never by id', () => {
    expect(arm('SO').pk).toBe('doc_no');
  });

  test('the purchase-order arm is keyed by id', () => {
    expect(arm('PO').pk).toBe('id');
  });

  /* Not a restatement of the two above: it asserts they DIFFER, which is the
     fact a single shared assumption violates. */
  test('the two arms do not share a key', () => {
    expect(arm('SO').pk).not.toBe(arm('PO').pk);
  });

  test('every arm is schema-qualified and splits cleanly', () => {
    for (const a of CURRENCY_ARMS) {
      const { schema, table } = splitTable(a.table);
      expect(schema, `${a.kind} names no schema`).toBeTruthy();
      expect(table, `${a.kind} names no table`).toBeTruthy();
      expect(a.table).toBe(`${schema}.${table}`);
    }
  });
});

describe('missingColumns refuses by NAME instead of letting Postgres error', () => {
  const full = (a) => new Set([a.pk, a.docCol, 'currency', 'linked_ac_docno', 'company_id']);

  test('a table carrying every named column is clean', () => {
    for (const a of CURRENCY_ARMS) expect(missingColumns(a, full(a))).toEqual([]);
  });

  /* THE PLANTED DEFECT: the exact production shape. A sales-order table with an
     `id` and no `doc_no` is what the old code assumed existed. */
  test('the sales-order table WITHOUT doc_no is refused, naming the column', () => {
    const cols = new Set(['id', 'po_number', 'currency', 'linked_ac_docno', 'company_id']);
    expect(missingColumns(arm('SO'), cols)).toContain('doc_no');
  });

  test('a missing currency column is refused too', () => {
    const a = arm('PO');
    const cols = full(a);
    cols.delete('currency');
    expect(missingColumns(a, cols)).toEqual(['currency']);
  });

  test('an empty column set names every column the run would have used', () => {
    expect(missingColumns(arm('SO'), new Set()).sort())
      .toEqual(['company_id', 'currency', 'doc_no', 'linked_ac_docno'].sort());
  });
});

describe('the script itself no longer hard-codes one key for both tables', () => {
  const src = readFileSync(new URL('../scripts/repair-migrated-currency.mjs', import.meta.url), 'utf8');

  test('it imports the arm table instead of declaring its own', () => {
    expect(src).toContain('CURRENCY_ARMS');
  });

  /* `WHERE id = $2::uuid` is the statement that failed. It may not come back by
     any route, including a well-meaning "simplification". */
  test('no statement addresses an arm by a bare id', () => {
    expect(src).not.toMatch(/WHERE\s+id\s*=/i);
    expect(src).not.toMatch(/\bid\s*=\s*ANY\(/i);
  });
});
