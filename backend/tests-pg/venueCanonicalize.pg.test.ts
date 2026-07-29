import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Real PostgreSQL proof for the venue-canonicalization trigger (mig 0229).
   The three previous attempts at this bug were all one-shot backfills that
   drifted back, and the TS front door that followed can be bypassed by any
   write that does not go through a route. So the guard now lives in the
   database — and a database guard nobody has ever executed is a guard nobody
   should trust. This suite runs the migration against the postgres:16 service
   container in CI (`backend-postgres` -> `npm run test:pg`) and writes rows the
   way a rogue INSERT would.

   Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — this file gets renumbered whenever a parallel PR
// takes its slot, and a number-pinned read would silently resolve to nothing.
async function venueMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_venue_canonicalize.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_venue_canonicalize.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return readFile(join(migrationsDir, files[0]), 'utf8');
}

let admin: Sql;

/* The four columns the migration attaches to, cut down to the shape the trigger
   needs. project_venues.name is deliberately NOT NULL, mirroring production:
   it is what proves the function never turns a blank into a NULL. */
async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;

    DROP TABLE IF EXISTS public.projects CASCADE;
    CREATE TABLE public.projects (id serial PRIMARY KEY, venue text);

    DROP TABLE IF EXISTS public.project_venues CASCADE;
    CREATE TABLE public.project_venues (id serial PRIMARY KEY, name text NOT NULL);

    DROP TABLE IF EXISTS scm.mfg_sales_orders CASCADE;
    CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, venue text);

    DROP TABLE IF EXISTS scm.warehouses CASCADE;
    CREATE TABLE scm.warehouses (id serial PRIMARY KEY, venue_name text);
  `);

  await sql.unsafe(await venueMigrationSql());
}

describePg('venue canonicalization trigger (migrations-pg *_venue_canonicalize.sql)', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4 });
    await resetFixture(admin);
  });

  afterAll(async () => {
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.unsafe(`
      TRUNCATE public.projects, public.project_venues, scm.mfg_sales_orders, scm.warehouses;
    `);
  });

  test('the migration attaches a trigger to every venue-name column', async () => {
    const rows = await admin<Array<{ tgname: string; tbl: string }>>`
      SELECT t.tgname, (c.relnamespace::regnamespace::text || '.' || c.relname) AS tbl
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
       WHERE NOT t.tgisinternal
         AND t.tgname LIKE 'trg_%_canonicalize_%'
    `;
    // Sorted in JS, not by ORDER BY: the server's collation decides whether
    // "project_venues" sorts before or after "projects", and this assertion must
    // not depend on which locale the container was initdb'd with.
    expect(rows.map((r) => `${r.tbl}:${r.tgname}`).sort()).toEqual([
      'public.project_venues:trg_project_venues_canonicalize_name',
      'public.projects:trg_projects_canonicalize_venue',
      'scm.mfg_sales_orders:trg_mfg_sales_orders_canonicalize_venue',
      'scm.warehouses:trg_warehouses_canonicalize_venue_name',
    ]);
  });

  test('the mapper folds every known alias and is idempotent', async () => {
    const [row] = await admin<Array<Record<string, string | null>>>`
      SELECT scm.canonicalize_venue('PJ Showroom')      AS a,
             scm.canonicalize_venue('pj-showroom')      AS b,
             scm.canonicalize_venue('PJSHOWROOM')       AS c,
             scm.canonicalize_venue('  PJ   Showroom ') AS d,
             scm.canonicalize_venue('2990 pj')          AS e,
             scm.canonicalize_venue('2990PJ')           AS f,
             scm.canonicalize_venue('2990s pj')         AS g,
             scm.canonicalize_venue(scm.canonicalize_venue('PJ Showroom')) AS twice
    `;
    expect(Object.values(row)).toEqual(Array(8).fill('2990s PJ'));
  });

  test('an unknown venue is trimmed but never rewritten', async () => {
    const [row] = await admin<Array<{ hall: string; sunway: string }>>`
      SELECT scm.canonicalize_venue('  KLCC Hall 3 ') AS hall,
             scm.canonicalize_venue('Sunway Pyramid') AS sunway
    `;
    expect(row.hall).toBe('KLCC Hall 3');
    expect(row.sunway).toBe('Sunway Pyramid');
  });

  test('NULL and blank come back untouched — a blank venue is never filled or nulled', async () => {
    const [row] = await admin<Array<{ n: string | null; empty: string | null; spaces: string | null }>>`
      SELECT scm.canonicalize_venue(NULL)  AS n,
             scm.canonicalize_venue('')    AS empty,
             scm.canonicalize_venue('   ') AS spaces
    `;
    expect(row.n).toBeNull();
    expect(row.empty).toBe('');
    expect(row.spaces).toBe('   ');
  });

  test('a raw INSERT that bypasses the service is folded on all four surfaces', async () => {
    await admin`INSERT INTO public.projects (venue) VALUES ('PJ Showroom')`;
    await admin`INSERT INTO public.project_venues (name) VALUES ('pj-showroom')`;
    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, venue) VALUES ('SO-V-1', '2990 PJ')`;
    await admin`INSERT INTO scm.warehouses (venue_name) VALUES ('  PJ   Showroom  ')`;

    const [p] = await admin<Array<{ venue: string }>>`SELECT venue FROM public.projects`;
    const [v] = await admin<Array<{ name: string }>>`SELECT name FROM public.project_venues`;
    const [so] = await admin<Array<{ venue: string }>>`SELECT venue FROM scm.mfg_sales_orders`;
    const [w] = await admin<Array<{ venue_name: string }>>`SELECT venue_name FROM scm.warehouses`;

    expect([p.venue, v.name, so.venue, w.venue_name]).toEqual([
      '2990s PJ', '2990s PJ', '2990s PJ', '2990s PJ',
    ]);
  });

  test('a raw UPDATE is folded too — the drift vector is not only INSERT', async () => {
    await admin`INSERT INTO public.projects (venue) VALUES ('KLCC Hall 3')`;
    await admin`UPDATE public.projects SET venue = 'PJ Showroom'`;
    const [p] = await admin<Array<{ venue: string }>>`SELECT venue FROM public.projects`;
    expect(p.venue).toBe('2990s PJ');

    await admin`INSERT INTO scm.mfg_sales_orders (doc_no, venue) VALUES ('SO-V-2', NULL)`;
    await admin`UPDATE scm.mfg_sales_orders SET venue = 'pjshowroom' WHERE doc_no = 'SO-V-2'`;
    const [so] = await admin<Array<{ venue: string }>>`
      SELECT venue FROM scm.mfg_sales_orders WHERE doc_no = 'SO-V-2'
    `;
    expect(so.venue).toBe('2990s PJ');
  });

  test('a blank write survives a NOT NULL column — the trigger never nulls it', async () => {
    // The owner asked to unify the PJ alias, not to fill unassigned rows. If the
    // function returned NULL for '' the way the TS helper does, this INSERT would
    // raise not_null_violation instead of storing the blank.
    await admin`INSERT INTO public.project_venues (name) VALUES ('')`;
    await admin`INSERT INTO public.projects (venue) VALUES (NULL)`;

    const [v] = await admin<Array<{ name: string }>>`SELECT name FROM public.project_venues`;
    const [p] = await admin<Array<{ venue: string | null }>>`SELECT venue FROM public.projects`;
    expect(v.name).toBe('');
    expect(p.venue).toBeNull();
  });

  test('an unknown venue written raw is left alone', async () => {
    await admin`INSERT INTO public.projects (venue) VALUES ('  Sunway Pyramid ')`;
    const [p] = await admin<Array<{ venue: string }>>`SELECT venue FROM public.projects`;
    expect(p.venue).toBe('Sunway Pyramid');
  });

  test('re-running the migration is a no-op, not a duplicate-trigger error', async () => {
    // pg-migrate keys applied files by FULL filename, so a rename re-runs the SQL
    // against a schema it already changed. DROP TRIGGER IF EXISTS + CREATE has to
    // survive that.
    await expect(admin.unsafe(await venueMigrationSql())).resolves.toBeDefined();

    const [{ n }] = await admin<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_trigger
       WHERE NOT tgisinternal AND tgname LIKE 'trg_%_canonicalize_%'
    `;
    expect(n).toBe(4);

    await admin`INSERT INTO public.projects (venue) VALUES ('PJ Showroom')`;
    const [p] = await admin<Array<{ venue: string }>>`SELECT venue FROM public.projects`;
    expect(p.venue).toBe('2990s PJ');
  });
});
