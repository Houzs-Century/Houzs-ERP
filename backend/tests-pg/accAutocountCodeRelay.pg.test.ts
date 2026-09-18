import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * 0346_acc_autocount_code_relay — the evidence docs/bugs/0615 demands before
 * the chart relay is dispatched at production a third time.
 *
 * 0344 failed production twice: first on a table name that never existed
 * (0614), then on 0188's non-deferrable composite FKs — the parent UPDATE
 * refused per statement, one step before the child UPDATE would mend it
 * (0615). Staging passed both times because staging held no voucher rows:
 * an empty table proves nothing about a full one.
 *
 * So THIS fixture is production's shape on purpose: the parent
 * (scm.accounts, composite key) plus every child the relay touches, WITH
 * 0188's three composite FKs declared exactly as 0188 declares them
 * (ON DELETE RESTRICT, NOT VALID, not deferrable) and rows referencing the
 * codes being renamed. The migration is read by SUFFIX and replayed whole.
 *
 * Asserted, per 0615's bar and then some:
 *   · the codes moved in accounts AND in all three FK children;
 *   · the satellite tables moved too (roles, vendor memory, acquirer links,
 *     bank statement config + statements);
 *   · the FKs are restored NOT DEFERRABLE and still BITE (a dangling insert
 *     refuses after the relay);
 *   · a second replay is a clean no-op — the staging story, where the
 *     reverted 0344 already applied.
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
    -- CASCADE: the pg suite shares one disposable database across files, and
    -- earlier files leave views (v_gl_entries) hanging off scm.accounts. Each
    -- file rebuilds its own world; ours must be able to raze the last one's.
    DROP TABLE IF EXISTS scm.acc_bank_statements CASCADE;
    DROP TABLE IF EXISTS scm.acc_bank_statement_config CASCADE;
    DROP TABLE IF EXISTS scm.acc_company_acquirers CASCADE;
    DROP TABLE IF EXISTS scm.acc_vendor_memory CASCADE;
    DROP TABLE IF EXISTS scm.acc_account_roles CASCADE;
    DROP TABLE IF EXISTS scm.payment_voucher_lines CASCADE;
    DROP TABLE IF EXISTS scm.payment_vouchers CASCADE;
    DROP TABLE IF EXISTS scm.journal_entry_lines CASCADE;
    DROP TABLE IF EXISTS scm.accounts CASCADE;
    CREATE SCHEMA IF NOT EXISTS scm;

    CREATE TABLE scm.accounts (
      company_id   integer NOT NULL,
      account_code text    NOT NULL,
      account_name text    NOT NULL,
      account_type text    NOT NULL,
      parent_code  text,
      is_active    boolean NOT NULL DEFAULT true,
      acc_money    boolean NOT NULL DEFAULT false,
      PRIMARY KEY (company_id, account_code)
    );
    CREATE TABLE scm.journal_entry_lines (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id   integer NOT NULL,
      account_code text    NOT NULL,
      debit_sen    bigint  NOT NULL DEFAULT 0,
      credit_sen   bigint  NOT NULL DEFAULT 0
    );
    CREATE TABLE scm.payment_vouchers (
      id                  text PRIMARY KEY,
      company_id          integer NOT NULL,
      credit_account_code text    NOT NULL
    );
    CREATE TABLE scm.payment_voucher_lines (
      id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id         integer NOT NULL,
      pv_id              text    NOT NULL,
      debit_account_code text    NOT NULL
    );
    CREATE TABLE scm.acc_account_roles (
      company_id   integer NOT NULL,
      role         text    NOT NULL,
      account_code text    NOT NULL,
      PRIMARY KEY (company_id, role)
    );
    CREATE TABLE scm.acc_vendor_memory (
      company_id         integer NOT NULL,
      vendor_key         text    NOT NULL,
      debit_account_code text,
      PRIMARY KEY (company_id, vendor_key)
    );
    CREATE TABLE scm.acc_company_acquirers (
      company_id           integer NOT NULL,
      acquirer_code        text    NOT NULL,
      transit_account_code text    NOT NULL DEFAULT '320-0000',
      fee_account_code     text    NOT NULL DEFAULT '930-0000',
      bank_account_code    text,
      PRIMARY KEY (company_id, acquirer_code)
    );
    CREATE TABLE scm.acc_bank_statement_config (
      company_id   integer NOT NULL,
      account_code text    NOT NULL,
      bank_code    text    NOT NULL,
      UNIQUE (company_id, account_code)
    );
    CREATE TABLE scm.acc_bank_statements (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      company_id   integer NOT NULL,
      account_code text    NOT NULL,
      file_name    text    NOT NULL
    );

    -- 0188's three composite FKs, DECLARED AS 0188 DECLARES THEM: RESTRICT,
    -- NOT VALID, and (implicitly) NOT DEFERRABLE — the exact shape that
    -- refused 0344 on production.
    ALTER TABLE scm.journal_entry_lines
      ADD CONSTRAINT journal_entry_lines_company_account_fk
      FOREIGN KEY (company_id, account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE scm.payment_vouchers
      ADD CONSTRAINT payment_vouchers_company_credit_account_fk
      FOREIGN KEY (company_id, credit_account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
    ALTER TABLE scm.payment_voucher_lines
      ADD CONSTRAINT payment_voucher_lines_company_debit_account_fk
      FOREIGN KEY (company_id, debit_account_code)
      REFERENCES scm.accounts (company_id, account_code) ON DELETE RESTRICT NOT VALID;
  `);

  /* Production's data shape: the 0297 template rows being renamed, per
     company, plus children referencing them — including the owner's two real
     draft vouchers (credit 330-0000 / 331-0000), the exact rows that fired
     the constraint on production. */
  await sql.unsafe(`
    INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, acc_money) VALUES
      (1,'105-0000','Retained Earnings','EQUITY',NULL,false),
      (1,'310-0000','Inventory','ASSET',NULL,false),
      (1,'315-0000','Prepayments','ASSET',NULL,false),
      (1,'320-0000','Card Machine Clearing (EDC)','ASSET',NULL,false),
      (1,'325-0000','Online Payment Clearing','ASSET',NULL,false),
      (1,'330-0000','Bank - Maybank Current','ASSET',NULL,true),
      (1,'331-0000','Bank - Hong Leong Current','ASSET',NULL,true),
      (1,'335-0000','Cash on Hand','ASSET',NULL,true),
      (1,'400-0000','Trade Creditor','LIABILITY',NULL,false),
      (1,'410-0000','Customer Deposits','LIABILITY',NULL,false),
      (1,'420-0000','Long-term Loans','LIABILITY',NULL,false),
      (1,'900-A002','Advertisement','EXPENSE',NULL,false),
      (2,'330-0000','Bank - Maybank Current','ASSET',NULL,true),
      (2,'331-0000','Bank - Hong Leong Current','ASSET',NULL,true),
      (2,'335-0000','Cash on Hand','ASSET',NULL,true),
      (2,'410-0000','Customer Deposits','LIABILITY',NULL,false);

    INSERT INTO scm.journal_entry_lines (company_id, account_code, debit_sen, credit_sen) VALUES
      (1,'330-0000',50000,0), (1,'320-0000',0,1500), (1,'900-A002',1500,0), (2,'330-0000',7000,0);

    INSERT INTO scm.payment_vouchers (id, company_id, credit_account_code) VALUES
      ('pv-armedia',2,'331-0000'), ('pv-kng',2,'330-0000');

    INSERT INTO scm.payment_voucher_lines (company_id, pv_id, debit_account_code) VALUES
      (2,'pv-armedia','410-0000'), (2,'pv-kng','335-0000');

    INSERT INTO scm.acc_account_roles (company_id, role, account_code) VALUES
      (1,'CASH','335-0000'), (1,'BANK_DEFAULT','330-0000'), (1,'TRANSIT_EDC','320-0000'),
      (1,'TRANSIT_ONLINE','325-0000'), (1,'CUSTOMER_DEPOSITS','410-0000'),
      (2,'BANK_DEFAULT','330-0000');

    INSERT INTO scm.acc_vendor_memory (company_id, vendor_key, debit_account_code) VALUES
      (2,'ARMEDIA CREATIVE','335-0000');

    INSERT INTO scm.acc_company_acquirers (company_id, acquirer_code, transit_account_code, fee_account_code, bank_account_code) VALUES
      (1,'MBB','320-0000','930-0000','330-0000'), (2,'PBB','325-0000','930-0000','331-0000');

    INSERT INTO scm.acc_bank_statement_config (company_id, account_code, bank_code) VALUES
      (2,'330-0000','MBB'), (2,'331-0000','PBB');

    INSERT INTO scm.acc_bank_statements (company_id, account_code, file_name) VALUES
      (2,'330-0000','mbb-aug.csv'), (2,'331-0000','pbb-aug.csv');
  `);
}

/* The wait-for-real-postgres pattern the sibling files use. */
async function connect(): Promise<Sql> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`SELECT 1`;
  return sql;
}

// A voucher-shaped insert that MUST refuse if the FKs still bite.
const DANGLING = `INSERT INTO scm.payment_vouchers (id, company_id, credit_account_code) VALUES ('pv-bad', 2, '999-9999')`;

describePg('0346 — the AutoCount code relay, proved against a real Postgres', () => {
  afterAll(async () => {
    /* Leave the shared database razeable: this file runs FIRST (alphabetical)
       and its FK children would otherwise block the next file's plain
       `DROP TABLE scm.accounts` — which is exactly what round one did to
       glViewsScopeToCompany. Raze our own world on the way out. */
    if (admin) {
      await admin.unsafe(`
        DROP TABLE IF EXISTS scm.acc_bank_statements CASCADE;
        DROP TABLE IF EXISTS scm.acc_bank_statement_config CASCADE;
        DROP TABLE IF EXISTS scm.acc_company_acquirers CASCADE;
        DROP TABLE IF EXISTS scm.acc_vendor_memory CASCADE;
        DROP TABLE IF EXISTS scm.acc_account_roles CASCADE;
        DROP TABLE IF EXISTS scm.payment_voucher_lines CASCADE;
        DROP TABLE IF EXISTS scm.payment_vouchers CASCADE;
        DROP TABLE IF EXISTS scm.journal_entry_lines CASCADE;
        DROP TABLE IF EXISTS scm.accounts CASCADE;
      `);
      await admin.end();
    }
  });

  beforeEach(async () => {
    admin ??= await connect();
    await resetToPreState(admin);
  });

  test('the relay moves accounts AND all three FK children, then restores the FKs — which still bite', async () => {
    const sql = await migrationSql('_acc_autocount_code_relay.sql');
    await admin.unsafe(sql);

    /* accounts: every old code gone, every new code present with the
       accountant's meaning. */
    const oldLeft = await admin`
      SELECT account_code FROM scm.accounts
      WHERE account_code IN ('105-0000','315-0000','325-0000','335-0000','410-0000','420-0000','331-0000')`;
    expect(oldLeft).toHaveLength(0);
    const [mbb] = await admin`
      SELECT account_name, parent_code, acc_money FROM scm.accounts
      WHERE company_id = 1 AND account_code = '310-0010'`;
    expect(mbb).toMatchObject({ account_name: 'CASH AT BANK - MAYBANK', parent_code: '310-0000', acc_money: true });
    const [stock] = await admin`
      SELECT account_name, acc_money FROM scm.accounts WHERE company_id = 1 AND account_code = '330-0000'`;
    expect(stock).toMatchObject({ account_name: 'STOCK', acc_money: false });
    const parents = await admin`
      SELECT company_id FROM scm.accounts WHERE account_code = '310-0000' AND account_name = 'CASH AT BANK'`;
    expect(parents.map((p) => p.company_id).sort()).toEqual([1, 2]);

    /* the three FK children — 0615's bar, verbatim. */
    const jel = await admin`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code IN ('330-0000','320-0000') AND company_id = 1`;
    /* company 1's 330 line became 310-0010 and the 320 line became 326-0000;
       what REMAINS on 330/320 must be zero (330 is STOCK, nothing books it). */
    expect(jel[0]!.n).toBe(0);
    const [jelNew] = await admin`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code = '310-0010'`;
    expect(jelNew!.n).toBe(2);
    const pvCodes = await admin`SELECT credit_account_code FROM scm.payment_vouchers ORDER BY id`;
    expect(pvCodes.map((r) => r.credit_account_code)).toEqual(['310-0020', '310-0010']);
    const pvlCodes = await admin`SELECT debit_account_code FROM scm.payment_voucher_lines ORDER BY id`;
    expect(pvlCodes.map((r) => r.debit_account_code)).toEqual(['400-0001', '320-0000']);

    /* the satellites. */
    const roles = await admin`SELECT role, account_code FROM scm.acc_account_roles WHERE company_id = 1 ORDER BY role`;
    expect(Object.fromEntries(roles.map((r) => [r.role, r.account_code]))).toMatchObject({
      CASH: '320-0000', BANK_DEFAULT: '310-0010', TRANSIT_EDC: '326-0000',
      TRANSIT_ONLINE: '327-0000', CUSTOMER_DEPOSITS: '400-0001',
    });
    const [mem] = await admin`SELECT debit_account_code FROM scm.acc_vendor_memory WHERE vendor_key = 'ARMEDIA CREATIVE'`;
    expect(mem!.debit_account_code).toBe('320-0000');
    const acq = await admin`SELECT transit_account_code, bank_account_code FROM scm.acc_company_acquirers ORDER BY acquirer_code`;
    expect(acq.map((r) => [r.transit_account_code, r.bank_account_code])).toEqual([
      ['326-0000', '310-0010'], ['327-0000', '310-0020'],
    ]);
    const cfg = await admin`SELECT account_code FROM scm.acc_bank_statement_config ORDER BY account_code`;
    expect(cfg.map((r) => r.account_code)).toEqual(['310-0010', '310-0020']);
    const stm = await admin`SELECT DISTINCT account_code FROM scm.acc_bank_statements ORDER BY account_code`;
    expect(stm.map((r) => r.account_code)).toEqual(['310-0010', '310-0020']);

    /* the FKs: restored NOT DEFERRABLE… */
    const cons = await admin`
      SELECT conname, condeferrable FROM pg_constraint
      WHERE conname IN ('journal_entry_lines_company_account_fk','payment_vouchers_company_credit_account_fk','payment_voucher_lines_company_debit_account_fk')
      ORDER BY conname`;
    expect(cons).toHaveLength(3);
    for (const c of cons) expect(c.condeferrable).toBe(false);

    /* …and still biting: a dangling reference refuses. */
    await expect(admin.unsafe(DANGLING)).rejects.toThrow(/foreign key|violates/i);
  });

  test('a second replay is a clean no-op — the staging story', async () => {
    const sql = await migrationSql('_acc_autocount_code_relay.sql');
    await admin.unsafe(sql);
    const before = await admin`SELECT company_id, account_code, account_name FROM scm.accounts ORDER BY company_id, account_code`;
    await admin.unsafe(sql); // staging already carries the new codes: must not throw, must not change
    const after = await admin`SELECT company_id, account_code, account_name FROM scm.accounts ORDER BY company_id, account_code`;
    expect(after).toEqual(before);
    const [n] = await admin`SELECT count(*)::int AS n FROM scm.payment_vouchers WHERE credit_account_code IN ('310-0010','310-0020')`;
    expect(n!.n).toBe(2);
  });

  test('the pre-state really would refuse a bare relay — the fixture reproduces production, not a friendly world', async () => {
    /* Sanity for the fixture itself: without the defer sandwich, the first
       parent UPDATE refuses exactly as production's run 33642779924 did. If
       this ever starts passing, the fixture has drifted friendly and the
       whole file proves nothing. */
    await expect(
      admin.unsafe(`UPDATE scm.accounts SET account_code = '310-0010' WHERE account_code = '330-0000'`),
    ).rejects.toThrow(/payment_vouchers_company_credit_account_fk|journal_entry_lines_company_account_fk/);
  });
});
