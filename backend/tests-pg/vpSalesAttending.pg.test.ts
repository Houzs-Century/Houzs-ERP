import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* EXECUTES the Venture Portal Sales Attending push's SQL (migration
 * *_scm_vp_sales_attending.sql) against real Postgres: the body the portal
 * receives, its digest, and the marks that make an edit leave in seconds.
 *
 * The portal RETIRES any of its booths from `since` on that a delivery does not
 * list, so what matters most is that the body is the WHOLE window — every
 * project of the company from `since`, listed reps or not, cancelled too — and
 * nothing of another company or from before it.
 *
 * The migration file is located by SUFFIX, never by number: parallel PRs
 * renumber migrations. Runs against CI's postgres:16 (`npm run test:pg`);
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

const CO = 1;
const OTHER = 2;

type Obj = { [k: string]: unknown };

let sql: Sql;
let since = '';

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
  DROP TABLE IF EXISTS scm.venture_portal_attendance_state, scm.venture_portal_attendance_changes CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_attendance_mark_changed() CASCADE;
  DROP FUNCTION IF EXISTS scm.vp_attendance_snapshot(bigint), scm.vp_attendance_digest(bigint),
    scm.vp_build_attendance(bigint) CASCADE;
  DROP TABLE IF EXISTS public.project_sales_attendees, public.sales_reps, public.projects,
    public.project_event_types CASCADE;
  DROP TABLE IF EXISTS scm.staff CASCADE;
`;

const build = async (company: number): Promise<Obj> =>
  (await sql`SELECT scm.vp_build_attendance(${company}::bigint) AS b`)[0]!.b as Obj;
const digest = async (company: number): Promise<string> =>
  (await sql`SELECT scm.vp_attendance_digest(${company}::bigint) AS d`)[0]!.d as string;
const booths = (b: Obj): Obj[] => (b.booths ?? []) as Obj[];

/** A day `n` months after `since`, as the text the PMS stores. */
const monthAfterSince = (n: number, day: string): string => {
  const [y, m] = since.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${day}`;
};

describePg('the Venture Portal Sales Attending push, built in SQL', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS scm; ${DROP_FIXTURE}`);

    since = (await sql`
      SELECT to_char((date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur') - interval '6 months')::date, 'YYYY-MM-DD') AS s`)[0]!.s as string;

    await sql.unsafe(`
      /* Production's shapes, with the columns the builder reads and some it must not. */
      CREATE TABLE public.project_event_types (id bigint PRIMARY KEY, slug text NOT NULL, name text);
      CREATE TABLE public.projects (
        id bigint PRIMARY KEY, code text, name text NOT NULL, stage text NOT NULL DEFAULT 'event',
        start_date text, end_date text, organizer text, state text, venue text, venue_address text,
        brand text, event_type_id bigint, booth_no text, notes text, payment_status text,
        status text NOT NULL DEFAULT 'pending', company_id bigint NOT NULL DEFAULT 1);
      CREATE TABLE public.sales_reps (
        id bigint PRIMARY KEY, code text NOT NULL, name text NOT NULL, phone text, email text,
        user_id bigint, status text NOT NULL DEFAULT 'active', commission_rate double precision, nric text);
      CREATE TABLE public.project_sales_attendees (
        project_id bigint NOT NULL, sales_rep_id bigint NOT NULL,
        created_at text NOT NULL DEFAULT '2026-10-12 00:00:00', created_by bigint,
        PRIMARY KEY (project_id, sales_rep_id));
      CREATE TABLE scm.staff (
        id uuid PRIMARY KEY, staff_code text, name text, active boolean, user_id integer,
        created_at timestamptz DEFAULT now(), pin_hash text, phone text);

      INSERT INTO public.project_event_types (id, slug, name) VALUES (1, 'exhibition', 'Exhibition'), (2, 'mall', 'Mall');
      INSERT INTO public.sales_reps (id, code, name, user_id, phone, nric, commission_rate) VALUES
        (54, 'SR-015', 'Chea Huan', 29, '012-0000000', '900101-01-0001', 6),
        (61, 'SR-022', 'Anthony', 36, '012-0000001', '900101-01-0002', 6),
        (99, 'SR-099', 'No Login', NULL, NULL, NULL, NULL),
        (70, 'SR-031', 'Melvin Chong', 45, NULL, NULL, NULL);
      INSERT INTO scm.staff (id, staff_code, name, active, user_id, created_at, pin_hash) VALUES
        ('b7eabf08-7f43-3afe-66ef-d4d20a87f64a', 'EMP-0029', 'Chea Huan', true, 29, '2026-01-01', 'secret-hash'),
        ('d0816a69-84ae-c027-5dda-f12b82712f83', 'EMP-0036', 'Anthony', true, 36, '2026-01-01', NULL),
        /* Melvin's login has two staff rows: the active one is his. */
        ('00000000-0000-0000-0000-0000000000a1', 'EMP-OLD', 'Melvin (old)', false, 45, '2025-01-01', NULL),
        ('e36728c4-a231-0d05-d9d3-9bdf69c6b203', 'EMP-0045', 'Melvin Chong', true, 45, '2026-02-01', NULL);
    `);
    await sql.unsafe(`
      INSERT INTO public.projects (id, code, name, start_date, end_date, organizer, venue, brand, event_type_id, status, company_id, notes, payment_status) VALUES
        (363, 'P-363', 'BIGHOME MID VALLEY AKEMI', '${monthAfterSince(5, '02')}', '${monthAfterSince(5, '04')}', 'BIGHOME', 'MID VALLEY', 'AKEMI', 1, 'confirmed', ${CO}, 'note', 'paid'),
        (2262, 'P-2262', 'BIGHOME MID VALLEY ZANOTTI', '${monthAfterSince(5, '02')}', '${monthAfterSince(5, '04')}', 'BIGHOME', 'MID VALLEY', 'ZANOTTI', 1, 'confirmed', ${CO}, NULL, NULL),
        (350, 'P-350', 'AEON TAMAN EQUINE', '${monthAfterSince(5, '13')}', '${monthAfterSince(5, '25')}', 'VTEAM', 'AEON TAMAN EQUINE', 'AKEMI', 2, 'cancelled', ${CO}, NULL, NULL),
        (100, 'P-100', 'the first day of the window', '${since}', '${monthAfterSince(0, '03')}', 'MLE', 'MVEC', 'AKEMI', 1, 'confirmed', ${CO}, NULL, NULL),
        (99, 'P-99', 'the day before the window', '${monthAfterSince(-1, '28')}', '${monthAfterSince(0, '01')}', 'MLE', 'MVEC', 'AKEMI', 1, 'confirmed', ${CO}, NULL, NULL),
        (777, 'P-777', 'another company', '${monthAfterSince(5, '02')}', '${monthAfterSince(5, '04')}', 'X', 'ELSEWHERE', 'AKEMI', 1, 'confirmed', ${OTHER}, NULL, NULL),
        (888, 'P-888', 'a start date that is not a date', 'TBC', NULL, 'X', 'SOMEWHERE', 'AKEMI', 1, 'pending', ${CO}, NULL, NULL);
      INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES
        (363, 70), (363, 54), (363, 99), (2262, 61), (777, 54), (99, 54);
    `);

    await applyMigration(sql, '_scm_vp_sales_attending.sql');
  });

  afterAll(async () => {
    await sql.unsafe(DROP_FIXTURE);
    await sql.end({ timeout: 5 });
  });

  describe('the body: the whole window of one company', () => {
    test('every project from `since` on, listed reps or not, cancelled too — ordered by start date, then id', async () => {
      const b = await build(CO);
      expect(b.companyId).toBe(CO);
      expect(b.since).toBe(since);
      /* 99 is the day before the window, 777 is another company, 888 has no date. */
      expect(booths(b).map((x) => x.projectId)).toEqual([100, 363, 2262, 350]);
      expect(booths(b).find((x) => x.projectId === 350)).toMatchObject({ status: 'cancelled', attendees: [], eventType: 'mall' });
      expect(b).not.toHaveProperty('snapshotAt');
    });

    test('a booth in named keys only, its reps by name with the scm.staff id of each login', async () => {
      const mv = booths(await build(CO)).find((x) => x.projectId === 363)!;
      expect(Object.keys(mv).sort()).toEqual([
        'attendees', 'brand', 'code', 'endDate', 'eventType', 'name', 'organizer', 'projectId', 'startDate', 'status', 'venue',
      ]);
      expect(mv).toMatchObject({
        code: 'P-363', brand: 'AKEMI', venue: 'MID VALLEY', organizer: 'BIGHOME', status: 'confirmed', eventType: 'exhibition',
        startDate: monthAfterSince(5, '02'), endDate: monthAfterSince(5, '04'),
      });
      expect(mv.attendees).toEqual([
        { salesRepId: 54, code: 'SR-015', name: 'Chea Huan', salespersonId: 'b7eabf08-7f43-3afe-66ef-d4d20a87f64a' },
        { salesRepId: 70, code: 'SR-031', name: 'Melvin Chong', salespersonId: 'e36728c4-a231-0d05-d9d3-9bdf69c6b203' },
        { salesRepId: 99, code: 'SR-099', name: 'No Login', salespersonId: null },
      ]);
    });

    test('nothing personal or financial rides along: no phone, NRIC, rate, note or payment status', async () => {
      const text = JSON.stringify(await build(CO));
      for (const leak of ['012-0000000', '900101-01-0001', 'secret-hash', 'paid', '"note"', 'commission']) {
        expect(text).not.toContain(leak);
      }
    });

    test('another company`s body is its own', async () => {
      expect(booths(await build(OTHER)).map((x) => x.projectId)).toEqual([777]);
    });
  });

  describe('the digest', () => {
    test('is stable, matches the snapshot`s own, and the snapshot adds only snapshotAt', async () => {
      const d1 = await digest(CO);
      expect(d1).toMatch(/^[0-9a-f]{32}$/);
      expect(await digest(CO)).toBe(d1);
      const snap = (await sql`SELECT scm.vp_attendance_snapshot(${CO}::bigint) AS s`)[0]!.s as Obj;
      expect(snap.digest).toBe(d1);
      const { snapshotAt, ...rest } = snap.body as Obj;
      expect(Date.parse(String(snapshotAt))).not.toBeNaN();
      expect(rest).toEqual(await build(CO));
    });

    test('moves when somebody is listed or removed, not when a field it does not send changes', async () => {
      const d1 = await digest(CO);
      await sql`UPDATE public.projects SET notes = 'changed', payment_status = 'unpaid', booth_no = 'A1' WHERE id = 363`;
      await sql`UPDATE public.sales_reps SET phone = '013-9999999' WHERE id = 54`;
      expect(await digest(CO)).toBe(d1);

      await sql`INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES (2262, 54)`;
      const d2 = await digest(CO);
      expect(d2).not.toBe(d1);
      await sql`DELETE FROM public.project_sales_attendees WHERE project_id = 2262 AND sales_rep_id = 54`;
      expect(await digest(CO)).toBe(d1);

      /* Another company's roster is not this company's change. */
      await sql`INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES (777, 61)`;
      expect(await digest(CO)).toBe(d1);
    });

    test('nobody but the service role may call the builders', async () => {
      const rows = await sql`
        SELECT p.proname, COALESCE(p.proacl::text, '') AS acl
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'scm'
           AND p.proname IN ('vp_build_attendance', 'vp_attendance_digest', 'vp_attendance_snapshot', 'vp_attendance_mark_changed')`;
      expect(rows).toHaveLength(4);
      /* A PUBLIC grant renders as an entry with an empty grantee: `=X/owner`. */
      for (const r of rows) expect(String(r.acl)).not.toMatch(/(^|[{,])=/);
    });
  });

  /* LIVE, NOT EVERY FIVE MINUTES: the kick sends only while a mark is here. */
  describe('a change is marked in the transaction that made it', () => {
    const marks = async (): Promise<string[]> =>
      (await sql`SELECT source FROM scm.venture_portal_attendance_changes ORDER BY id`).map((r) => r.source as string);
    const clear = async () => { await sql`DELETE FROM scm.venture_portal_attendance_changes`; };

    test('listing and removing somebody mark it, once per statement', async () => {
      await clear();
      await sql`INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES (350, 54), (350, 61)`;
      await sql`DELETE FROM public.project_sales_attendees WHERE project_id = 350`;
      expect(await marks()).toEqual(['project_sales_attendees', 'project_sales_attendees']);
    });

    test('a project column the list sends marks it; one it does not send marks nothing', async () => {
      await clear();
      await sql`UPDATE public.projects SET status = 'cancelled' WHERE id = 2262`;
      await sql`UPDATE public.projects SET venue = 'MID VALLEY EXHIBITION CENTRE', start_date = start_date WHERE company_id = ${CO}`;
      await sql`UPDATE public.projects SET notes = 'n', payment_status = 'p', venue_address = 'a', booth_no = 'b'`;
      expect(await marks()).toEqual(['projects', 'projects']);
    });

    test('a new project and a deleted one each mark it', async () => {
      await clear();
      await sql`INSERT INTO public.projects (id, name, start_date, end_date, company_id) VALUES (5000, 'new', '2099-01-01', '2099-01-02', ${CO})`;
      await sql`DELETE FROM public.projects WHERE id = 5000`;
      expect(await marks()).toEqual(['projects', 'projects']);
    });

    test('a rep`s name, code or login marks it; a phone number does not', async () => {
      await clear();
      await sql`UPDATE public.sales_reps SET name = 'Chea Huan Tan' WHERE id = 54`;
      await sql`UPDATE public.sales_reps SET user_id = 29 WHERE id = 54`;
      await sql`UPDATE public.sales_reps SET phone = '011', email = 'x@y', commission_rate = 7`;
      expect(await marks()).toEqual(['sales_reps', 'sales_reps']);
    });

    test('a write that rolls back marks nothing', async () => {
      await clear();
      /* A thrown JS error, not a failing statement: the library rolls the
         transaction back itself, so no SQL error precedes the query after it. */
      await sql.begin(async (tx) => {
        await tx`INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES (363, 61)`;
        throw new Error('roll it back');
      }).catch(() => undefined);
      expect(await marks()).toEqual([]);
    });

    /* A PMS save must never fail because of the portal: without the marks
       table the trigger swallows its own failure and the save goes through. */
    test('a missing marks table never fails the save', async () => {
      await sql`ALTER TABLE scm.venture_portal_attendance_changes RENAME TO venture_portal_attendance_changes_away`;
      await sql`INSERT INTO public.project_sales_attendees (project_id, sales_rep_id) VALUES (363, 61)`;
      expect((await sql`SELECT count(*)::int AS n FROM public.project_sales_attendees WHERE project_id = 363 AND sales_rep_id = 61`)[0]!.n).toBe(1);
      await sql`ALTER TABLE scm.venture_portal_attendance_changes_away RENAME TO venture_portal_attendance_changes`;
    });
  });

  /* Last on purpose: the only statements in this file that are MEANT to fail.
     Real Postgres does not care, but the local PGlite wire bridge garbles the
     answer to whatever query follows an error, so nothing follows these. */
  describe('what the sender last delivered', () => {
    test('one row per company, and an outcome outside classifyVpResponse`s vocabulary is refused', async () => {
      await sql`INSERT INTO scm.venture_portal_attendance_state (company_id, last_outcome) VALUES (${CO}, 'sent')`;
      await expect(sql`INSERT INTO scm.venture_portal_attendance_state (company_id, last_outcome) VALUES (${OTHER}, 'delivered')`)
        .rejects.toThrow(/check constraint/i);
      await expect(sql`INSERT INTO scm.venture_portal_attendance_state (company_id) VALUES (${CO})`)
        .rejects.toThrow(/duplicate key/i);
    });
  });
});
