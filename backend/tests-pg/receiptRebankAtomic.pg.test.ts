import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { pgTransactionSupabase } from '../src/scm/lib/pg-supabase-transaction';
import { postSoPayment, type SoPaymentRow } from '../src/acc/payments';
import { rebankReceipts } from '../src/acc/receipt-rebank';
import { rebankTxOver } from '../src/acc/rebank-transaction';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* END-TO-END PROOF that moving a receipt to another bank is ALL OR NOTHING,
 * against real Postgres: the contra of the old entry and the new entry commit
 * together or not at all. Before this the contra committed on its own, and a
 * new entry that then failed left the money in no bank.
 *
 * Drives the REAL rebankReceipts, the REAL journal engine (reverseJournal,
 * postJournal, nextJeNo, jePrefixForCompany) and the REAL transaction client
 * (pgTransactionSupabase + the JE counter), with the production postgres.js
 * options. So a statement shape the engine needs and the client cannot emit,
 * or a DATE handed back as a JS Date, fails here and not in production.
 *
 * The LIST (which receipts can move) runs on a second connection through the
 * same shim, standing in for PostgREST. `paid_at` is text here because
 * PostgREST answers a timestamptz as an ISO string — the shape the posters get
 * in production — where postgres.js would hand a Date.
 *
 * Tables are reduced to the columns these paths read. Runs against CI's
 * postgres:16 service (`npm run test:pg`); SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const CO = 1;
const HLB = '310-0020';
const MBB = '310-0010';
const PROD_OPTIONS = { max: 1, prepare: false, fetch_types: false, onnotice: () => {} } as const;

let sql: Sql;
let readSql: Sql;

const TABLES = [
  'scm.journal_entry_lines', 'scm.journal_entries', 'scm.accounts', 'scm.acc_account_roles', 'scm.mfg_sales_orders',
  'scm.mfg_sales_order_payments', 'scm.acc_official_receipts', 'scm.acc_bank_statement_matches', 'scm.acc_bank_month_locks',
  'scm.doc_number_counters',
];

const PAY = (id: string, company_id = CO, so = 'SO-2610-001'): SoPaymentRow => ({
  id, so_doc_no: so, paid_at: '2026-10-05T14:00:00+08:00', method: 'transfer', merchant_provider: null, amount_sen: 50_000, company_id,
} as unknown as SoPaymentRow);

/** The list on its own connection (PostgREST's role), the moves on `sql`. */
const move = (paymentIds: string[]) => readSql.begin((rtx) => rebankReceipts(
  pgTransactionSupabase(rtx as unknown as Sql), CO, paymentIds.map((paymentId) => ({ source: 'SOPAY' as const, paymentId })), rebankTxOver(sql),
));

/* Plain rows: a postgres.js Result carries statement metadata besides its rows. */
const plain = (rows: readonly Record<string, unknown>[]) => rows.map((r) => ({ ...r }));
const entries = async () => plain(await sql`
  SELECT je_no, to_char(entry_date, 'YYYY-MM-DD') AS day, source_type, source_doc_no, posted, reversed, company_id,
         (SELECT account_code FROM scm.journal_entry_lines l WHERE l.journal_entry_id = j.id AND l.debit_sen > 0) AS debit
    FROM scm.journal_entries j ORDER BY je_no`);
const live = async (paymentId: string) => (await entries())
  .filter((e) => e.source_type === 'SOPAY' && e.source_doc_no === paymentId && e.posted && !e.reversed)
  .map((e) => ({ day: e.day, bank: e.debit }));
const counters = async () => plain(await sql`SELECT series, next_n FROM scm.doc_number_counters ORDER BY series`);

describePg('moving a receipt to another bank is one transaction', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, PROD_OPTIONS);
    readSql = postgres(url, PROD_OPTIONS);
    await sql`CREATE SCHEMA IF NOT EXISTS scm`;
  });

  afterAll(async () => {
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await sql`DROP FUNCTION IF EXISTS scm.next_doc_no_n(text, integer)`;
    await sql`DROP TABLE IF EXISTS public.companies CASCADE`;
    await readSql.end({ timeout: 5 });
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    /* DROP before CREATE: other files in this suite build tables of these names with other columns. */
    for (const t of TABLES) await sql.unsafe(`DROP TABLE IF EXISTS ${t} CASCADE`);
    await sql`DROP TABLE IF EXISTS public.companies CASCADE`;
    await sql.unsafe(`
      CREATE TABLE public.companies (id bigint PRIMARY KEY, code text);
      INSERT INTO public.companies VALUES (1, 'HOUZS'), (2, '2990');
      CREATE TABLE scm.accounts (company_id integer, account_code text, parent_code text, is_active boolean, PRIMARY KEY (company_id, account_code));
      INSERT INTO scm.accounts SELECT c, a, NULL, true FROM unnest(ARRAY[1, 2]) c, unnest(ARRAY['300-0000', '${MBB}', '${HLB}']) a;
      CREATE TABLE scm.acc_account_roles (company_id integer, role text, account_code text);
      INSERT INTO scm.acc_account_roles VALUES (1, 'BANK_DEFAULT', '${HLB}'), (2, 'BANK_DEFAULT', '${HLB}');
      CREATE TABLE scm.mfg_sales_orders (doc_no text, company_id integer, debtor_name text, phone text, customer_id text, debtor_code text);
      INSERT INTO scm.mfg_sales_orders VALUES ('SO-2610-001', 1, 'Ah Meng', '0123', 'cust-1', NULL), ('SO-2610-900', 2, 'Other', '0999', 'cust-9', NULL);
      CREATE TABLE scm.mfg_sales_order_payments (id text, so_doc_no text, paid_at text, method text, merchant_provider text, amount_sen bigint, company_id integer);
      CREATE TABLE scm.journal_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer, je_no text NOT NULL UNIQUE, entry_date date NOT NULL,
        source_type text, source_doc_no text, narration text, total_debit_sen bigint, total_credit_sen bigint,
        posted boolean NOT NULL DEFAULT false, reversed boolean NOT NULL DEFAULT false, reversed_by_je uuid, opening boolean NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX acc_je_one_active_source ON scm.journal_entries (COALESCE(company_id, 1), source_type, source_doc_no)
        WHERE posted AND COALESCE(reversed, FALSE) = FALSE AND source_doc_no IS NOT NULL AND source_type NOT LIKE '%\\_REVERSAL';
      CREATE TABLE scm.journal_entry_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id integer, journal_entry_id uuid NOT NULL REFERENCES scm.journal_entries(id),
        line_no integer, account_code text NOT NULL, debit_sen bigint NOT NULL DEFAULT 0, credit_sen bigint NOT NULL DEFAULT 0,
        party_type text, party_code text, party_name text, notes text, project_id bigint
      );
      CREATE TABLE scm.acc_official_receipts (company_id integer, status text, payment_source text, payment_id text, channel_account_code text);
      CREATE TABLE scm.acc_bank_statement_matches (company_id integer, je_no text);
      CREATE TABLE scm.acc_bank_month_locks (company_id integer, account_code text, period_month date, released_at timestamptz);
      CREATE TABLE scm.doc_number_counters (series text PRIMARY KEY, next_n integer NOT NULL, seed_source text, updated_at timestamptz);
      -- mig 0316's function body, verbatim.
      CREATE OR REPLACE FUNCTION scm.next_doc_no_n(p_series text, p_floor integer) RETURNS integer LANGUAGE sql VOLATILE AS $fn$
        INSERT INTO scm.doc_number_counters AS c (series, next_n, seed_source)
        VALUES (p_series, GREATEST(COALESCE(p_floor, 0), 0) + 2, 'self-seeded')
        ON CONFLICT (series) DO UPDATE
           SET next_n = GREATEST(c.next_n, GREATEST(COALESCE(p_floor, 0), 0) + 1) + 1, updated_at = now()
        RETURNING next_n - 1;
      $fn$;
    `);
    /* Booked while Receive into was Hong Leong — through the real poster, on the transaction client. */
    const pays = [PAY('pay-1'), PAY('pay-2'), PAY('pay-other-co', 2, 'SO-2610-900')];
    for (const p of pays) {
      const row = p as unknown as Record<string, string | number | null>;
      await sql.unsafe(
        'INSERT INTO scm.mfg_sales_order_payments (id, so_doc_no, paid_at, method, merchant_provider, amount_sen, company_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [row.id, row.so_doc_no, row.paid_at, row.method, row.merchant_provider, row.amount_sen, row.company_id] as never[],
      );
      const r = await rebankTxOver(sql)((db) => postSoPayment(db, p));
      expect(r).toMatchObject({ ok: true, status: 'posted' });
    }
    /* Then the owner set Maybank. */
    await sql`UPDATE scm.acc_account_roles SET account_code = ${MBB} WHERE company_id = ${CO}`;
  });

  test('success writes both: the contra on the original date and the new entry on Maybank, in one commit', async () => {
    const r = await move(['pay-1']);
    expect(r.ok && r.results.map((x) => [x.status, x.reason])).toEqual([['moved', null]]);
    expect(await live('pay-1')).toEqual([{ day: '2026-10-05', bank: MBB }]);
    const all = await entries();
    const contra = all.find((e) => e.source_type === 'SOPAY_REVERSAL' && e.source_doc_no === 'pay-1');
    /* On the ORIGINAL entry's day — a JS Date mis-read as text would land elsewhere or fail. */
    expect(contra).toMatchObject({ day: '2026-10-05', posted: true, company_id: CO });
    expect(all.find((e) => r.ok && e.je_no === r.results[0]!.fromJeNo)).toMatchObject({ reversed: true, debit: HLB });
  });

  test('the new entry refused after the contra was written: nothing is left, the receipt is still on Hong Leong', async () => {
    await sql`UPDATE scm.accounts SET is_active = false WHERE company_id = ${CO} AND account_code = ${MBB}`;
    const before = await entries();
    const countersBefore = await counters();
    const r = await move(['pay-1']);
    expect(r.ok && r.results[0]).toMatchObject({ status: 'failed', jeNo: null });
    expect(r.ok && r.results[0]!.reason).toMatch(new RegExp(`^nothing changed, still on ${HLB}: the new entry did not post: account_invalid`));
    expect(await entries()).toEqual(before);
    expect(await live('pay-1')).toEqual([{ day: '2026-10-05', bank: HLB }]);
    /* The contra's JE number was claimed inside the transaction, so it went back too. */
    expect(await counters()).toEqual(countersBefore);
  });

  test('the database refusing a statement mid-move rolls the contra back, and the next receipt still moves', async () => {
    await sql.unsafe(`
      CREATE FUNCTION scm.refuse_pay1_onto_maybank() RETURNS trigger LANGUAGE plpgsql AS $t$
      BEGIN
        IF NEW.account_code = '${MBB}' AND EXISTS (
          SELECT 1 FROM scm.journal_entries j WHERE j.id = NEW.journal_entry_id AND j.source_type = 'SOPAY' AND j.source_doc_no = 'pay-1'
        ) THEN RAISE EXCEPTION 'storage refused the line'; END IF;
        RETURN NEW;
      END $t$;
      CREATE TRIGGER refuse_pay1 BEFORE INSERT ON scm.journal_entry_lines FOR EACH ROW EXECUTE FUNCTION scm.refuse_pay1_onto_maybank();
    `);
    try {
      const r = await move(['pay-1', 'pay-2']);
      expect(r.ok && r.results.map((x) => [x.paymentId, x.status])).toEqual([['pay-1', 'failed'], ['pay-2', 'moved']]);
      expect(r.ok && r.results[0]!.reason).toMatch(/^nothing changed, still on 310-0020: .*storage refused the line/);
      expect(await live('pay-1')).toEqual([{ day: '2026-10-05', bank: HLB }]);
      expect((await entries()).filter((e) => e.source_type === 'SOPAY_REVERSAL' && e.source_doc_no === 'pay-1')).toEqual([]);
      expect(await live('pay-2')).toEqual([{ day: '2026-10-05', bank: MBB }]);
    } finally {
      await sql`DROP FUNCTION IF EXISTS scm.refuse_pay1_onto_maybank() CASCADE`;
    }
  });

  test('company scope: another company\'s receipt, named by id, is not moved and not touched', async () => {
    const before = await entries();
    const r = await move(['pay-other-co']);
    expect(r.ok && r.results.map((x) => x.status)).toEqual(['skipped']);
    expect(await entries()).toEqual(before);
  });
});
