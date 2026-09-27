import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES the order feed's brand SQL (migration *_scm_so_vp_brand.sql) against
 * real Postgres, on top of the fair migration it extends: the vp_brand column
 * and its not-blank CHECK, the `vpBrand` key every delivery carries, and the
 * capture trigger hearing an answer given after the save.
 *
 * The portal follows vpBrand for a bill whose products name no brand (a bed
 * frame or accessory bill written at a brand's fair), so what matters is that
 * the answer travels with the right order, that `branding` travels unchanged
 * beside it, and that answering later reaches the portal at all.
 *
 * Migration files are located by SUFFIX, never by number: parallel PRs
 * renumber migrations. Runs against CI's postgres:16 (`npm run test:pg`);
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

type Obj = { [k: string]: unknown };

let sql: Sql;

async function applyMigration(s: Sql, suffix: string): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await s.begin(async (tx) => { for (const st of stmts) await tx.unsafe(st); });
  return stmts.length;
}

/* Dropped before AND after: every suite in this directory shares houzs_test. */
const DROP_FIXTURE = `
  DROP TABLE IF EXISTS public.projects, public.project_event_types CASCADE;
  DROP VIEW IF EXISTS scm.mfg_sales_orders_with_payment_totals CASCADE;
  DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.staff, scm.mfg_sales_order_items,
    scm.mfg_sales_order_payments, scm.venture_portal_outbox CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox() CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox_project() CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_build_payloads(text[]) CASCADE;
`;

const pending = async (): Promise<Array<{ doc_no: string; op: string }>> =>
  (await sql`SELECT doc_no, op FROM scm.venture_portal_outbox WHERE status = 'pending' ORDER BY doc_no`) as unknown as Array<{ doc_no: string; op: string }>;

describePg('the order feed carries the brand a bill is for', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);
    await sql.unsafe(`
      CREATE TABLE public.project_event_types (id bigserial PRIMARY KEY, slug text NOT NULL, name text);
      CREATE TABLE public.projects (
        id bigint PRIMARY KEY, code text, name text, venue text, organizer text, brand text,
        start_date text, end_date text, status text, event_type_id bigint, notes text, company_id bigint);

      /* The sources vp_build_payloads reads, with every column the capture
         trigger names -- vp_brand excepted, which the migration adds. The
         payment-totals relation is a VIEW, as in production, and carries
         branding the way production's does. */
      CREATE TABLE scm.mfg_sales_orders (
        doc_no text PRIMARY KEY, salesperson_id uuid, company_id bigint, so_date date,
        status text, on_hold boolean, branding text, agent text, debtor_name text, debtor_code text,
        sales_location text, local_total_sen integer, subtotal_sen integer, balance_sen integer,
        deposit_sen integer, paid_sen integer, delivery_fee_sen integer, total_cost_sen integer,
        total_margin_sen integer, venue text, venue_id uuid, project_id integer, fair_match text,
        fair_date date, remark text);
      CREATE VIEW scm.mfg_sales_orders_with_payment_totals AS
        SELECT doc_no, salesperson_id, branding, local_total_sen, company_id FROM scm.mfg_sales_orders;
      CREATE TABLE scm.staff (id uuid PRIMARY KEY, name text, staff_code text, user_id integer);
      CREATE TABLE scm.mfg_sales_order_items (
        id uuid PRIMARY KEY, doc_no text NOT NULL, line_no integer, created_at timestamptz DEFAULT now(),
        item_code text, variants jsonb);
      CREATE TABLE scm.mfg_sales_order_payments (
        id uuid PRIMARY KEY, so_doc_no text NOT NULL, paid_at date, amount_sen integer,
        created_at timestamptz DEFAULT now());

      /* The queue and its enqueue function exactly as 20260912T1800 made them. */
      CREATE TABLE scm.venture_portal_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, op text NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now());
      CREATE UNIQUE INDEX venture_portal_outbox_pending_doc_idx
        ON scm.venture_portal_outbox (doc_no) WHERE status = 'pending';
      CREATE FUNCTION scm.enqueue_vp_outbox() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN
          INSERT INTO scm.venture_portal_outbox (doc_no, op)
          VALUES (COALESCE(NEW.doc_no, OLD.doc_no), TG_OP)
          ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RETURN NULL;
      END $fn$;

      INSERT INTO public.project_event_types (id, slug, name) VALUES (1, 'exhibition', 'Exhibition');
      /* HC-SO-2609-219's booth as production holds it: project 347, AKEMI at AICC. */
      INSERT INTO public.projects (id, code, name, venue, organizer, brand, start_date, end_date, status, event_type_id, company_id) VALUES
        (347, '2026-09-MEGAHOME-JOHOR-AICC-AUSTIN-AKEMI', 'Johor [AKEMI] MEGAHOME @ AUSTIN INTERNATIONAL CONVENTION CENTRE',
         'AUSTIN INTERNATIONAL CONVENTION CENTRE', 'MEGAHOME', 'AKEMI', '2026-09-25', '2026-09-27', 'confirmed', 1, 1);

      INSERT INTO scm.staff (id, name, staff_code, user_id)
        VALUES ('00000000-0000-0000-0000-0000000000f1', 'Luis Teo', 'EMP-27', 91);
      INSERT INTO scm.mfg_sales_orders (doc_no, salesperson_id, company_id, so_date, branding, local_total_sen, venue, project_id, fair_match) VALUES
        ('HC-SO-BEDFRAME', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-09-21', 'BEDFRAME', 160000, 'MVEC SOUTHKEY', NULL, 'UNMATCHED'),
        ('HC-SO-BOOTH', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-09-25', 'BEDFRAME', 100000,
         'AUSTIN INTERNATIONAL CONVENTION CENTRE', 347, 'PICKED'),
        ('HC-SO-MATTRESS', '00000000-0000-0000-0000-0000000000f1', 1, DATE '2026-09-20', 'AKEMI', 400000, 'MVEC SOUTHKEY', NULL, 'PENDING');
    `);

    await applyMigration(sql, '_scm_vp_order_fair.sql');
    await applyMigration(sql, '_scm_so_vp_brand.sql');
    await sql`DELETE FROM scm.venture_portal_outbox`;
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  /* fetch_types is off (as in production), so postgres.js has no array type
     map: the list travels as one string and is split in SQL. */
  const payloads = async (docNos: string[]): Promise<Obj[]> =>
    (await sql`SELECT scm.vp_build_payloads(string_to_array(${docNos.join(',')}, ',')) AS p`)[0]!.p as Obj[];

  test('an order nobody has answered for carries vpBrand: null, and its branding as before', async () => {
    const [doc] = await payloads(['HC-SO-BEDFRAME']);
    expect(doc).toHaveProperty('vpBrand', null);
    expect(doc!.header).toMatchObject({ doc_no: 'HC-SO-BEDFRAME', branding: 'BEDFRAME' });
  });

  test('an answer travels as vpBrand beside the fair, and branding is left as the products say', async () => {
    await sql`UPDATE scm.mfg_sales_orders SET vp_brand = 'AKEMI' WHERE doc_no IN ('HC-SO-BEDFRAME', 'HC-SO-BOOTH')`;
    const [bedframe, booth] = await payloads(['HC-SO-BEDFRAME', 'HC-SO-BOOTH']);
    expect(bedframe).toMatchObject({ vpBrand: 'AKEMI', fair: null });
    expect(bedframe!.header).toMatchObject({ branding: 'BEDFRAME' });
    expect(booth).toMatchObject({ vpBrand: 'AKEMI', fair: { projectId: 347, brand: 'AKEMI', match: 'PICKED' } });
  });

  test('a deleted document is only {deleted:true}', async () => {
    const [gone] = await payloads(['HC-SO-GONE']);
    expect(gone).toMatchObject({ docNo: 'HC-SO-GONE', deleted: true });
    expect(gone).not.toHaveProperty('vpBrand');
  });

  test('answering after the save queues the order; an unrelated column still does not', async () => {
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE scm.mfg_sales_orders SET remark = 'note only' WHERE doc_no = 'HC-SO-MATTRESS'`;
    expect(await pending()).toEqual([]);
    await sql`UPDATE scm.mfg_sales_orders SET vp_brand = 'ZANOTTI' WHERE doc_no = 'HC-SO-BEDFRAME'`;
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-BEDFRAME', op: 'UPDATE' }]);
    await sql`DELETE FROM scm.venture_portal_outbox`;
    await sql`UPDATE scm.mfg_sales_orders SET vp_brand = NULL WHERE doc_no = 'HC-SO-BEDFRAME'`;
    expect(await pending()).toEqual([{ doc_no: 'HC-SO-BEDFRAME', op: 'UPDATE' }]);
  });

  test('a blank answer is refused -- NULL is the only "no answer"', async () => {
    await expect(sql`UPDATE scm.mfg_sales_orders SET vp_brand = '   ' WHERE doc_no = 'HC-SO-MATTRESS'`)
      .rejects.toThrow(/mfg_sales_orders_vp_brand_not_blank/);
  });

  test('running the migration again changes nothing', async () => {
    await applyMigration(sql, '_scm_so_vp_brand.sql');
    const [doc] = await payloads(['HC-SO-BOOTH']);
    expect(doc).toMatchObject({ vpBrand: 'AKEMI' });
  });
});
