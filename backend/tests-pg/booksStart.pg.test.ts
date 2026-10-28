import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * A company's books start on a day (owner 2026-10-28, Houzs: 「31/08 之前我都是
 * soft launch 的。我会在01/09/2026当做正式在erp做，所以账的opening也是01/09/2026」).
 * The two report views — scm.v_gl_entries (statements, GL, aging, bank) and
 * scm.v_account_balances (Trial Balance) — then count only what is dated on or
 * after it, plus the opening's own journals whatever their date, and never a
 * stock close of a month before it (its opening leg is dated the 1st of the
 * next month, i.e. inside the books).
 *
 * Asserted, against a real PostgreSQL:
 *   1. SHAPE — CREATE OR REPLACE may only append (0290 stopped a deploy): the
 *      live column lists are captured, the migration applied on top, and
 *      compared; v_gl_entries gains `opening` at the end and nothing else moves.
 *   2. NO SETTING, NO CHANGE — a company without books_start_date reads as before.
 *   3. THE RULE — the soft launch is out, September and the opening are in, the
 *      August close's 01/09 opening leg is out, the September close is in, and
 *      the other company is untouched.
 */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by number — parallel PRs renumber migrations routinely.
async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}
const MIGRATION = '_acc_books_start_opening.sql';

/** v_gl_entries as production has it today (0306). */
const GL_ENTRIES_AS_LIVE = `
CREATE OR REPLACE VIEW scm.v_gl_entries AS
 SELECT l.id AS line_id, j.je_no, j.entry_date, j.source_type, j.source_doc_no,
    l.line_no, l.account_code, a.account_name, a.account_type,
    l.debit_sen, l.credit_sen, l.party_type, l.party_code, l.party_name,
    l.notes, j.posted, j.posted_at, j.company_id, j.reversed, j.reversed_by_je
   FROM scm.journal_entry_lines l
     JOIN scm.journal_entries j ON j.id = l.journal_entry_id
     JOIN scm.accounts a ON a.account_code = l.account_code AND a.company_id = j.company_id
  WHERE j.posted = true
  ORDER BY j.entry_date DESC, j.je_no DESC, l.line_no;`;

/** v_account_balances as production has it today (20260915T1400). */
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
     LEFT JOIN (
       SELECT l.account_code, l.company_id, l.debit_sen, l.credit_sen
         FROM scm.journal_entry_lines l
         JOIN scm.journal_entries j ON j.id = l.journal_entry_id
        WHERE j.posted = true AND j.reversed = false AND j.reversed_by_je IS NULL
     ) l ON l.account_code = a.account_code AND l.company_id = a.company_id
  GROUP BY a.account_code, a.account_name, a.account_type, a.company_id
  ORDER BY a.account_code;`;

let admin: Sql;

async function resetToPreState(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
  await sql.unsafe(`
    DROP VIEW IF EXISTS scm.v_gl_entries;
    DROP VIEW IF EXISTS scm.v_account_balances;
    DROP TABLE IF EXISTS scm.journal_entry_lines;
    DROP TABLE IF EXISTS scm.journal_entries;
    DROP TABLE IF EXISTS scm.accounts;
    DROP TABLE IF EXISTS scm.acc_company_settings;
    DROP TABLE IF EXISTS scm.ap_invoices;
    DROP TABLE IF EXISTS scm.acc_credit_notes;
    DROP TABLE IF EXISTS scm.acc_debtor_bills;
    DROP TABLE IF EXISTS scm.acc_debtor_receipts;
    CREATE SCHEMA IF NOT EXISTS scm;
    CREATE TABLE scm.accounts (company_id integer NOT NULL, account_code text NOT NULL, account_name text NOT NULL, account_type text NOT NULL, PRIMARY KEY (company_id, account_code));
    CREATE TABLE scm.journal_entries (id uuid PRIMARY KEY, je_no text NOT NULL, entry_date date NOT NULL, source_type text, source_doc_no text,
      posted boolean NOT NULL DEFAULT false, posted_at timestamptz, reversed boolean NOT NULL DEFAULT false, reversed_by_je uuid, company_id integer NOT NULL);
    CREATE TABLE scm.journal_entry_lines (id uuid PRIMARY KEY, journal_entry_id uuid NOT NULL REFERENCES scm.journal_entries(id), line_no integer NOT NULL,
      account_code text NOT NULL, company_id integer NOT NULL, debit_sen bigint NOT NULL DEFAULT 0, credit_sen bigint NOT NULL DEFAULT 0,
      party_type text, party_code text, party_name text, notes text);
    CREATE TABLE scm.acc_company_settings (company_id bigint PRIMARY KEY, deposit_invoice_enabled boolean NOT NULL DEFAULT false, deposit_invoice_from date,
      updated_at timestamptz NOT NULL DEFAULT now(), updated_by text);
    CREATE TABLE scm.ap_invoices (id uuid PRIMARY KEY, company_id bigint NOT NULL);
    CREATE TABLE scm.acc_credit_notes (id uuid PRIMARY KEY, company_id bigint NOT NULL);
    CREATE TABLE scm.acc_debtor_bills (id uuid PRIMARY KEY, company_id bigint NOT NULL);
    CREATE TABLE scm.acc_debtor_receipts (id uuid PRIMARY KEY, company_id bigint NOT NULL);
  `);
  await sql.unsafe(GL_ENTRIES_AS_LIVE);
  await sql.unsafe(ACCOUNT_BALANCES_AS_LIVE);
}

const id = (n: number) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
/** One posted entry: Dr `dr` / Cr `cr` for `sen`, on `date`, for `company`. */
const entry = (n: number, company: number, date: string, source: string, doc: string, dr: string, cr: string, sen: number) => `
  INSERT INTO scm.journal_entries (id, je_no, entry_date, source_type, source_doc_no, posted, company_id)
    VALUES ('${id(n)}', 'JE-${n}', DATE '${date}', '${source}', '${doc}', true, ${company});
  INSERT INTO scm.journal_entry_lines (id, journal_entry_id, line_no, account_code, company_id, debit_sen, credit_sen) VALUES
    ('${id(1000 + n)}', '${id(n)}', 1, '${dr}', ${company}, ${sen}, 0),
    ('${id(2000 + n)}', '${id(n)}', 2, '${cr}', ${company}, 0, ${sen});`;

/**
 * Company 1 opens on 01/09: a soft-launch payment in August (RM 100), a
 * September payment (RM 20), the opening dated 31/08 (RM 1,000 into the bank),
 * the August stock close (RM 50 on 31/08) and its opening leg on 01/09, and
 * the September close (RM 70 on 30/09). Company 2 has an August payment
 * (RM 7) and no start date.
 */
async function seed(sql: Sql, flagOpening: boolean): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.accounts VALUES
      (1, '310-0010', 'CASH AT BANK', 'ASSET'), (1, '300-0000', 'AR', 'ASSET'), (1, '190-0000', 'OPENING', 'EQUITY'),
      (1, '330-0001', 'STOCK', 'ASSET'), (1, '620-0001', 'CLOSING STOCK', 'EXPENSE'), (1, '600-0001', 'OPENING STOCK', 'EXPENSE'),
      (2, '310-0010', 'CASH AT BANK', 'ASSET'), (2, '300-0000', 'AR', 'ASSET');
    ${entry(1, 1, '2026-08-15', 'SOPAY', 'SO-1', '310-0010', '300-0000', 10000)}
    ${entry(2, 1, '2026-09-10', 'SOPAY', 'SO-2', '310-0010', '300-0000', 2000)}
    ${entry(3, 1, '2026-08-31', 'OPENING', 'HC-OPENING-2608', '310-0010', '190-0000', 100000)}
    ${entry(4, 1, '2026-08-31', 'STOCKADJ', 'STOCKADJ-1-2026-08', '330-0001', '620-0001', 5000)}
    ${entry(5, 1, '2026-09-01', 'STOCKADJ', 'STOCKADJ-REV-1-2026-08', '600-0001', '330-0001', 5000)}
    ${entry(6, 1, '2026-09-30', 'STOCKADJ', 'STOCKADJ-1-2026-09', '330-0001', '620-0001', 7000)}
    ${entry(7, 2, '2026-08-20', 'SOPAY', 'SO-9', '310-0010', '300-0000', 700)}
  `);
  if (flagOpening) await sql.unsafe(`UPDATE scm.journal_entries SET opening = true WHERE id = '${id(3)}'`);
}

async function shape(sql: Sql, view: string): Promise<string[]> {
  const rows = await sql.unsafe(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'scm' AND table_name = '${view}' ORDER BY ordinal_position`);
  return rows.map((r: Record<string, unknown>) => `${r.column_name}:${r.data_type}`);
}
async function glSum(sql: Sql, company: number, code: string): Promise<number> {
  const r = await sql.unsafe(`SELECT coalesce(sum(debit_sen - credit_sen), 0)::bigint AS n FROM scm.v_gl_entries WHERE company_id = ${company} AND account_code = '${code}'`);
  return Number(r[0]!.n);
}
async function tbBalance(sql: Sql, company: number, code: string): Promise<number> {
  const r = await sql.unsafe(`SELECT total_debit_sen - total_credit_sen AS n FROM scm.v_account_balances WHERE company_id = ${company} AND account_code = '${code}'`);
  return Number(r[0]!.n);
}

describePg('books start — mig *_acc_books_start_opening', () => {
  beforeAll(() => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetToPreState(admin); });

  test('the shapes: v_account_balances unchanged, v_gl_entries gains `opening` at the end only', async () => {
    const gl = await shape(admin, 'v_gl_entries');
    const tb = await shape(admin, 'v_account_balances');
    await admin.unsafe(await migrationSql(MIGRATION));
    expect(await shape(admin, 'v_account_balances')).toEqual(tb);
    expect(await shape(admin, 'v_gl_entries')).toEqual([...gl, 'opening:boolean']);
    expect(gl).toHaveLength(20);
  });

  test('no start date: every posted entry counts, as before', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seed(admin, true);
    expect(await glSum(admin, 1, '310-0010')).toBe(10000 + 2000 + 100000);
    expect(await tbBalance(admin, 1, '310-0010')).toBe(112000);
  });

  test('books from 01/09: the soft launch is out; the opening and September are in', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seed(admin, true);
    await admin.unsafe(`INSERT INTO scm.acc_company_settings (company_id, books_start_date) VALUES (1, DATE '2026-09-01')`);
    // Bank: the opening RM 1,000 + September's RM 20; August's RM 100 is gone.
    expect(await glSum(admin, 1, '310-0010')).toBe(100000 + 2000);
    expect(await tbBalance(admin, 1, '310-0010')).toBe(102000);
    // Stock: the August close (31/08) AND its 01/09 opening leg are out; September's close is in.
    expect(await glSum(admin, 1, '330-0001')).toBe(7000);
    expect(await glSum(admin, 1, '600-0001')).toBe(0);
    expect(await tbBalance(admin, 1, '620-0001')).toBe(-7000);
    // The other company reads exactly as before.
    expect(await glSum(admin, 2, '310-0010')).toBe(700);
  });

  test('the opening counts only because it is flagged — a plain journal dated 31/08 does not', async () => {
    await admin.unsafe(await migrationSql(MIGRATION));
    await seed(admin, false);
    await admin.unsafe(`INSERT INTO scm.acc_company_settings (company_id, books_start_date) VALUES (1, DATE '2026-09-01')`);
    expect(await glSum(admin, 1, '310-0010')).toBe(2000);
    expect(await glSum(admin, 1, '190-0000')).toBe(0);
  });
});
