/* Every index table the shared file factory (scm/lib/doc-files.ts) is bound to
   must declare the `kind` column its list reads. 2026-10-16: the product
   request's file table was created without it (20261015T0930) — every upload
   landed, the list read 500, the card said "0 files" (owner: 这个我上传不到文件).
   The fake PostgREST does not know a table's columns, so this pins it from the
   migrations: a DocFilesSpec table with no migration adding `kind` fails here. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROUTES = path.join(__dirname, '../src/scm/routes');
const MIGRATIONS = path.join(__dirname, '../src/db/migrations-pg');

/** The tables named by `table: '…'` in a route that binds the file factory. */
function docFileTables(): string[] {
  const tables = new Set<string>();
  for (const f of readdirSync(ROUTES).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
    const src = readFileSync(path.join(ROUTES, f), 'utf8');
    if (!src.includes('makeDocFileHandlers(')) continue;
    for (const m of src.matchAll(/^\s*table:\s*'([a-z_]+)'/gm)) tables.add(m[1]);
  }
  return [...tables].sort();
}

/** True when a migration gives `table` a `kind` column — inline in its CREATE
    TABLE, or by ALTER TABLE … ADD COLUMN. */
function migrationsDeclareKind(table: string): boolean {
  const create = new RegExp(String.raw`CREATE TABLE IF NOT EXISTS scm\.${table}\s*\(([\s\S]*?)\);`, 'i');
  const alter = new RegExp(String.raw`ALTER TABLE scm\.${table}\s+ADD COLUMN IF NOT EXISTS kind\b`, 'i');
  return readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).some((n) => {
    const sql = readFileSync(path.join(MIGRATIONS, n), 'utf8').replace(/--[^\n]*/g, '');
    const body = create.exec(sql)?.[1] ?? '';
    return /^\s*kind\s+text/m.test(body) || alter.test(sql);
  });
}

describe('every file-factory table carries the kind column the list reads', () => {
  test('the scan sees the real tables (a verdict over nothing is not a pass)', () => {
    expect(docFileTables()).toEqual(expect.arrayContaining(['acc_pv_files', 'acc_payment_request_files', 'product_request_files']));
  });
  test('each table has a migration declaring kind', () => {
    const missing = docFileTables().filter((t) => !migrationsDeclareKind(t));
    expect(missing).toEqual([]);
  });
});
