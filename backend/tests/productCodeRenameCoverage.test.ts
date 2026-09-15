// Every column that stores a product code either follows a SKU rename or says why not.
//
// Owner 2026-09-14: 「如果我要换 product code 应该怎么样呢」. A rename
// (PATCH /mfg-products/:id) re-points text snapshots, because nothing holds a
// foreign key to mfg_products.code. The cascade had 22 columns; production had
// more that store the code — pending SO/PO amendment lines, the consignment
// line tables, the effective-dated price history, a service add-on's SKU — so a
// rename stranded them under a code that no longer exists.
//
// The universe is production's own catalog (fixtures/product-code-columns.snapshot.json,
// written by backend/scripts/probe-product-code-columns.mjs) plus every migration
// newer than that snapshot, so a column added tomorrow fails here until it is
// placed in one of the two lists in src/scm/lib/product-code-rename.ts.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { PRODUCT_CODE_CASCADE, PRODUCT_CODE_KEEPS_VALUE } from '../src/scm/lib/product-code-rename';

/* Keep in step with CODE_COLUMN in backend/scripts/probe-product-code-columns.mjs. */
const CODE_COLUMN = /(^|_)(item_code|product_code|material_code|sku|model_code)$/;

interface SnapshotColumn { schema: string; table: string; column: string; companyId: boolean; materialKind: boolean }
const snapshot = JSON.parse(
  readFileSync(path.join(__dirname, 'fixtures/product-code-columns.snapshot.json'), 'utf8'),
) as { newestMigrationAtCapture: string; columns: SnapshotColumn[] };

const MIGRATIONS = path.join(__dirname, '../src/db/migrations-pg');

/** schema.table.column for every code-bearing column a migration creates, adds or renames to. */
function codeColumnsInSql(sqlText: string): string[] {
  const sql = sqlText.replace(/--[^\n]*/g, '');
  const found = new Set<string>();
  const qualify = (name: string) => {
    const bare = name.replace(/"/g, '').toLowerCase();
    return bare.includes('.') ? bare : `public.${bare}`;
  };
  const ident = String.raw`((?:"?\w+"?\.)?"?\w+"?)`;
  for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(([\s\S]*?)\)\s*;`, 'gi'))) {
    const table = qualify(m[1]);
    for (const part of m[2].split(/,(?![^(]*\))/)) {
      const col = /^\s*"?(\w+)"?\s+\w/.exec(part)?.[1]?.toLowerCase();
      if (col && CODE_COLUMN.test(col)) found.add(`${table}.${col}`);
    }
  }
  for (const m of sql.matchAll(new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}([^;]*);`, 'gi'))) {
    const table = qualify(m[1]);
    for (const a of m[2].matchAll(/(?:ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?|RENAME\s+COLUMN\s+"?\w+"?\s+TO\s+)"?(\w+)"?/gi)) {
      const col = a[1].toLowerCase();
      if (CODE_COLUMN.test(col)) found.add(`${table}.${col}`);
    }
  }
  return [...found];
}

const cascaded = new Set(PRODUCT_CODE_CASCADE.map((c) => `scm.${c.table}.${c.col}`));
const kept = new Set(PRODUCT_CODE_KEEPS_VALUE.map((k) => k.column));
const live = new Map(snapshot.columns.map((c) => [`${c.schema}.${c.table}.${c.column}`, c]));

describe('the migration scanner sees what it claims to (a verdict over nothing is not a pass)', () => {
  test('finds a created, an added and a renamed code column, and nothing else', () => {
    expect(codeColumnsInSql(`
      CREATE TABLE IF NOT EXISTS scm.widget_lines (id uuid PRIMARY KEY, item_code text NOT NULL, qty numeric(12,2), note text);
      ALTER TABLE scm.widget_lines ADD COLUMN IF NOT EXISTS new_item_code text, ADD COLUMN company_id bigint;
      ALTER TABLE scm.other RENAME COLUMN material_code TO item_code;
      -- ALTER TABLE scm.commented ADD COLUMN item_code text;
    `).sort()).toEqual(['scm.other.item_code', 'scm.widget_lines.item_code', 'scm.widget_lines.new_item_code']);
  });

  test('reads the real migration tree', () => {
    const all = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(all.length).toBeGreaterThan(300);
    expect(codeColumnsInSql(readFileSync(path.join(MIGRATIONS, '0308_po_amendment_lines_item_code.sql'), 'utf8')))
      .toContain('scm.po_amendment_lines.new_item_code');
  });
});

describe('every code-bearing column is decided', () => {
  test('the production snapshot is not empty and holds the columns everyone knows', () => {
    expect(snapshot.columns.length).toBeGreaterThan(50);
    expect(live.has('scm.mfg_sales_order_items.item_code')).toBe(true);
  });

  test('each live column is cascaded or recorded as keeping its value', () => {
    const undecided = [...live.keys()].filter((k) => !cascaded.has(k) && !kept.has(k));
    expect(undecided).toEqual([]);
  });

  test('each code column a migration newer than the snapshot adds is decided too', () => {
    const newer = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f > snapshot.newestMigrationAtCapture);
    const undecided = newer.flatMap((f) => codeColumnsInSql(readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      .filter((k) => !cascaded.has(k) && !kept.has(k))
      .map((k) => `${f}: ${k}`));
    expect(undecided).toEqual([]);
  });

  test('no column is in both lists', () => {
    expect([...cascaded].filter((k) => kept.has(k))).toEqual([]);
  });

  test('no recorded column has disappeared from production', () => {
    expect([...kept].filter((k) => !live.has(k))).toEqual([]);
  });
});

describe('every cascaded column can be renamed safely', () => {
  test('exists on production, carries company_id, and is scoped to SKUs where the table also holds fabrics', () => {
    const problems = PRODUCT_CODE_CASCADE.flatMap((c) => {
      const key = `scm.${c.table}.${c.col}`;
      const col = live.get(key);
      if (!col) return [`${key}: not on production`];
      return [
        ...(col.companyId ? [] : [`${key}: no company_id, the rename cannot be company-scoped`]),
        ...(col.materialKind && !c.kind ? [`${key}: table holds material_kind but the rename is not scoped to mfg_product`] : []),
        ...(!col.materialKind && c.kind ? [`${key}: scoped by material_kind, which the table does not have`] : []),
      ];
    });
    expect(problems).toEqual([]);
  });
});
