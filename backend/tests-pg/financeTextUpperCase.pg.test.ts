import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* Migration *_acc_finance_text_upper_case.sql on real Postgres (owner 2026-11-09: Finance's
 * typed words in UPPER CASE; the old rows once, their old casing kept aside). Proves:
 *   · the old rows: each value not already upper case is backed up (company, table, row,
 *     column, old value) and upper-cased; upper case, null and Chinese are left alone; a
 *     hand-written journal's narration and line notes are converted, a posted document's
 *     journal is not;
 *   · from then on an insert, and an update that writes a typed column, comes out upper
 *     case; an update that writes nothing typed leaves the row alone;
 *   · it runs twice without error and without a second backup.
 * The tables are cut down to the columns the migration reads. SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const migration = (): string => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('_acc_finance_text_upper_case.sql'));
  if (files.length !== 1) throw new Error(`expected one *_acc_finance_text_upper_case.sql, found ${files.length}`);
  return readFileSync(join(migrationsDir, files[0]!), 'utf8');
};

const TABLES = ['acc_text_case_backup', 'journal_entry_lines', 'journal_entries', 'suppliers', 'acc_debtors', 'acc_debtor_bill_lines', 'acc_debtor_bills',
  'acc_credit_note_lines', 'acc_credit_notes', 'acc_receipt_lines', 'acc_receipts', 'acc_payment_requests', 'ap_invoice_lines', 'ap_invoices',
  'payment_voucher_lines', 'payment_vouchers'];
let sql: Sql;

describePg('Finance typed text in upper case', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF; END $$;
      CREATE SCHEMA IF NOT EXISTS scm;
      DROP TABLE IF EXISTS ${TABLES.map((t) => `scm.${t}`).join(', ')} CASCADE;
      CREATE TABLE scm.payment_vouchers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, status text DEFAULT 'DRAFT',
        payee_name text, notes text, pay_to_bank_name text, pay_to_account_name text, pay_to_account_no text, official_doc_note text);
      CREATE TABLE scm.payment_voucher_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, description text);
      CREATE TABLE scm.ap_invoices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, invoice_number text, notes text, official_doc_note text);
      CREATE TABLE scm.ap_invoice_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, description text);
      CREATE TABLE scm.acc_payment_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, request_no text,
        payee_name text, purpose text, bank_name text, bank_account_name text, note text, finance_note text, no_event_reason text);
      CREATE TABLE scm.acc_receipts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, payer_name text, notes text);
      CREATE TABLE scm.acc_receipt_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, description text);
      CREATE TABLE scm.acc_credit_notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, party_name text, reason text, notes text);
      CREATE TABLE scm.acc_credit_note_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, description text);
      CREATE TABLE scm.acc_debtor_bills (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, notes text);
      CREATE TABLE scm.acc_debtor_bill_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, description text);
      CREATE TABLE scm.acc_debtors (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, code text, name text, notes text);
      CREATE TABLE scm.suppliers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, code text, name text NOT NULL, bank_name text, bank_account_name text, email text);
      CREATE TABLE scm.journal_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, source_type text NOT NULL, narration text, posted boolean DEFAULT false);
      CREATE TABLE scm.journal_entry_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint, journal_entry_id uuid NOT NULL, notes text, party_name text);

      INSERT INTO scm.payment_vouchers (id, company_id, payee_name, notes, pay_to_bank_name, pay_to_account_name, pay_to_account_no) VALUES
        ('00000000-0000-0000-0000-000000000001', 1, 'Hey Day Sdn Bhd', 'Bill 26028', 'Public Bank Berhad', 'Hey Day', '3823 539902'),
        ('00000000-0000-0000-0000-000000000002', 2, 'TNB', NULL, NULL, NULL, NULL),
        ('00000000-0000-0000-0000-000000000003', 1, 'Internal transfer to 310-0030 CASH AT BANK', '展会 运输', NULL, NULL, NULL);
      INSERT INTO scm.payment_voucher_lines (company_id, description) VALUES (1, 'Settle 1 invoice(s) — ESH AGENCY'), (1, 'RENTAL NOV');
      INSERT INTO scm.ap_invoices (company_id, invoice_number, notes) VALUES (1, 'inv-0042a', 'Opening 31/08 from AutoCount: AutoCount PI-007883');
      INSERT INTO scm.acc_payment_requests (company_id, request_no, purpose, bank_account_name) VALUES (1, 'HC-PRQ-2611-001', 'Mosquitoes : Thermal Fogging', 'nur''tihani');
      INSERT INTO scm.suppliers (company_id, code, name, email) VALUES (1, '400-D001', 'Dunlopillo (M) SDN BHD', 'Sales@Dunlopillo.com');
      INSERT INTO scm.acc_debtors (company_id, code, name, notes) VALUES (1, '305-2001', '2990 Home Sdn Bhd', 'AutoCount 305-2001');
      INSERT INTO scm.journal_entries (id, company_id, source_type, narration, posted) VALUES
        ('00000000-0000-0000-0000-0000000000a1', 2, 'MANUAL', 'Salary - Jun''26', true),
        ('00000000-0000-0000-0000-0000000000a2', 2, 'SOPAY', 'Payment card on SO-1', true);
      INSERT INTO scm.journal_entry_lines (company_id, journal_entry_id, notes, party_name) VALUES
        (2, '00000000-0000-0000-0000-0000000000a1', 'Gross Salary - Jun''26', NULL),
        (2, '00000000-0000-0000-0000-0000000000a2', 'Customer payment', 'Ah Meng');
    `);
    await sql.unsafe(migration());
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP TABLE IF EXISTS ${TABLES.map((t) => `scm.${t}`).join(', ')} CASCADE; DROP FUNCTION IF EXISTS scm.upper_typed_text();`);
    await sql.end();
  });

  test('the old rows: upper case now, each changed value backed up with its company; upper case, null and Chinese left alone', async () => {
    const pv = await sql`SELECT id::text, payee_name, notes, pay_to_bank_name, pay_to_account_name, pay_to_account_no FROM scm.payment_vouchers ORDER BY id`;
    expect(pv.map((r) => [r.payee_name, r.notes, r.pay_to_bank_name, r.pay_to_account_name, r.pay_to_account_no])).toEqual([
      ['HEY DAY SDN BHD', 'BILL 26028', 'PUBLIC BANK BERHAD', 'HEY DAY', '3823 539902'],
      ['TNB', null, null, null, null],
      ['INTERNAL TRANSFER TO 310-0030 CASH AT BANK', '展会 运输', null, null, null],
    ]);
    const b = await sql`SELECT company_id::int AS co, table_name, row_id, column_name, old_value FROM scm.acc_text_case_backup WHERE table_name = 'payment_vouchers' ORDER BY row_id, column_name COLLATE "C"`;
    expect(b.map((r) => [r.co, r.row_id.slice(-1), r.column_name, r.old_value])).toEqual([
      [1, '1', 'notes', 'Bill 26028'],
      [1, '1', 'pay_to_account_name', 'Hey Day'],
      [1, '1', 'pay_to_bank_name', 'Public Bank Berhad'],
      [1, '1', 'payee_name', 'Hey Day Sdn Bhd'],
      [1, '3', 'payee_name', 'Internal transfer to 310-0030 CASH AT BANK'],
    ]);
    expect((await sql`SELECT description FROM scm.payment_voucher_lines ORDER BY description`).map((r) => r.description))
      .toEqual(['RENTAL NOV', 'SETTLE 1 INVOICE(S) — ESH AGENCY']);
    /* A reference and an email are other columns: untouched. */
    expect((await sql`SELECT invoice_number, notes FROM scm.ap_invoices`)[0]).toEqual({ invoice_number: 'inv-0042a', notes: 'OPENING 31/08 FROM AUTOCOUNT: AUTOCOUNT PI-007883' });
    expect((await sql`SELECT name, email FROM scm.suppliers`)[0]).toEqual({ name: 'DUNLOPILLO (M) SDN BHD', email: 'Sales@Dunlopillo.com' });
    expect((await sql`SELECT name, notes FROM scm.acc_debtors`)[0]).toEqual({ name: '2990 HOME SDN BHD', notes: 'AutoCount 305-2001' });
    expect((await sql`SELECT purpose, bank_account_name FROM scm.acc_payment_requests`)[0]).toEqual({ purpose: 'MOSQUITOES : THERMAL FOGGING', bank_account_name: "NUR'TIHANI" });
  });

  test("a hand-written journal's words are converted; a posted document's journal is left as written", async () => {
    const je = await sql`SELECT source_type, narration FROM scm.journal_entries ORDER BY source_type`;
    expect(je.map((r) => [r.source_type, r.narration])).toEqual([['MANUAL', "SALARY - JUN'26"], ['SOPAY', 'Payment card on SO-1']]);
    const lines = await sql`SELECT notes, party_name FROM scm.journal_entry_lines ORDER BY notes`;
    expect(lines.map((r) => [r.notes, r.party_name])).toEqual([['Customer payment', 'Ah Meng'], ["GROSS SALARY - JUN'26", null]]);
    expect((await sql`SELECT count(*)::int AS n FROM scm.acc_text_case_backup WHERE table_name LIKE 'journal%'`)[0]!.n).toBe(2);
  });

  test('from now on: an insert and an update that writes a typed column come out upper case; other updates leave the row alone', async () => {
    const [ins] = await sql`INSERT INTO scm.payment_vouchers (company_id, payee_name, notes) VALUES (1, 'Sunway Kluang', 'rental deposit') RETURNING payee_name, notes`;
    expect(ins).toEqual({ payee_name: 'SUNWAY KLUANG', notes: 'RENTAL DEPOSIT' });
    await sql`UPDATE scm.payment_vouchers SET notes = 'typed again 运输' WHERE id = '00000000-0000-0000-0000-000000000002'`;
    expect((await sql`SELECT notes FROM scm.payment_vouchers WHERE id = '00000000-0000-0000-0000-000000000002'`)[0]!.notes).toBe('TYPED AGAIN 运输');
    const [line] = await sql`INSERT INTO scm.acc_credit_note_lines (company_id, description) VALUES (1, 'refund of deposit') RETURNING description`;
    expect(line!.description).toBe('REFUND OF DEPOSIT');
    const [sup] = await sql`INSERT INTO scm.suppliers (company_id, code, name, bank_name, email) VALUES (1, '400-K001', 'Kian Furniture', 'Maybank', 'kian@Furniture.my') RETURNING name, bank_name, email`;
    expect(sup).toEqual({ name: 'KIAN FURNITURE', bank_name: 'MAYBANK', email: 'kian@Furniture.my' });
    /* A status change writes no typed column: whatever is in the row stays as it is. */
    await sql`ALTER TABLE scm.payment_vouchers DISABLE TRIGGER upper_typed_text`;
    await sql`UPDATE scm.payment_vouchers SET notes = 'kept as written' WHERE id = '00000000-0000-0000-0000-000000000002'`;
    await sql`ALTER TABLE scm.payment_vouchers ENABLE TRIGGER upper_typed_text`;
    await sql`UPDATE scm.payment_vouchers SET status = 'POSTED' WHERE id = '00000000-0000-0000-0000-000000000002'`;
    expect((await sql`SELECT notes FROM scm.payment_vouchers WHERE id = '00000000-0000-0000-0000-000000000002'`)[0]!.notes).toBe('kept as written');
  });

  test('it runs again without error and without a second backup', async () => {
    const before = (await sql`SELECT count(*)::int AS n FROM scm.acc_text_case_backup`)[0]!.n;
    await sql.unsafe(`UPDATE scm.payment_vouchers SET notes = upper(notes) WHERE notes = 'kept as written'`);
    await sql.unsafe(migration());
    expect((await sql`SELECT count(*)::int AS n FROM scm.acc_text_case_backup`)[0]!.n).toBe(before);
  });
});
