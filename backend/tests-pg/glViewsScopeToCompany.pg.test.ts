import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * scm.v_gl_entries and scm.v_account_balances — the chart of accounts is keyed
 * (company_id, account_code) since mig 0188, and both views were still joining
 * on the code half alone.
 *
 * It cost nothing until mig 0297 ("ONE AutoCount-style chart for every company")
 * gave company 1 the same 31 codes company 2 carries. From then on every code
 * exists in both charts and the join is many-to-many: v_gl_entries returned each
 * posted line TWICE (both copies stamped with the same j.company_id, so no
 * route-level .eq('company_id', ...) could dedupe them), and v_account_balances
 * summed the other company's lines into a bucket its GROUP BY labelled as ours.
 *
 * Two things are asserted here and they guard different failures:
 *
 *   1. The LEAK. The fixture is the PRE state, and the first tests prove the
 *      pre-state actually leaks. An assertion that only ran after the migration
 *      would pass just as happily against a view that never had the bug.
 *
 *   2. The SHAPE. CREATE OR REPLACE VIEW may only append columns — names, types
 *      and order must match the live view exactly. Mig 0290 learned this in
 *      production ("cannot change name of view column line_id to
 *      journal_entry_id"); pg-migrate runs before wrangler, so the backend
 *      deploy stopped and every later migration queued behind it. So the column
 *      list is captured from the live view, the migration is applied on top, and
 *      the two are compared. Nothing but a real PostgreSQL enforces this rule.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely.
async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** mig 0290's definition, verbatim — v_gl_entries as production has it TODAY. */
const GL_ENTRIES_AS_LIVE = `
CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id, j.je_no, j.entry_date, j.source_type, j.source_doc_no,
    l.line_no, l.account_code, a.account_name, a.account_type,
    l.debit_sen, l.credit_sen, l.party_type, l.party_code, l.party_name,
    l.notes, j.posted, j.posted_at, j.company_id, j.reversed, j.reversed_by_je
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     JOIN scm.accounts a ON a.account_code = l.account_code
  WHERE j.posted = true
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;`;

/** mig 0106's definition, verbatim — v_account_balances as production has it TODAY. */
const ACCOUNT_BALANCES_AS_LIVE = `
CREATE OR REPLACE VIEW scm.v_account_balances AS
 SELECT a.account_code, a.account_name, a.account_type,
    COALESCE(sum(l.debit_sen), 0::bigint) AS total_debit_sen,
    COALESCE(sum(l.credit_sen), 0::bigint) AS total_credit_sen,
        CASE
            WHEN a.account_type = ANY (ARRAY['ASSET'::text, 'EXPENSE'::text]) THEN COALESCE(sum(l.debit_sen), 0::bigint) - COALESCE(sum(l.credit_sen), 0::bigint)
            ELSE COALESCE(sum(l.credit_sen), 0::bigint) - COALESCE(sum(l.debit_sen), 0::bigint)
        END AS balance_sen,
    a.company_id
   FROM scm.accounts a
     LEFT JOIN scm.journal_entry_lines l ON l.account_code = a.account_code
     LEFT JOIN scm.journal_entries j ON j.id = l.journal_entry_id AND j.posted = true AND j.reversed = false
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;`;

let admin: Sql;

async function resetToPreState(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    DROP VIEW IF EXISTS scm.v_gl_entries;
    DROP VIEW IF EXISTS scm.v_account_balances;
    DROP TABLE IF EXISTS scm.journal_entry_lines;
    DROP TABLE IF EXISTS scm.journal_entries;
    DROP TABLE IF EXISTS scm.accounts;
    CREATE SCHEMA IF NOT EXISTS scm;

    -- mig 0188's shape: the code is unique only WITHIN a company, and the line
    -- FK points at the composite. This is what makes the same code legal twice.
    CREATE TABLE scm.accounts (
      company_id integer NOT NULL,
      account_code text NOT NULL,
      account_name text NOT NULL,
      account_type text NOT NULL,
      PRIMARY KEY (company_id, account_code)
    );
    CREATE TABLE scm.journal_entries (
      id uuid PRIMARY KEY,
      je_no text NOT NULL,
      entry_date date NOT NULL,
      source_type text,
      source_doc_no text,
      posted boolean NOT NULL DEFAULT false,
      posted_at timestamptz,
      reversed boolean NOT NULL DEFAULT false,
      reversed_by_je uuid,
      company_id integer NOT NULL
    );
    CREATE TABLE scm.journal_entry_lines (
      id uuid PRIMARY KEY,
      journal_entry_id uuid NOT NULL REFERENCES scm.journal_entries(id),
      line_no integer NOT NULL,
      account_code text NOT NULL,
      -- NOT NULL since mig 0083.
      company_id integer NOT NULL,
      debit_sen bigint NOT NULL DEFAULT 0,
      credit_sen bigint NOT NULL DEFAULT 0,
      party_type text, party_code text, party_name text, notes text,
      FOREIGN KEY (company_id, account_code)
        REFERENCES scm.accounts(company_id, account_code)
    );
  `);
  await sql.unsafe(GL_ENTRIES_AS_LIVE);
  await sql.unsafe(ACCOUNT_BALANCES_AS_LIVE);
}

const JE_HOUZS = '11111111-1111-1111-1111-111111111111';
const JE_2990 = '22222222-2222-2222-2222-222222222222';

/**
 * The post-0297 reality: code 4000 exists in BOTH charts. One posted line in
 * each company — HOUZS credits RM10,000, 2990 credits RM5,000.
 */
async function seedBothCompanies(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.accounts VALUES (1, '4000', 'Sales Revenue', 'INCOME'),
                                    (2, '4000', 'Sales Revenue', 'INCOME');
    INSERT INTO scm.journal_entries (id, je_no, entry_date, posted, company_id)
      VALUES ('${JE_HOUZS}', 'JE-H1', DATE '2026-08-01', true, 1),
             ('${JE_2990}',  'JE-T1', DATE '2026-08-01', true, 2);
    INSERT INTO scm.journal_entry_lines (id, journal_entry_id, line_no, account_code, company_id, credit_sen)
      VALUES ('${JE_HOUZS}', '${JE_HOUZS}', 1, '4000', 1, 1000000),
             ('${JE_2990}',  '${JE_2990}',  1, '4000', 2,  500000);
  `);
}

const MIGRATION = '_gl_views_join_on_company.sql';

async function columnShape(sql: Sql, view: string): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = '${view}'
    ORDER BY ordinal_position`);
  return rows.map((r: Record<string, unknown>) => `${r.column_name}:${r.data_type}`);
}

describePg('scm GL views — mig *_gl_views_join_on_company', () => {
  beforeAll(() => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetToPreState(admin); });

  test('the fixture reproduces the bug: v_gl_entries returns every line TWICE', async () => {
    await seedBothCompanies(admin);
    const rows = await admin.unsafe(`SELECT je_no, company_id FROM scm.v_gl_entries WHERE company_id = 1`);
    // If this ever returns 1, the pre-state is wrong and the fix below would be
    // measuring nothing. Both copies carry company_id = 1, which is exactly why
    // filtering by company in the route could not save it.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r: Record<string, unknown>) => r.company_id))).toEqual(new Set([1]));
  });

  test('the fixture reproduces the bug: v_account_balances sums BOTH companies', async () => {
    await seedBothCompanies(admin);
    const rows = await admin.unsafe(
      `SELECT company_id, total_credit_sen FROM scm.v_account_balances WHERE account_code = '4000' ORDER BY company_id`);
    // RM10,000 + RM5,000 landing in each company's own bucket.
    expect(rows.map((r: Record<string, unknown>) => Number(r.total_credit_sen))).toEqual([1500000, 1500000]);
  });

  test('applies on top of the LIVE views — CREATE OR REPLACE must not rename or reorder', async () => {
    // The failure this guards stopped a production deploy once (mig 0290).
    await expect(admin.unsafe(await migrationSql(MIGRATION))).resolves.toBeDefined();
  });

  test('column names, types and ORDER are identical before and after', async () => {
    const beforeGl = await columnShape(admin, 'v_gl_entries');
    const beforeBal = await columnShape(admin, 'v_account_balances');
    await admin.unsafe(await migrationSql(MIGRATION));
    expect(await columnShape(admin, 'v_gl_entries')).toEqual(beforeGl);
    expect(await columnShape(admin, 'v_account_balances')).toEqual(beforeBal);
    // Guard the guard: an empty list either side would make the compare vacuous.
    expect(beforeGl[0]).toBe('line_id:uuid');
    expect(beforeGl).toHaveLength(20);
    expect(beforeBal).toHaveLength(7);
  });

  test('what the migration is FOR: each company sees its own ledger, once', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seedBothCompanies(admin);

    const houzs = await admin.unsafe(`SELECT je_no FROM scm.v_gl_entries WHERE company_id = 1`);
    const t2990 = await admin.unsafe(`SELECT je_no FROM scm.v_gl_entries WHERE company_id = 2`);
    expect(houzs.map((r: Record<string, unknown>) => r.je_no)).toEqual(['JE-H1']);
    expect(t2990.map((r: Record<string, unknown>) => r.je_no)).toEqual(['JE-T1']);

    const bal = await admin.unsafe(
      `SELECT company_id, total_credit_sen FROM scm.v_account_balances WHERE account_code = '4000' ORDER BY company_id`);
    expect(bal.map((r: Record<string, unknown>) => Number(r.total_credit_sen))).toEqual([1000000, 500000]);
  });

  test('an account with no lines still reports zero — the LEFT JOIN stayed a LEFT JOIN', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await admin.unsafe(`INSERT INTO scm.accounts VALUES (1, '5000', 'Cost of Sales', 'EXPENSE');`);
    const rows = await admin.unsafe(
      `SELECT total_debit_sen, balance_sen FROM scm.v_account_balances WHERE account_code = '5000'`);
    // Adding a predicate to a LEFT JOIN's ON clause must not turn it into an
    // INNER one: an unused account has to keep appearing in the trial balance.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.total_debit_sen)).toBe(0);
    expect(Number(rows[0]!.balance_sen)).toBe(0);
  });

  test('re-runnable: applying the migration twice changes nothing', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seedBothCompanies(admin);
    await admin.unsafe(await migrationSql(MIGRATION));
    const rows = await admin.unsafe(`SELECT je_no FROM scm.v_gl_entries WHERE company_id = 1`);
    expect(rows.map((r: Record<string, unknown>) => r.je_no)).toEqual(['JE-H1']);
  });
});
