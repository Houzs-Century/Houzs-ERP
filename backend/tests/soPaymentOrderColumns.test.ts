/* docs/bugs/0655 — the customer-payment booking hook read `customer_name,
   customer_phone` off `mfg_sales_orders`, columns the order table never had
   (it names its customer `debtor_name` and the phone `phone`), so PostgREST
   refused the read and every customer payment died at `so_read_failed` —
   171 of them in 2990 before the dry run named it. The fake client cannot
   catch a wrong column (it hands back whatever the fixture row carries, and
   the fixture had been written with the same wrong names), so this pins the
   SOURCE: every column the accounting module SELECTs off `mfg_sales_orders`
   must be one the table really has — the CREATE TABLE in the scm schema dump
   plus every ADD COLUMN the pg migrations made since. RED on the unfixed tree
   (`customer_name` twice, `customer_phone` once), green after. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = (rel: string): string => readFileSync(path.resolve(root, rel), 'utf8');

/** The order table's real columns: the CREATE TABLE block of the scm schema
    dump, plus every `ALTER TABLE … mfg_sales_orders ADD COLUMN` since. */
function realColumns(): Set<string> {
  const dump = read('scripts/scm-schema/2990s-full-schema.sql');
  const start = dump.indexOf('CREATE TABLE "mfg_sales_orders" (');
  expect(start, 'the scm schema dump no longer carries CREATE TABLE "mfg_sales_orders"').toBeGreaterThanOrEqual(0);
  const end = dump.indexOf('\n);', start);
  const block = dump.slice(start, end);
  const cols = new Set<string>();
  for (const m of block.matchAll(/^\s*"([a-z_][a-z0-9_]*)"\s/gm)) cols.add(m[1]!);
  const migDir = path.resolve(root, 'src/db/migrations-pg');
  for (const f of readdirSync(migDir)) {
    if (!f.endsWith('.sql')) continue;
    const sql = readFileSync(path.join(migDir, f), 'utf8');
    for (const m of sql.matchAll(/alter\s+table\s+(?:(?:scm|"scm")\.)?"?mfg_sales_orders"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) cols.add(m[1]!);
  }
  return cols;
}

/** Every `.from('mfg_sales_orders') … .select('…')` in the accounting module,
    as [file, column] pairs. Anything fancier than a bare column list fails
    loudly rather than slipping past. */
function selectedColumns(): Array<[string, string]> {
  const dir = path.resolve(root, 'src/acc');
  const out: Array<[string, string]> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
    const src = readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\.from\('mfg_sales_orders'\)\s*\.select\('([^']*)'\)/g)) {
      for (const raw of m[1]!.split(',')) {
        const col = raw.trim();
        expect(col, `${f}: "${col}" is not a bare column name`).toMatch(/^[a-z_][a-z0-9_]*$/);
        out.push([f, col]);
      }
    }
  }
  return out;
}

describe('the accounting module reads only columns mfg_sales_orders really has (docs/bugs/0655)', () => {
  const real = realColumns();
  const selected = selectedColumns();

  it('the schema sources name the table and its customer columns', () => {
    expect(real.size).toBeGreaterThan(80);
    expect(real.has('debtor_name')).toBe(true);
    expect(real.has('phone')).toBe(true);
    expect(real.has('company_id')).toBe(true);
    expect(real.has('customer_name')).toBe(false);
  });

  it('the booking hook and the settlement read both select off the table', () => {
    const files = new Set(selected.map(([f]) => f));
    expect(files.has('payments.ts')).toBe(true);
    expect(files.has('settlement.ts')).toBe(true);
  });

  for (const [file, col] of selected) {
    it(`${file} selects ${col}`, () => {
      expect(real.has(col), `${file}: mfg_sales_orders has no column "${col}" — PostgREST refuses the whole read`).toBe(true);
    });
  }
});
