import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * scm.v_gl_entries — the migration must APPLY to the view that is actually live,
 * not to the one its author was reading.
 *
 * This test exists because the migration reached production and failed there:
 *
 *     FAILED 0290_scm_gl_keep_reversed_originals.sql:
 *     cannot change name of view column "line_id" to "journal_entry_id"
 *
 * pg-migrate runs inside the deploy, BEFORE wrangler, so the whole backend
 * deploy stopped and every later migration was blocked behind it. Nothing in CI
 * could have caught it: the pg suite applies the specific migrations a test
 * names, and no test named this one. The D1 replay in tests/setup.ts is a
 * different tree entirely (src/db/migrations/), and SQLite would not object to
 * this anyway.
 *
 * The rule being asserted is a Postgres one. CREATE OR REPLACE VIEW may only
 * APPEND columns: existing names, types and ORDER must match exactly. The
 * migration had rewritten column 1 from `l.id AS line_id` to
 * `j.id AS journal_entry_id` and inserted the two new columns before
 * `company_id` — three violations of a rule that only a real database enforces.
 *
 * So the fixture is the PRE state (mig 0106's definition) and the assertion is
 * that the migration applies ON TOP of it. A test that built the view from the
 * migration's own SQL would pass while production failed, which is the failure
 * mode this file is here to prevent.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely (this
// one moved 0285 -> 0288 -> 0290), and a number-pinned read would resolve to
// nothing and pass vacuously.
async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/\bproduct_code\b/g, 'item_code').replace(/\bmaterial_code\b/g, 'item_code');
}

/** mig 0106's definition, verbatim — the view as production has it TODAY. */
const VIEW_AS_LIVE = `
CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id,
    j.je_no,
    j.entry_date,
    j.source_type,
    j.source_doc_no,
    l.line_no,
    l.account_code,
    a.account_name,
    a.account_type,
    l.debit_sen,
    l.credit_sen,
    l.party_type,
    l.party_code,
    l.party_name,
    l.notes,
    j.posted,
    j.posted_at,
    j.company_id
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     JOIN scm.accounts a ON a.account_code = l.account_code
  WHERE j.posted = true AND j.reversed = false
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;`;

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
    DROP TABLE IF EXISTS scm.journal_entry_lines;
    DROP TABLE IF EXISTS scm.journal_entries;
    DROP TABLE IF EXISTS scm.accounts;
    CREATE SCHEMA IF NOT EXISTS scm;

    CREATE TABLE scm.accounts (
      account_code text PRIMARY KEY,
      account_name text NOT NULL,
      account_type text NOT NULL
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
      account_code text NOT NULL REFERENCES scm.accounts(account_code),
      debit_sen bigint NOT NULL DEFAULT 0,
      credit_sen bigint NOT NULL DEFAULT 0,
      party_type text, party_code text, party_name text, notes text
    );
  `);
  await sql.unsafe(VIEW_AS_LIVE);
}

const ORIGINAL = '11111111-1111-1111-1111-111111111111';
const CONTRA = '22222222-2222-2222-2222-222222222222';

/** An issued invoice, then cancelled: the original flagged, a contra posted. */
async function seedReversalPair(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.accounts VALUES ('4000', 'Revenue', 'INCOME');
    INSERT INTO scm.journal_entries (id, je_no, entry_date, posted, reversed, reversed_by_je, company_id)
      VALUES ('${ORIGINAL}', 'JE-1', DATE '2026-08-01', true, true, '${CONTRA}', 1),
             ('${CONTRA}',   'JE-2', DATE '2026-08-02', true, false, NULL, 1);
    INSERT INTO scm.journal_entry_lines (id, journal_entry_id, line_no, account_code, credit_sen, debit_sen)
      VALUES ('${ORIGINAL}', '${ORIGINAL}', 1, '4000', 1000000, 0),
             ('${CONTRA}',   '${CONTRA}',   1, '4000', 0, 1000000);
  `);
}

describePg('scm.v_gl_entries — mig *_scm_gl_keep_reversed_originals', () => {
  beforeAll(() => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetToPreState(admin); });

  test('the fixture reproduces the bug it is fixing: the live view HIDES the reversed original', async () => {
    await seedReversalPair(admin);
    const rows = await admin.unsafe(`SELECT je_no FROM scm.v_gl_entries ORDER BY je_no`);
    // If this ever returns both, the pre-state is wrong and every assertion
    // below would be measuring nothing.
    expect(rows.map((r: Record<string, unknown>) => r.je_no)).toEqual(['JE-2']);
  });

  test('applies on top of the LIVE view — CREATE OR REPLACE must not rename or reorder', async () => {
    const sqlText = await migrationSql('_scm_gl_keep_reversed_originals.sql');
    // The whole point. Before the fix this threw:
    //   cannot change name of view column "line_id" to "journal_entry_id"
    await expect(admin.unsafe(sqlText)).resolves.toBeDefined();
  });

  test('column ONE is still line_id, and the new columns are APPENDED after company_id', async () => {
    await admin.unsafe(await migrationSql('_scm_gl_keep_reversed_originals.sql'));
    const cols = await admin.unsafe(`
      SELECT column_name, ordinal_position FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = 'v_gl_entries'
      ORDER BY ordinal_position`);
    const names = cols.map((r: Record<string, unknown>) => r.column_name as string);
    expect(names[0]).toBe('line_id');
    expect(names.indexOf('reversed')).toBeGreaterThan(names.indexOf('company_id'));
    expect(names.indexOf('reversed_by_je')).toBeGreaterThan(names.indexOf('reversed'));
  });

  test('what the migration is FOR: both halves of the reversal now appear, and they net to zero', async () => {
    await admin.unsafe(await migrationSql('_scm_gl_keep_reversed_originals.sql'));
    await seedReversalPair(admin);
    const rows = await admin.unsafe(
      `SELECT je_no, reversed, credit_sen, debit_sen FROM scm.v_gl_entries ORDER BY je_no`,
    );
    expect(rows.map((r: Record<string, unknown>) => r.je_no)).toEqual(['JE-1', 'JE-2']);
    const net = rows.reduce(
      (n: number, r: Record<string, unknown>) => n + Number(r.credit_sen) - Number(r.debit_sen), 0,
    );
    expect(net).toBe(0);
    expect(rows.find((r: Record<string, unknown>) => r.je_no === 'JE-1')!.reversed).toBe(true);
  });

  test('an UNPOSTED draft is still excluded — j.posted = true was kept', async () => {
    await admin.unsafe(await migrationSql('_scm_gl_keep_reversed_originals.sql'));
    await admin.unsafe(`
      INSERT INTO scm.accounts VALUES ('4000', 'Revenue', 'INCOME');
      INSERT INTO scm.journal_entries (id, je_no, entry_date, posted, company_id)
        VALUES ('${ORIGINAL}', 'JE-DRAFT', DATE '2026-08-01', false, 1);
      INSERT INTO scm.journal_entry_lines (id, journal_entry_id, line_no, account_code, credit_sen)
        VALUES ('${ORIGINAL}', '${ORIGINAL}', 1, '4000', 500);
    `);
    const rows = await admin.unsafe(`SELECT je_no FROM scm.v_gl_entries`);
    expect(rows).toHaveLength(0);
  });
});
