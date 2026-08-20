import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FALLBACK_OPTIONS } from './so-dropdown-options-queries';

/* FALLBACK_OPTIONS is what EVERY payment picker on both surfaces renders while
   the so_dropdown_options API is loading or empty (`optionsOrFallback`). It is a
   hand-written copy of a database table, so it rots silently: an operator on a
   cold load sees a list nobody has looked at since it was typed.

   It had rotted in both directions at once. `payment_method` still offered
   'Installment', which mig 0037 DEACTIVATED as a top-level method — a retired
   choice an operator could pick and save. `payment_merchant` held nine banks
   while the same migration seeds twelve, so Pinelabs, AEON and HSBC — all of
   which appear on real receipts — simply could not be chosen.

   Rather than retype the right answer and let it rot again, both assertions are
   DERIVED FROM THE MIGRATION. mig 0037 is applied and immutable, so it is a
   stable source of truth, and a later migration that changes either set will
   fail this test until someone updates the fallback with it. */

/* resolve(process.cwd(), ...) and not new URL(import.meta.url): the frontend
   suite runs in jsdom, where import.meta.url is an http URL and readFileSync
   throws "The URL must be of scheme file". cwd is `frontend/`. (A script run by
   plain node has no such constraint — frontend/scripts/*.mjs resolve from
   import.meta.url, which is the more robust form when it is available.) */
const MIG_0037 = resolve(
  process.cwd(),
  '../backend/src/db/migrations-pg/0037_scm_payment_three_methods.sql',
);

function migrationSql(): string {
  return readFileSync(MIG_0037, 'utf8');
}

/** The merchant banks mig 0037 seeds, in its own sort order. */
function seededMerchants(sql: string): string[] {
  const block = sql.split("INSERT INTO scm.so_dropdown_options")[1] ?? '';
  return [...block.matchAll(/\('payment_merchant',\s*'([^']+)'/g)].map((m) => m[1]!);
}

/** The payment_method values mig 0037 deactivates. */
function deactivatedMethods(sql: string): string[] {
  return [...sql.matchAll(/SET active = false[\s\S]*?value = '([^']+)'/g)].map((m) => m[1]!);
}

describe('the payment fallbacks match the migration that defines them', () => {
  it('the parsers actually matched — a verdict over nothing is not a pass', () => {
    // A regex that stops matching would make every assertion below compare an
    // empty list to an empty list and pass. This is the assertion that refuses.
    const sql = migrationSql();
    expect(sql.length, 'mig 0037 unreadable — did it move or get renumbered?')
      .toBeGreaterThan(500);
    expect(seededMerchants(sql).length).toBeGreaterThanOrEqual(12);
    expect(deactivatedMethods(sql)).toEqual(['Installment']);
  });

  it('offers no payment method the migration retired', () => {
    const retired = deactivatedMethods(migrationSql());
    const offered = FALLBACK_OPTIONS.payment_method.map((o) => o.value);
    expect(offered.filter((v) => retired.includes(v))).toEqual([]);
  });

  it('offers exactly the three selectable methods', () => {
    expect(FALLBACK_OPTIONS.payment_method.map((o) => o.value)).toEqual([
      'Merchant',
      'Online',
      'Cash',
    ]);
  });

  it('offers every bank the migration seeds, in its order', () => {
    expect(FALLBACK_OPTIONS.payment_merchant.map((o) => o.value)).toEqual(
      seededMerchants(migrationSql()),
    );
  });

  it('every fallback row is internally consistent', () => {
    for (const [category, rows] of Object.entries(FALLBACK_OPTIONS)) {
      rows.forEach((row, i) => {
        expect(row.category, `${category}[${i}].category`).toBe(category);
        expect(row.sortOrder, `${category}[${i}].sortOrder`).toBe(i + 1);
        expect(row.active, `${category}[${i}].active`).toBe(true);
      });
    }
  });
});

/* The other half of the same defect: a picker that never consults the catalog
   at all. The mobile recorded-payment edit sheet rendered its Method select
   from a hardcoded ["Cash","Merchant","Online","Installment"] while the three
   sub-pickers beside it (Bank / Plan / Online type) already read the live
   catalog — so no fallback fix could have reached it. Source-scanned because
   the assertion is about WHERE the list comes from, which no render test sees:
   a hardcoded list that happens to match today renders identically. */
describe('every mobile payment picker sources from the catalog, not a literal', () => {
  const SHEET = resolve(process.cwd(), 'src/mobile/RecordedPayments.tsx');

  it('the Method select renders catalog options', () => {
    const src = readFileSync(SHEET, 'utf8');
    expect(src).toContain(
      'const methodOpts = withStoredOption(optionsOrFallback("payment_method"',
    );
    expect(src).toContain('{methodOpts.map((o) => <option');
  });

  it('carries no hand-typed payment-method list', () => {
    const src = readFileSync(SHEET, 'utf8');
    // The exact shape that shipped: a literal array of method VALUES. Matching
    // on the values rather than on a variable name, because renaming the
    // constant is not a fix.
    expect(src).not.toMatch(/\[\s*"Cash"\s*,\s*"Merchant"\s*,\s*"Online"/);
    expect(src).not.toMatch(/"installment"\s*:\s*"Installment"/);
  });
});
