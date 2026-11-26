import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FALLBACK_OPTIONS } from './so-dropdown-options-queries';


const MIG_0037 = resolve(
  process.cwd(),
  '../backend/src/db/migrations-pg/0037_scm_payment_three_methods.sql',
);

function migrationSql(): string {
  return readFileSync(MIG_0037, 'utf8');
}

function seededMerchants(sql: string): string[] {
  const block = sql.split("INSERT INTO scm.so_dropdown_options")[1] ?? '';
  return [...block.matchAll(/\('payment_merchant',\s*'([^']+)'/g)].map((m) => m[1]!);
}

function deactivatedMethods(sql: string): string[] {
  return [...sql.matchAll(/SET active = false[\s\S]*?value = '([^']+)'/g)].map((m) => m[1]!);
}

describe('the payment fallbacks match the migration that defines them', () => {
  it('the parsers actually matched — a verdict over nothing is not a pass', () => {
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

describe('every mobile payment picker sources from the catalog, not a literal', () => {
  const SHEET = resolve(process.cwd(), 'src/mobile/RecordedPayments.tsx');

  it('the Method select renders catalog options', () => {
    const src = readFileSync(SHEET, 'utf8');
    /* The catalog, the stored value kept, and — docs/bugs/0933 — the one option
       that is not a maintenance row: money moved from a cancelled order. */
    expect(src).toContain(
      'const methodOpts = withConvertOption(withStoredOption(optionsOrFallback("payment_method"',
    );
    expect(src).toContain('{methodOpts.map((o) => <option');
  });

  it('carries no hand-typed payment-method list', () => {
    const src = readFileSync(SHEET, 'utf8');
    expect(src).not.toMatch(/\[\s*"Cash"\s*,\s*"Merchant"\s*,\s*"Online"/);
    expect(src).not.toMatch(/"installment"\s*:\s*"Installment"/);
  });
});
