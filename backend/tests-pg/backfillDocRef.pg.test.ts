import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { countSql, fillSql, mismatchSql } from '../scripts/lib/backfill-doc-ref.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* The exact statements scripts/backfill-do-si-ref.mjs runs on production
 * (owner 2026-09-25: "回填 DO/SI 的空 Ref"), on real Postgres. Proves: only an
 * empty ref is filled; a row whose customer_so_no names a DIFFERENT reference is
 * a conflict and is never written; the SO must be the same company; a re-run
 * writes nothing. SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
let sql: Sql;

describePg('backfill DO / SI ref from the Sales Order', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS scm;
      DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.delivery_orders, scm.sales_invoices;
      CREATE TABLE scm.mfg_sales_orders (doc_no text, company_id bigint, ref text, customer_so_no text);
      CREATE TABLE scm.delivery_orders (id text PRIMARY KEY, so_doc_no text, company_id bigint, ref text, customer_so_no text);
      CREATE TABLE scm.sales_invoices  (id text PRIMARY KEY, so_doc_no text, company_id bigint, ref text, customer_so_no text);
      INSERT INTO scm.mfg_sales_orders VALUES
        ('SO-1', 1, 'HC100', NULL), ('SO-2', 1, ' ZNT7 ', NULL), ('SO-3', 1, NULL, NULL), ('SO-1', 2, 'OTHER-CO', NULL);
      INSERT INTO scm.delivery_orders VALUES
        ('do-empty',    'SO-1', 1, NULL,  NULL),
        ('do-blank',    'SO-2', 1, '  ',  'ZNT7'),
        ('do-same',     'SO-1', 1, '',    'HC100'),
        ('do-conflict', 'SO-1', 1, NULL,  'HC999'),
        ('do-has-ref',  'SO-1', 1, 'KEEP', NULL),
        ('do-no-soref', 'SO-3', 1, NULL,  NULL),
        ('do-other-co', 'SO-1', 3, NULL,  NULL);
      INSERT INTO scm.sales_invoices VALUES ('si-empty', 'SO-1', 1, NULL, NULL);
    `);
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.delivery_orders, scm.sales_invoices`);
    await sql.end();
  });

  test('counts fillable rows and conflicts', async () => {
    expect((await sql.unsafe(countSql('delivery_orders')))[0]).toEqual({ fillable: 3, conflict: 1 });
    expect((await sql.unsafe(countSql('sales_invoices')))[0]).toEqual({ fillable: 1, conflict: 0 });
  });

  test('fills only the fillable rows, with the SO ref trimmed', async () => {
    const ids = (await sql.unsafe(fillSql('delivery_orders'))).map((r) => r.id).sort();
    expect(ids).toEqual(['do-blank', 'do-empty', 'do-same']);
    const rows = await sql`SELECT id, ref FROM scm.delivery_orders ORDER BY id`;
    expect(Object.fromEntries(rows.map((r) => [r.id, r.ref]))).toEqual({
      'do-blank': 'ZNT7', 'do-conflict': null, 'do-empty': 'HC100', 'do-has-ref': 'KEEP',
      'do-no-soref': null, 'do-other-co': null, 'do-same': 'HC100',
    });
    expect((await sql.unsafe(mismatchSql('delivery_orders'), [ids]))[0]!.n).toBe(0);
  });

  test('a re-run writes nothing and leaves the conflict counted', async () => {
    expect(await sql.unsafe(fillSql('delivery_orders'))).toHaveLength(0);
    expect((await sql.unsafe(countSql('delivery_orders')))[0]).toEqual({ fillable: 0, conflict: 1 });
  });
});
