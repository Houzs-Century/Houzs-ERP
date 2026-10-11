import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; this is the SAME splitter
// pg-migrate.mjs uses, so the replay below is the real one and not a lookalike.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* scm.sales_invoice_items.do_item_id — a column production has and this
 * repository never declared.
 *
 * WHAT WAS WRONG. lib/do-line-remaining.ts derives `invoiced` by summing
 * sales_invoice_items.qty linked through do_item_id, and that term is the cap
 * every DO → Sales Invoice write is checked against. The column existed only in
 * the live database: zero hits for do_item_id under migrations-pg/, and the
 * scm-schema export gives the table a so_item_id and nothing else. A rebuild
 * from this repo produced a table the money guard could not read.
 *
 * WHAT THIS PROVES, and why it needs a real server. Two scratch DATABASES, made
 * fresh here:
 *
 *   si_doitem_missing — the table WITHOUT the column, i.e. what a from-scratch
 *                       rebuild produces today. Applying the migration must ADD
 *                       the column and the FK.
 *   si_doitem_present — the table WITH the column and the FK already, i.e.
 *                       PRODUCTION's shape. Applying the migration must be a
 *                       clean NO-OP that changes nothing and loses no rows.
 *
 * The second is the half that cannot be argued from reading the file: `ADD
 * COLUMN IF NOT EXISTS` is only safe if it is actually a no-op, and the FK guard
 * is a DO block whose catalog query has to match the constraint production
 * really has. Both are executed here, through splitSqlStatements + a transaction
 * — the identical path pg-migrate.mjs takes — so a file that would fail during a
 * deploy fails HERE instead. (docs/migration-gate-coe.md: mig 0290 first met a
 * real server during a deploy.)
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_si_items_do_item_id.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_si_items_do_item_id.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** Replay exactly as pg-migrate.mjs does: split, then one transaction. */
async function applyMigration(sql: Sql): Promise<number> {
  const stmts = splitSqlStatements(await migrationSql()) as string[];
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
  return stmts.length;
}

const MISSING_DB = 'si_doitem_missing';
const PRESENT_DB = 'si_doitem_present';

function urlFor(db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/* The two referenced shapes only, cut to what the migration touches. The
   do_item_id column is deliberately NOT created in the "missing" fixture: the
   migration's ALTER has to be what puts it there, so a broken file fails here
   rather than in a deploy. */
const FIXTURE_BASE = `
  CREATE SCHEMA IF NOT EXISTS scm;
  CREATE TABLE scm.delivery_order_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    item_code text NOT NULL
  );
  CREATE TABLE scm.sales_invoice_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sales_invoice_id uuid NOT NULL,
    so_item_id uuid,
    item_code text NOT NULL,
    qty integer NOT NULL
  );
`;

/* PRODUCTION's shape, transcribed from a pg_dump --schema-only of prod. If this
   ever stops matching the live catalog the "no-op" claim below is worthless, so
   it is written out in full rather than derived from the migration itself. */
const PROD_SHAPE = `
  ALTER TABLE scm.sales_invoice_items ADD COLUMN do_item_id uuid;
  ALTER TABLE scm.sales_invoice_items
    ADD CONSTRAINT sales_invoice_items_do_item_id_fkey
    FOREIGN KEY (do_item_id) REFERENCES scm.delivery_order_items(id) ON DELETE SET NULL;
`;

type ColumnFacts = { data_type: string; is_nullable: string; column_default: string | null };
type FkFacts = { conname: string; confdeltype: string; referenced: string };

async function columnFacts(sql: Sql): Promise<ColumnFacts | null> {
  const rows = await sql<ColumnFacts[]>`
    SELECT data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = 'sales_invoice_items' AND column_name = 'do_item_id'
  `;
  return rows[0] ?? null;
}

async function fkFacts(sql: Sql): Promise<FkFacts | null> {
  const rows = await sql<FkFacts[]>`
    SELECT c.conname, c.confdeltype, ft.relname AS referenced
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class ft ON ft.oid = c.confrelid
    WHERE n.nspname = 'scm' AND t.relname = 'sales_invoice_items'
      AND c.contype = 'f' AND c.conname = 'sales_invoice_items_do_item_id_fkey'
  `;
  return rows[0] ?? null;
}

let admin: Sql;
let missing: Sql;
let present: Sql;

describePg('scm.sales_invoice_items.do_item_id — the migration that declares what production already has', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    if (parsed.pathname !== '/houzs_test') {
      throw new Error('PG integration tests require the disposable houzs_test database');
    }
    admin = postgres(url, { max: 1 });
    for (const db of [MISSING_DB, PRESENT_DB]) {
      // Disposable by construction: dropped and rebuilt every run, so no test
      // can pass on residue another one left behind.
      await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${db}`);
    }
    missing = postgres(urlFor(MISSING_DB), { max: 1 });
    present = postgres(urlFor(PRESENT_DB), { max: 1 });
    await missing.unsafe(FIXTURE_BASE);
    await present.unsafe(FIXTURE_BASE + PROD_SHAPE);
  });

  afterAll(async () => {
    await missing?.end();
    await present?.end();
    if (admin) {
      for (const db of [MISSING_DB, PRESENT_DB]) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      }
      await admin.end();
    }
  });

  test('the fixtures really do differ — one lacks the column, one has it', async () => {
    /* The control. Without it, "both succeeded" could mean the migration ran
       twice against the same shape and proved one thing, not two. */
    expect(await columnFacts(missing)).toBeNull();
    expect(await columnFacts(present)).not.toBeNull();
    expect(await fkFacts(missing)).toBeNull();
    expect(await fkFacts(present)).not.toBeNull();
  });

  test('against a database that LACKS the column, it creates it exactly as production has it', async () => {
    const applied = await applyMigration(missing);
    expect(applied).toBeGreaterThan(0); // a file that split to nothing would "pass" vacuously

    const col = await columnFacts(missing);
    expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });

    const fk = await fkFacts(missing);
    // confdeltype 'n' = ON DELETE SET NULL, which the unlinked-line guard is
    // written around: deleting a DO line must orphan the invoice line, never
    // cascade a revenue row away.
    expect(fk).toEqual({
      conname: 'sales_invoice_items_do_item_id_fkey',
      confdeltype: 'n',
      referenced: 'delivery_order_items',
    });
  });

  test('the link actually works — a DO line delete SET NULLs the invoice line, it does not delete it', async () => {
    await missing`INSERT INTO scm.delivery_order_items (id, item_code)
                  VALUES ('11111111-1111-1111-1111-111111111111', 'ITEM-1')`;
    await missing`INSERT INTO scm.sales_invoice_items (sales_invoice_id, item_code, qty, do_item_id)
                  VALUES ('22222222-2222-2222-2222-222222222222', 'ITEM-1', 4,
                          '11111111-1111-1111-1111-111111111111')`;
    await missing`DELETE FROM scm.delivery_order_items WHERE id = '11111111-1111-1111-1111-111111111111'`;
    const rows = await missing<Array<{ qty: number; do_item_id: string | null }>>`
      SELECT qty, do_item_id FROM scm.sales_invoice_items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(4);
    expect(rows[0]!.do_item_id).toBeNull();
  });

  test('against a database that ALREADY has the column, it succeeds and changes nothing', async () => {
    // A live link, so "changed nothing" includes "lost no data".
    await present`INSERT INTO scm.delivery_order_items (id, item_code)
                  VALUES ('33333333-3333-3333-3333-333333333333', 'ITEM-9')`;
    await present`INSERT INTO scm.sales_invoice_items (sales_invoice_id, item_code, qty, do_item_id)
                  VALUES ('44444444-4444-4444-4444-444444444444', 'ITEM-9', 7,
                          '33333333-3333-3333-3333-333333333333')`;

    const before = { col: await columnFacts(present), fk: await fkFacts(present) };
    await expect(applyMigration(present)).resolves.toBeGreaterThan(0);

    expect(await columnFacts(present)).toEqual(before.col);
    expect(await fkFacts(present)).toEqual(before.fk);
    const rows = await present<Array<{ qty: number; do_item_id: string | null }>>`
      SELECT qty, do_item_id FROM scm.sales_invoice_items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(7);
    expect(rows[0]!.do_item_id).toBe('33333333-3333-3333-3333-333333333333');
  });

  test('applying it a SECOND time to the database it just changed is still a no-op', async () => {
    /* pg-migrate tracks by filename and will not replay a merged file — but a
       tracker can be rebuilt, a database can be restored from before the record,
       and "idempotent (IF NOT EXISTS / ON CONFLICT)" is the stated contract for
       every file in that directory. Hold it to the contract. */
    const before = { col: await columnFacts(missing), fk: await fkFacts(missing) };
    await expect(applyMigration(missing)).resolves.toBeGreaterThan(0);
    expect(await columnFacts(missing)).toEqual(before.col);
    expect(await fkFacts(missing)).toEqual(before.fk);
  });

  test('exactly ONE do_item_id foreign key exists — the DO block did not add a duplicate', async () => {
    for (const sql of [missing, present]) {
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'scm' AND t.relname = 'sales_invoice_items'
          AND c.contype = 'f' AND c.conkey = ARRAY[
            (SELECT attnum FROM pg_attribute
             WHERE attrelid = t.oid AND attname = 'do_item_id')
          ]::smallint[]
      `;
      expect(rows[0]!.n).toBe(1);
    }
  });
});
