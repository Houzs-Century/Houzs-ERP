// Every row apply-sofa-compartment-corrections.mjs INSERTs must carry the
// warehouse it was copied from.
//
// THE DEFECT (prod, 2026-08-11 → found 2026-08-18). The script inserts a
// missing compartment on BOTH sides of a build. Its purchase_order_items
// branch listed `warehouse_id` and selected `i.warehouse_id`; its
// mfg_sales_order_items branch omitted the column entirely, so the SO line
// landed NULL.
//
// WHY THAT IS SILENT AND EXPENSIVE. Stock allocation buckets by
// (warehouse, item, variant). A NULL-warehouse line matches no bucket, so it
// can never be allocated: it sits at PENDING forever with no incoming-PO badge,
// while the goods for it are received and sitting in the right bucket in the
// right warehouse. It reads to the operator as "the system did not capture the
// data" — which is how it was reported. Seven lines across six orders.
//
// A VALUE TEST CANNOT CATCH THIS: the SQL is a template string handed to
// postgres.js, and the bug is a MISSING COLUMN NAME, so every value assertion
// passes on the columns that are there. The only thing that fails when the
// next person adds a branch and forgets is a check on the statement itself.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = 'scripts/apply-sofa-compartment-corrections.mjs';
const src = readFileSync(resolve(here, '..', SCRIPT), 'utf8');

/* Comments are stripped first. An earlier guard in this repo passed against a
   probe that DELETED the argument it was checking, because the explanatory
   comment above it still contained the word — a check that reads prose is
   green while measuring nothing. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The text from an INSERT into `table` up to the end of its SELECT list. */
const insertStatement = (table: string): string => {
  const clean = stripComments(src);
  const at = clean.indexOf(`INSERT INTO scm.${table}`);
  expect(at, `no INSERT INTO scm.${table} in ${SCRIPT}`).toBeGreaterThan(-1);
  const rest = clean.slice(at);
  const end = rest.indexOf('`;');
  expect(end, `unterminated INSERT for ${table}`).toBeGreaterThan(-1);
  return rest.slice(0, end);
};

describe('apply-sofa-compartment-corrections inserts carry the warehouse', () => {
  for (const table of ['mfg_sales_order_items', 'purchase_order_items'] as const) {
    it(`${table}: names warehouse_id in the column list`, () => {
      expect(insertStatement(table)).toMatch(/\bwarehouse_id\b/);
    });

    it(`${table}: selects it from the source row rather than defaulting`, () => {
      // `i` is the source alias in both branches. Copying beats deriving: the
      // sibling row is the evidence, a state→warehouse lookup is a guess.
      expect(insertStatement(table)).toMatch(/\bi\.warehouse_id\b/);
    });
  }

  it('finds exactly the two inserts it claims to cover', () => {
    const clean = stripComments(src);
    const total = clean.split('INSERT INTO scm.').length - 1;
    // If this moves, a third insert was added — check it carries the warehouse,
    // then update this number.
    expect(total).toBe(2);
  });
});
