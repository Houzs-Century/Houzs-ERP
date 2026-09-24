import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * The fair DAY an order was written on (owner 2026-09-24) reaches the row on an
 * EDIT through scm.apply_so_header_cas, whose SET list is read from the table's
 * own columns at call time — so the column 20260924T1600 added is written with no
 * change to the function. Owner, same day, about orders already written: 「他在
 * edit 的时候，是不是也能够有一样的功能？…system 是否能 capture 到」. Proved here
 * on a real Postgres, since staging cannot run the function for its worker role.
 * Fixture: exactly the columns the function names, as in
 * soHeaderCasSkipsFrozenLines.pg.test.ts, plus the real fair_date migration.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

let admin: Sql;

const migration = (name: string) => readFile(
  fileURLToPath(new URL(`../src/db/migrations-pg/${name}`, import.meta.url)),
  'utf8',
);

const DOC = 'HC-SO-2609-053';

async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY,
      version integer NOT NULL DEFAULT 1,
      edit_lease_token text,
      edit_lease_expires_at timestamptz,
      customer_id uuid,
      customer_delivery_date date,
      note text
    );
    CREATE TABLE scm.mfg_sales_order_items (
      id uuid PRIMARY KEY,
      doc_no text NOT NULL,
      line_delivery_date date,
      line_delivery_date_overridden boolean NOT NULL DEFAULT false,
      warehouse_id uuid,
      cancelled boolean NOT NULL DEFAULT false
    );
    CREATE TABLE scm.delivery_orders (id uuid PRIMARY KEY, so_doc_no text, status text NOT NULL);
    CREATE TABLE scm.delivery_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_order_id uuid NOT NULL, so_item_id uuid);
    CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY, so_doc_no text, status text NOT NULL);
    CREATE TABLE scm.sales_invoice_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_invoice_id uuid NOT NULL, so_item_id uuid, do_item_id uuid);
    CREATE TABLE scm.pwp_codes (source_doc_no text, customer_id uuid, updated_at timestamptz);
    CREATE FUNCTION scm.upsert_customer_by_name_phone(text, text, text, bigint) RETURNS uuid
      LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
  `);
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
      END IF;
    END $$;
  `);
  await sql.unsafe(await migration('20260915T1200_scm_so_header_cas_skip_frozen_lines.sql'));
  await sql.unsafe(await migration('20260924T1600_scm_so_fair_date.sql'));
}

/** One header edit at `version`, the way the PATCH route calls it (no lease). */
const cas = (sql: Sql, version: number, patch: Record<string, unknown>) => sql.unsafe(
  `SELECT * FROM scm.apply_so_header_cas(
     p_doc_no => $1, p_expected_version => $2, p_required_lease => NULL, p_patch => $3::jsonb)`,
  [DOC, version, admin.json(patch as never)],
);

const row = async (sql: Sql) => (await sql.unsafe(
  `SELECT to_char(fair_date, 'YYYY-MM-DD') AS fair_date, note, version FROM scm.mfg_sales_orders WHERE doc_no = $1`,
  [DOC],
))[0] as { fair_date: string | null; note: string | null; version: number };

describePg('an edit stores the fair DAY through apply_so_header_cas (20260924T1600)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await resetFixture(admin);
    /* An order written before the day was recorded: no fair_date yet. */
    await admin.unsafe(`INSERT INTO scm.mfg_sales_orders (doc_no, version, note) VALUES ('${DOC}', 1, 'old order')`);
  });

  test('the migration adds fair_date as a nullable date', async () => {
    const [col] = await admin.unsafe(`
      SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = 'mfg_sales_orders' AND column_name = 'fair_date'`);
    expect(col).toMatchObject({ data_type: 'date', is_nullable: 'YES' });
    expect(await row(admin)).toMatchObject({ fair_date: null, note: 'old order' });
  });

  test('an old order edited to add its day stores that day', async () => {
    const [res] = await cas(admin, 1, { fair_date: '2026-09-05', version: 2 });
    expect(res).toMatchObject({ applied: true });
    expect(await row(admin)).toEqual({ fair_date: '2026-09-05', note: 'old order', version: 2 });
  });

  test('an edit that does not carry the day leaves the saved day alone', async () => {
    await cas(admin, 1, { fair_date: '2026-09-05', version: 2 });
    const [res] = await cas(admin, 2, { note: 'new note', version: 3 });
    expect(res).toMatchObject({ applied: true });
    expect(await row(admin)).toEqual({ fair_date: '2026-09-05', note: 'new note', version: 3 });
  });

  test('an edit that drops the event clears the day', async () => {
    await cas(admin, 1, { fair_date: '2026-09-05', version: 2 });
    await cas(admin, 2, { fair_date: null, version: 3 });
    expect(await row(admin)).toMatchObject({ fair_date: null, version: 3 });
  });

  test('a stale version writes nothing, the day included', async () => {
    const [res] = await cas(admin, 7, { fair_date: '2026-09-05', version: 8 });
    expect(res).toMatchObject({ applied: false, conflict_reason: 'version' });
    expect(await row(admin)).toMatchObject({ fair_date: null, version: 1 });
  });

  test('re-running the migration is harmless and keeps the saved day', async () => {
    await cas(admin, 1, { fair_date: '2026-09-05', version: 2 });
    await admin.unsafe(await migration('20260924T1600_scm_so_fair_date.sql'));
    expect(await row(admin)).toMatchObject({ fair_date: '2026-09-05' });
  });
});
