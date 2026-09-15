import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * scm.v_account_balances — the Trial Balance's one read — counted every
 * unposted draft and both sides of every reversal pair (docs/bugs/0923).
 *
 * Its predicate `j.posted = true AND j.reversed = false` sat in the ON of a
 * LEFT JOIN while the SUM ran over the LINES: a line whose journal failed the
 * predicate kept its j-side NULL and was summed regardless. Migrations 0290
 * and 0306 both recorded this and left it for the owner. Owner 2026-09-15:
 * a reversed journal and its contra are one correction — the journal keeps
 * both, the books show neither — and a draft has booked nothing.
 *
 * Two things are asserted, and they guard different failures:
 *
 *   1. The DEFECT. The fixture is the PRE state (0306's definition, the one
 *      live today), and the first test proves it counts the draft and the
 *      pair. An assertion that only ran after the migration would pass just
 *      as happily against a view that never had the bug.
 *
 *   2. The SHAPE. CREATE OR REPLACE VIEW may only append columns — names,
 *      types and order must match the live view exactly (mig 0290 stopped a
 *      production deploy learning this). The column list is captured from the
 *      live view, the migration applied on top, and the two compared. Only a
 *      real PostgreSQL enforces the rule.
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

/** mig 0306's definition, verbatim — v_account_balances as production has it TODAY. */
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
     LEFT JOIN scm.journal_entry_lines l
       ON l.account_code = a.account_code
      AND l.company_id = a.company_id
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
      company_id integer NOT NULL,
      debit_sen bigint NOT NULL DEFAULT 0,
      credit_sen bigint NOT NULL DEFAULT 0,
      party_type text, party_code text, party_name text, notes text,
      FOREIGN KEY (company_id, account_code)
        REFERENCES scm.accounts(company_id, account_code)
    );
  `);
  await sql.unsafe(ACCOUNT_BALANCES_AS_LIVE);
}

const JE_SALE = 'aaaaaaaa-0000-0000-0000-000000000001';
const JE_ORIGINAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const JE_CONTRA = 'aaaaaaaa-0000-0000-0000-000000000003';
const JE_DRAFT = 'aaaaaaaa-0000-0000-0000-000000000004';

/**
 * One company, one ledger: a posted RM 1,000 sale (the books), an RM 500 sale
 * keyed twice — its original flagged reversed and pointing at the contra, the
 * contra pointing back (the shape acc/engine.ts reverseJournal writes) — and
 * an RM 777 draft that never posted.
 */
async function seedLedger(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.accounts VALUES (2, '310-0010', 'CASH AT BANK', 'ASSET'),
                                    (2, '501-0000', 'SALES', 'INCOME'),
                                    (2, '900-A001', 'ADVERTISING', 'EXPENSE');
    INSERT INTO scm.journal_entries (id, je_no, entry_date, source_type, posted, reversed, reversed_by_je, company_id) VALUES
      ('${JE_SALE}',     'JE-2608-0001', DATE '2026-08-10', 'SOPAY',          true,  false, NULL,             2),
      ('${JE_ORIGINAL}', 'JE-2608-0002', DATE '2026-08-12', 'SOPAY',          true,  true,  '${JE_CONTRA}',   2),
      ('${JE_CONTRA}',   'JE-2609-0001', DATE '2026-09-15', 'SOPAY_REVERSAL', true,  false, '${JE_ORIGINAL}', 2),
      ('${JE_DRAFT}',    'JE-2609-0002', DATE '2026-09-16', 'MANUAL',         false, false, NULL,             2);
    INSERT INTO scm.journal_entry_lines (id, journal_entry_id, line_no, account_code, company_id, debit_sen, credit_sen) VALUES
      ('bbbbbbbb-0000-0000-0000-000000000011', '${JE_SALE}',     1, '310-0010', 2, 100000, 0),
      ('bbbbbbbb-0000-0000-0000-000000000012', '${JE_SALE}',     2, '501-0000', 2, 0, 100000),
      ('bbbbbbbb-0000-0000-0000-000000000021', '${JE_ORIGINAL}', 1, '310-0010', 2, 50000, 0),
      ('bbbbbbbb-0000-0000-0000-000000000022', '${JE_ORIGINAL}', 2, '501-0000', 2, 0, 50000),
      ('bbbbbbbb-0000-0000-0000-000000000031', '${JE_CONTRA}',   1, '501-0000', 2, 50000, 0),
      ('bbbbbbbb-0000-0000-0000-000000000032', '${JE_CONTRA}',   2, '310-0010', 2, 0, 50000),
      ('bbbbbbbb-0000-0000-0000-000000000041', '${JE_DRAFT}',    1, '310-0010', 2, 77700, 0),
      ('bbbbbbbb-0000-0000-0000-000000000042', '${JE_DRAFT}',    2, '501-0000', 2, 0, 77700);
  `);
}

const MIGRATION = '_acc_account_balances_count_the_books.sql';

async function columnShape(sql: Sql, view: string): Promise<string[]> {
  const rows = await sql.unsafe(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'scm' AND table_name = '${view}'
    ORDER BY ordinal_position`);
  return rows.map((r: Record<string, unknown>) => `${r.column_name}:${r.data_type}`);
}

async function totalsOf(sql: Sql, code: string): Promise<[number, number, number]> {
  const rows = await sql.unsafe(
    `SELECT total_debit_sen, total_credit_sen, balance_sen FROM scm.v_account_balances WHERE company_id = 2 AND account_code = '${code}'`);
  expect(rows).toHaveLength(1);
  return [Number(rows[0]!.total_debit_sen), Number(rows[0]!.total_credit_sen), Number(rows[0]!.balance_sen)];
}

describePg('scm.v_account_balances — mig *_acc_account_balances_count_the_books', () => {
  beforeAll(() => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetToPreState(admin); });

  test('the fixture reproduces the defect: the live view counts the draft and both sides of the pair', async () => {
    await seedLedger(admin);
    // Sales: the RM 1,000 sale + the reversed RM 500 original + the RM 777 draft
    // on the credit side, the RM 500 contra on the debit side. If this ever
    // reads 0 / 100000 the pre-state is wrong and the fix below measures nothing.
    expect(await totalsOf(admin, '501-0000')).toEqual([50000, 227700, 177700]);
    expect(await totalsOf(admin, '310-0010')).toEqual([227700, 50000, 177700]);
  });

  test('applies on top of the LIVE view — CREATE OR REPLACE must not rename or reorder', async () => {
    await expect(admin.unsafe(await migrationSql(MIGRATION))).resolves.toBeDefined();
  });

  test('column names, types and ORDER are identical before and after', async () => {
    const before = await columnShape(admin, 'v_account_balances');
    await admin.unsafe(await migrationSql(MIGRATION));
    expect(await columnShape(admin, 'v_account_balances')).toEqual(before);
    // Guard the guard: an empty list either side would make the compare vacuous.
    expect(before[0]).toBe('account_code:text');
    expect(before).toHaveLength(7);
  });

  test('what the migration is FOR: the books — posted, on neither side of a reversal — and nothing else', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seedLedger(admin);
    expect(await totalsOf(admin, '501-0000')).toEqual([0, 100000, 100000]);
    expect(await totalsOf(admin, '310-0010')).toEqual([100000, 0, 100000]);
    // The self-check the Trial Balance tab folds: Σ debit = Σ credit over the chart.
    const sums = await admin.unsafe(`SELECT sum(total_debit_sen) AS dr, sum(total_credit_sen) AS cr FROM scm.v_account_balances WHERE company_id = 2`);
    expect(Number(sums[0]!.dr)).toBe(Number(sums[0]!.cr));
  });

  test('an account with no lines still reports zero — the LEFT JOIN stayed a LEFT JOIN', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seedLedger(admin);
    expect(await totalsOf(admin, '900-A001')).toEqual([0, 0, 0]);
  });

  test('re-runnable: applying the migration twice changes nothing', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seedLedger(admin);
    await admin.unsafe(await migrationSql(MIGRATION));
    expect(await totalsOf(admin, '501-0000')).toEqual([0, 100000, 100000]);
  });
});
