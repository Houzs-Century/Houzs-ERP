import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES *_scm_vp_outbox_keep_late_saves.sql against real Postgres: a save
 * that finds its order's outbox row still pending bumps `revision` instead of
 * vanishing, and the drain's mark (`WHERE id = .. AND revision = ..`) then
 * matches nothing, so the row stays pending and the newer state goes out.
 * Before it, ON CONFLICT DO NOTHING folded a save made between the build and
 * the mark into a delivery that never carried it (HC-SO-2609-271).
 *
 * The queue, the three enqueue functions and their triggers are built here as
 * 20260912T1800 / 20260927T0100 left them; the migration is located by SUFFIX.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

let sql: Sql;

async function applyMigration(s: Sql, suffix: string): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await s.begin(async (tx) => { for (const st of stmts) await tx.unsafe(st); });
}

/* Dropped before AND after: every suite in this directory shares houzs_test. */
const DROP_FIXTURE = `
  DROP TABLE IF EXISTS public.projects CASCADE;
  DROP TABLE IF EXISTS scm.mfg_sales_orders, scm.mfg_sales_order_items,
    scm.mfg_sales_order_payments, scm.venture_portal_outbox CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox() CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox_child() CASCADE;
  DROP FUNCTION IF EXISTS scm.enqueue_vp_outbox_project() CASCADE;
`;

type OutboxRow = { id: string; doc_no: string; op: string; status: string; revision: number };

const rows = async (): Promise<OutboxRow[]> =>
  (await sql`SELECT id::text, doc_no, op, status, revision FROM scm.venture_portal_outbox ORDER BY created_at, id`) as unknown as OutboxRow[];

/* The drain's mark, as drainVenturePortalOutbox sends it through PostgREST. */
const markSent = async (id: string, revision: number): Promise<number> =>
  (await sql`UPDATE scm.venture_portal_outbox SET status = 'sent', sent_at = now()
             WHERE id = ${id}::uuid AND revision = ${revision} RETURNING id`).length;

describePg('the order outbox keeps a save made while its delivery is in flight', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);
    await sql.unsafe(`
      CREATE TABLE scm.venture_portal_outbox (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, op text NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
        attempts integer NOT NULL DEFAULT 0, last_error text, portal_outcome text,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        sent_at timestamptz);
      CREATE UNIQUE INDEX venture_portal_outbox_pending_doc_idx
        ON scm.venture_portal_outbox (doc_no) WHERE status = 'pending';

      CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, local_total_sen integer, project_id integer);
      CREATE TABLE scm.mfg_sales_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text NOT NULL, total_sen integer);
      CREATE TABLE scm.mfg_sales_order_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), so_doc_no text NOT NULL, amount_sen integer);
      CREATE TABLE public.projects (id integer PRIMARY KEY, venue text);

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
      CREATE FUNCTION scm.enqueue_vp_outbox_child() RETURNS trigger LANGUAGE plpgsql AS $fn$
      DECLARE keycol text := TG_ARGV[0]; dn text;
      BEGIN
        BEGIN
          dn := COALESCE(to_jsonb(NEW) ->> keycol, to_jsonb(OLD) ->> keycol);
          IF dn IS NOT NULL THEN
            INSERT INTO scm.venture_portal_outbox (doc_no, op)
            VALUES (dn, TG_OP || ':' || TG_TABLE_NAME)
            ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
          END IF;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RETURN NULL;
      END $fn$;
      CREATE FUNCTION scm.enqueue_vp_outbox_project() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN
          INSERT INTO scm.venture_portal_outbox (doc_no, op)
          SELECT so.doc_no, 'UPDATE:projects' FROM scm.mfg_sales_orders so WHERE so.project_id = NEW.id
          ON CONFLICT (doc_no) WHERE status = 'pending' DO NOTHING;
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        RETURN NULL;
      END $fn$;

      CREATE TRIGGER trg_vp_outbox_so AFTER INSERT OR DELETE OR UPDATE OF local_total_sen, project_id
        ON scm.mfg_sales_orders FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox();
      CREATE TRIGGER trg_vp_outbox_items AFTER INSERT OR DELETE OR UPDATE OF total_sen
        ON scm.mfg_sales_order_items FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_child('doc_no');
      CREATE TRIGGER trg_vp_outbox_payments AFTER INSERT OR UPDATE OR DELETE
        ON scm.mfg_sales_order_payments FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_child('so_doc_no');
      CREATE TRIGGER trg_vp_outbox_project AFTER UPDATE OF venue ON public.projects
        FOR EACH ROW EXECUTE FUNCTION scm.enqueue_vp_outbox_project();

      INSERT INTO public.projects (id, venue) VALUES (2212, 'PENANG WATERFRONT CONVENTION CENTRE');
    `);
    await applyMigration(sql, '_scm_vp_outbox_keep_late_saves.sql');
  });

  beforeEach(async () => {
    await sql.unsafe(`
      DELETE FROM scm.mfg_sales_order_items; DELETE FROM scm.mfg_sales_order_payments;
      DELETE FROM scm.mfg_sales_orders; DELETE FROM scm.venture_portal_outbox;
      INSERT INTO scm.mfg_sales_orders (doc_no, local_total_sen, project_id) VALUES ('HC-SO-2609-271', 175000, 2212);
    `);
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  test('a save that finds the order still pending bumps its revision, and the queue keeps one row', async () => {
    const [queued] = await rows();
    expect(queued).toMatchObject({ doc_no: 'HC-SO-2609-271', status: 'pending', revision: 0 });

    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 350000 WHERE doc_no = 'HC-SO-2609-271'`;

    expect(await rows()).toEqual([{ ...queued, revision: 1 }]);
  });

  test('a save between the build and the mark makes the mark miss, so the newer state goes out next', async () => {
    const [read] = await rows();
    /* The drain read the row (revision 0) and built the payload; the header
       total lands now, before the row is marked. */
    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 350000 WHERE doc_no = 'HC-SO-2609-271'`;

    expect(await markSent(read!.id, read!.revision)).toBe(0);
    expect((await rows())[0]).toMatchObject({ status: 'pending', revision: 1 });

    /* The next sweep reads revision 1, sends, and its mark lands. */
    expect(await markSent(read!.id, 1)).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: 'sent' });
  });

  test('a save after the row was marked sent queues a fresh row', async () => {
    const [read] = await rows();
    expect(await markSent(read!.id, read!.revision)).toBe(1);

    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 350000 WHERE doc_no = 'HC-SO-2609-271'`;

    const after = await rows();
    expect(after.map((r) => [r.status, r.revision])).toEqual([['sent', 0], ['pending', 0]]);
  });

  test('a line, a payment and the booth bump the pending row too', async () => {
    await sql`INSERT INTO scm.mfg_sales_order_items (doc_no, total_sen) VALUES ('HC-SO-2609-271', 350000)`;
    await sql`INSERT INTO scm.mfg_sales_order_payments (so_doc_no, amount_sen) VALUES ('HC-SO-2609-271', 200000)`;
    await sql`UPDATE public.projects SET venue = 'PENANG WATERFRONT' WHERE id = 2212`;

    const queue = await rows();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ status: 'pending', revision: 3 });
  });

  test('running the migration again changes nothing, and keeps the revisions counted', async () => {
    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 350000 WHERE doc_no = 'HC-SO-2609-271'`;
    await applyMigration(sql, '_scm_vp_outbox_keep_late_saves.sql');

    expect((await rows())[0]).toMatchObject({ status: 'pending', revision: 1 });
    await sql`UPDATE scm.mfg_sales_orders SET local_total_sen = 360000 WHERE doc_no = 'HC-SO-2609-271'`;
    expect((await rows())[0]).toMatchObject({ revision: 2 });
  });
});
