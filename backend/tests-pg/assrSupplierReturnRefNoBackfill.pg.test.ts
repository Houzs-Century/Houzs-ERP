import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { applyDocNoCounterMigration, assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* The SVC-RTN backfill (owner 2026-09-24: every supplier return gets its own
 * document number, "旧的也补号"). It runs ONCE, on deploy, against the 137
 * live trips, through a PL/pgSQL loop that D1 cannot execute — so it is proven
 * here, on real Postgres, replaying the real migration files the way
 * pg-migrate.mjs does (split, one transaction).
 *
 * The table is built in PRODUCTION's shape, not the 20260921T2300 file's:
 * created_at is TEXT ('YYYY-MM-DD HH:MM:SS', UTC) in prod, checked live on
 * 2026-09-24. A backfill written against the file's timestamptz would have
 * failed the deploy. Migrations are located by SUFFIX, never by number. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyBySuffix(sql: Sql, suffix: string): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix}, found ${files.length}: ${files.join(', ')}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
  return stmts.length;
}

let sql: Sql;

const refs = () => sql<{ id: number; ref_no: string | null }[]>`
  SELECT id::int AS id, ref_no FROM public.assr_supplier_returns ORDER BY id`;

describePg('supplier-return SVC-RTN backfill', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS scm CASCADE;
      CREATE SCHEMA scm;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA scm TO service_role;
      CREATE TABLE scm.mfg_sales_orders  (doc_no         text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.purchase_orders   (po_number      text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.delivery_orders   (do_number      text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.sales_invoices    (invoice_number text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.purchase_invoices (invoice_number text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.grns              (grn_number     text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.trips             (trip_no        text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.journal_entries   (je_no          text PRIMARY KEY, company_id bigint);
      CREATE TABLE scm.autocount_outbox  (doc_no         text NOT NULL);

      DROP TABLE IF EXISTS public.document_refs, public.document_types, public.assr_supplier_returns;
      CREATE TABLE IF NOT EXISTS public.departments (id bigint PRIMARY KEY, name text);
      CREATE TABLE public.assr_supplier_returns (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        assr_id bigint NOT NULL,
        round_no integer NOT NULL,
        created_by bigint,
        created_at text NOT NULL,
        archived_at text
      );
    `);
    await applyDocNoCounterMigration(sql);
    await applyBySuffix(sql, '_departments_code_document_refs.sql');

    // Inserted out of creation order on purpose: numbering follows created_at.
    await sql`
      INSERT INTO public.assr_supplier_returns (assr_id, round_no, created_by, created_at, archived_at) VALUES
        (10, 2, 7,    '2026-09-23 04:00:00', NULL),
        (10, 1, NULL, '2026-09-21 13:17:12', NULL),
        (11, 1, 7,    '2026-09-22 09:00:00', '2026-09-22 10:00:00'),
        (12, 1, 7,    '2026-09-30 17:30:00', NULL)`;
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`
      DROP TABLE IF EXISTS public.document_refs, public.document_types, public.assr_supplier_returns;
      DROP SCHEMA IF EXISTS scm CASCADE;`);
    await sql.end();
  });

  test('numbers every live trip in creation order, per MYT month; archived trips get none', async () => {
    expect(await applyBySuffix(sql, '_assr_supplier_return_ref_no.sql')).toBeGreaterThan(3);
    expect(await refs()).toEqual([
      { id: 1, ref_no: 'SVC-RTN-2609-0002' },
      { id: 2, ref_no: 'SVC-RTN-2609-0001' },
      { id: 3, ref_no: null },
      // 17:30 UTC on 30 Sep is 01:30 MYT on 1 Oct.
      { id: 4, ref_no: 'SVC-RTN-2610-0001' },
    ]);
    const registry = await sql`
      SELECT ref_no, entity_type, entity_id, status, created_by, created_at
        FROM public.document_refs ORDER BY ref_no`;
    expect(registry).toEqual([
      { ref_no: 'SVC-RTN-2609-0001', entity_type: 'assr_supplier_return', entity_id: '2', status: 'ACTIVE', created_by: null, created_at: '2026-09-21T13:17:12Z' },
      { ref_no: 'SVC-RTN-2609-0002', entity_type: 'assr_supplier_return', entity_id: '1', status: 'ACTIVE', created_by: 7, created_at: '2026-09-23T04:00:00Z' },
      { ref_no: 'SVC-RTN-2610-0001', entity_type: 'assr_supplier_return', entity_id: '4', status: 'ACTIVE', created_by: 7, created_at: '2026-09-30T17:30:00Z' },
    ]);
  });

  test('the counter is left past the backfill, so the app continues at 0003 — never re-issues', async () => {
    const [row] = await sql<{ n: number }[]>`SELECT scm.next_doc_no_n('SVC-RTN-2609', 0) AS n`;
    expect(row!.n).toBe(3);
  });

  test('re-running the migration changes nothing', async () => {
    const before = await refs();
    await applyBySuffix(sql, '_assr_supplier_return_ref_no.sql');
    expect(await refs()).toEqual(before);
    const [{ c }] = await sql<{ c: number }[]>`SELECT count(*)::int AS c FROM public.document_refs`;
    expect(c).toBe(3);
  });
});
