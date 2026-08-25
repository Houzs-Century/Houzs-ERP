import { describe, expect, test } from 'vitest';
/* `?raw`, NOT node:fs — backend/tsconfig.json types Workers only, so a
   node:fs import typechecks red even though vitest runs it fine. */
import outboxSrc from './autocount-outbox.ts?raw';
import migrationSrc from '../../db/migrations-pg/0326_supplier_binding_ac_item_code.sql?raw';

/* ---------------------------------------------------------------------------
   THE ACCOUNT BOOK'S NAME AND THE SUPPLIER'S NAME ARE TWO COLUMNS.

   Until 2026-08-25 they were one — `supplier_material_bindings.supplier_sku` —
   and the two readers each believed it was theirs:

     the PO / GRN / PI PDF   the code the SUPPLIER acts on
     the AutoCount resolver  the ItemCode written into a licensed book

   The census over all 3,076 bindings measured the cost: 1,063 rows would OPEN
   an item the book does not hold, and 139 are refused outright. ItemCode is
   stock identity in AutoCount, so buying into one code and selling out of
   another never reconciles.

   These tests pin the SEAM, not the values: which column the write-back reads,
   and that purchasing's column is no longer wired to it.
   ------------------------------------------------------------------------ */
describe('the write-back reads ac_item_code, not supplier_sku', () => {
  const outbox = outboxSrc as string;

  test('the binding read asks for ac_item_code', () => {
    /* A column the select does not name arrives undefined, and the fallback
       below would then silently keep the old behaviour for every row — the
       change would look done and do nothing. */
    const line = outbox.split('\n').find((l) => l.includes("select: 'item_code, supplier_id"));
    expect(line, 'the bindingsFor select was not found').toBeTruthy();
    expect(line).toContain('ac_item_code');
  });

  test('ac_item_code wins and supplier_sku is only the fallback', () => {
    const body = outbox.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    /* Asserted on the ORDER, because the whole change is which one is asked
       first. `acCode || supplier_sku` is the seam; reversing it would compile,
       pass every other test, and put purchasing's value back in the book. */
    expect(body).toMatch(/const acCode\s*=[\s\S]{0,200}?const sku\s*=\s*acCode\s*\|\|/);
  });

  test('the fallback is still there, and that is deliberate', () => {
    /* ac_item_code starts NULL on every row. Removing the fallback before the
       column is seeded would stop resolving the 1,874 products that land
       correctly today — a regression dressed as a cleanup. */
    const body = outbox.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(body).toContain('r.supplier_sku');
  });
});

describe('migration 0326 adds the column without changing any document', () => {
  const sql = migrationSrc as string;

  test('it only ADDs a nullable column', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ac_item_code text/);
    /* NOT NULL or a DEFAULT would give every existing row an answer nobody
       chose, and this column decides what is written into a licensed account
       book. NULL has to mean "no answer stored". */
    expect(sql).not.toMatch(/ac_item_code[^;]*NOT NULL/i);
    expect(sql).not.toMatch(/ac_item_code[^;]*DEFAULT/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  test('both columns carry a COMMENT saying which reader owns them', () => {
    /* The next person to look at this table meets the two names with no
       context. The comments are where the split is explained at the point of
       confusion, rather than in a file they have no reason to open. */
    expect(sql).toContain('COMMENT ON COLUMN scm.supplier_material_bindings.ac_item_code');
    expect(sql).toContain('COMMENT ON COLUMN scm.supplier_material_bindings.supplier_sku');
  });
});
