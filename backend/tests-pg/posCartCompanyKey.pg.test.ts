import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* END-TO-END PROOF that mig *_scm_pos_cart_company_key actually re-keys the POS
 * cart, against real Postgres — the half no unit test can reach, because the bug
 * IS the key and a fake PostgREST client has no keys.
 *
 * The bug being closed: scm.pos_carts arrived from the 2990 import keyed
 * `staff_id uuid PRIMARY KEY`. Mig 0100 added company_id so the route could scope
 * carts per company but left the PRIMARY KEY untouched, so the table could still
 * hold only ONE row per salesperson across both companies. A both-company
 * salesperson who built a Houzs cart, switched to 2990 and saved anything had the
 * Houzs cart silently replaced — the scoped GET then found nothing and the loss
 * looked exactly like "I never saved it".
 *
 * These tests drive the migration itself, then assert the behaviour that was
 * impossible before it: two carts, same staff, different companies, neither
 * touching the other.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely, and a
// number-pinned read would silently resolve to nothing and pass vacuously.
async function posCartMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_pos_cart_company_key.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_pos_cart_company_key.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
}

const STAFF = '33333333-3333-3333-3333-333333333333';
const STAFF2 = '33333333-3333-3333-3333-444444444444';
const HOUZS = 1;
const CO2990 = 2;

let admin: Sql;

/** The table EXACTLY as it stood before this migration: mig 0100's shape. */
async function resetToPre0284(sql: Sql, opts: { seed?: 'houzs' | 'null' | 'none' } = {}): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;

    DROP TABLE IF EXISTS scm.pos_carts CASCADE;
    DROP TABLE IF EXISTS public.companies CASCADE;

    CREATE TABLE public.companies (
      id bigint PRIMARY KEY,
      code text
    );
    INSERT INTO public.companies (id, code) VALUES (${HOUZS}, 'HOUZS'), (${CO2990}, '2990');

    -- scripts/scm-schema/2990s-full-schema.sql:930 + mig 0100's added column.
    CREATE TABLE scm.pos_carts (
      staff_id        uuid PRIMARY KEY NOT NULL,
      lines           jsonb NOT NULL DEFAULT '[]'::jsonb,
      source_quote_id text,
      updated_at      timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE scm.pos_carts ADD COLUMN company_id bigint;
  `);

  if (opts.seed === 'houzs') {
    await sql`INSERT INTO scm.pos_carts (staff_id, lines, company_id) VALUES (${STAFF}::uuid, '[{"sku":"HOUZS-A"}]'::jsonb, ${HOUZS})`;
  } else if (opts.seed === 'null') {
    await sql`INSERT INTO scm.pos_carts (staff_id, lines, company_id) VALUES (${STAFF}::uuid, '[{"sku":"LEGACY"}]'::jsonb, NULL)`;
  }
}

const applyMigration = async (sql: Sql) => sql.unsafe(await posCartMigrationSql());

/** The primary key's columns, in order — what the whole migration is about. */
async function pkColumns(sql: Sql): Promise<string[]> {
  const rows = await sql<{ attname: string }[]>`
    SELECT a.attname
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = 'scm' AND c.relname = 'pos_carts' AND con.contype = 'p'
    ORDER BY k.ord
  `;
  return rows.map((r) => r.attname);
}

describePg('POS cart re-key (mig *_scm_pos_cart_company_key) against real Postgres', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetToPre0284(admin, { seed: 'houzs' }); });

  test('the pre-migration key is the single column this bug is made of', async () => {
    // Asserted BEFORE applying, so the fixture cannot silently drift into
    // already-fixed and make every test below pass vacuously.
    expect(await pkColumns(admin)).toEqual(['staff_id']);
  });

  test('after the migration the key is (staff_id, company_id)', async () => {
    await applyMigration(admin);
    expect(await pkColumns(admin)).toEqual(['staff_id', 'company_id']);
  });

  test('an existing cart SURVIVES the re-key — this must not be a data wipe', async () => {
    await applyMigration(admin);
    const rows = await admin`SELECT lines, company_id FROM scm.pos_carts WHERE staff_id = ${STAFF}::uuid`;
    expect(rows).toHaveLength(1);
    // Number(): postgres.js hands bigint back as a string, so a bare toBe(1) fails
    // on the driver's type rather than on the behaviour under test.
    expect(Number(rows[0]!.company_id)).toBe(HOUZS);
    expect(JSON.stringify(rows[0]!.lines)).toContain('HOUZS-A');
  });

  test('THE BUG: two companies can now hold a cart for the SAME salesperson', async () => {
    await applyMigration(admin);
    // Before the migration this INSERT was a primary-key violation, which is why
    // the route's upsert overwrote instead of inserting.
    await admin`INSERT INTO scm.pos_carts (staff_id, lines, company_id) VALUES (${STAFF}::uuid, '[{"sku":"2990-B"}]'::jsonb, ${CO2990})`;
    const rows = await admin`SELECT company_id, lines FROM scm.pos_carts WHERE staff_id = ${STAFF}::uuid ORDER BY company_id`;
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows[0]!.lines)).toContain('HOUZS-A');
    expect(JSON.stringify(rows[1]!.lines)).toContain('2990-B');
  });

  test("the route's ON CONFLICT target updates only the caller's company row", async () => {
    /* The exact statement PostgREST issues for
       `.upsert({...}, { onConflict: 'staff_id,company_id' })`. Saving in 2990
       must leave the Houzs cart byte-identical — that is the whole bug. */
    await applyMigration(admin);
    await admin`
      INSERT INTO scm.pos_carts (staff_id, lines, company_id)
      VALUES (${STAFF}::uuid, '[{"sku":"2990-B"}]'::jsonb, ${CO2990})
      ON CONFLICT (staff_id, company_id) DO UPDATE SET lines = EXCLUDED.lines
    `;
    await admin`
      INSERT INTO scm.pos_carts (staff_id, lines, company_id)
      VALUES (${STAFF}::uuid, '[{"sku":"2990-C"}]'::jsonb, ${CO2990})
      ON CONFLICT (staff_id, company_id) DO UPDATE SET lines = EXCLUDED.lines
    `;
    const houzs = await admin`SELECT lines FROM scm.pos_carts WHERE staff_id = ${STAFF}::uuid AND company_id = ${HOUZS}`;
    const other = await admin`SELECT lines FROM scm.pos_carts WHERE staff_id = ${STAFF}::uuid AND company_id = ${CO2990}`;
    expect(JSON.stringify(houzs[0]!.lines)).toContain('HOUZS-A');
    expect(JSON.stringify(other[0]!.lines)).toContain('2990-C');
  });

  test('re-running the migration is a no-op, not a second key swap', async () => {
    await applyMigration(admin);
    await applyMigration(admin);
    expect(await pkColumns(admin)).toEqual(['staff_id', 'company_id']);
    const rows = await admin`SELECT count(*)::int AS n FROM scm.pos_carts`;
    expect(rows[0]!.n).toBe(1);
  });

  test('a legacy NULL-company cart is backfilled to HOUZS, not dropped', async () => {
    await resetToPre0284(admin, { seed: 'null' });
    await applyMigration(admin);
    const rows = await admin`SELECT company_id, lines FROM scm.pos_carts WHERE staff_id = ${STAFF}::uuid`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.company_id)).toBe(HOUZS);
    expect(JSON.stringify(rows[0]!.lines)).toContain('LEGACY');
  });

  test('with no HOUZS row to backfill to, the unkeyable cart is dropped rather than blocking the migration', async () => {
    /* Stated so nobody has to rediscover it: this branch only fires on a DB whose
       companies master has no HOUZS row (a fresh/unseeded environment). Such a
       cart is already invisible to the scoped GET, so nothing readable is lost —
       and the alternative is a NOT NULL that fails the deploy. */
    await resetToPre0284(admin, { seed: 'null' });
    await admin`DELETE FROM public.companies WHERE code = 'HOUZS'`;
    await applyMigration(admin);
    expect(await pkColumns(admin)).toEqual(['staff_id', 'company_id']);
    const rows = await admin`SELECT count(*)::int AS n FROM scm.pos_carts`;
    expect(rows[0]!.n).toBe(0);
  });

  test('company_id is NOT NULL after the migration', async () => {
    await applyMigration(admin);
    await expect(
      admin`INSERT INTO scm.pos_carts (staff_id, lines, company_id) VALUES (${STAFF2}::uuid, '[]'::jsonb, NULL)`,
    ).rejects.toThrow();
  });
});
