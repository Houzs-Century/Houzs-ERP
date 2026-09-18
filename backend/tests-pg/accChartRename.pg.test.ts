import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';

/*
 * 0347_acc_chart_manage — proof for scm.acc_rename_account, the owner's
 * 改码全账跟 (2026-09-03: "我要如何改account code 和 名字,然后一改，整个
 * ledger 都要能改").
 *
 * Same bar as accAutocountCodeRelay.pg.test.ts (docs/bugs/0615): a
 * production-shaped fixture — scm.accounts with its composite key plus every
 * reference home the function touches, WITH 0188's three composite FKs
 * declared exactly as 0188 declares them (RESTRICT, NOT VALID, not
 * deferrable). The migration is read by SUFFIX and applied whole; the
 * function is then exercised against rows that reference the code being
 * renamed, because an empty table proves nothing about a full one.
 *
 * Asserted:
 *   · one call moves the code in accounts (every company), children's
 *     parent_code, and all nine reference homes — and reports its counts;
 *   · the FKs still bite after the rename (a dangling voucher refuses);
 *   · renaming onto a live code raises and the transaction leaves NOTHING
 *     half-moved (the merge-two-books door stays shut);
 *   · an unknown code and a malformed code raise;
 *   · replaying the migration file is a clean no-op (pg-migrate's tracker
 *     never re-runs it, but CREATE OR REPLACE + IF NOT EXISTS keep even a
 *     hand replay safe).
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

const RAZE = `
  DROP TABLE IF EXISTS scm.acc_bank_statements CASCADE;
  DROP TABLE IF EXISTS scm.acc_bank_statement_config CASCADE;
  DROP TABLE IF EXISTS scm.acc_company_acquirers CASCADE;
  DROP TABLE IF EXISTS scm.acc_vendor_memory CASCADE;
  DROP TABLE IF EXISTS scm.acc_account_roles CASCADE;
  DROP TABLE IF EXISTS scm.payment_voucher_lines CASCADE;
  DROP TABLE IF EXISTS scm.payment_vouchers CASCADE;
  DROP TABLE IF EXISTS scm.journal_entry_lines CASCADE;
  DROP TABLE IF EXISTS scm.accounts CASCADE;
  DROP FUNCTION IF EXISTS scm.acc_rename_account(text, text);
`;

async function resetToPreState(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    ${RAZE}
    CREATE SCHEMA IF NOT EXISTS scm;

    -- Production's column set (verified against the live table 2026-09-03):
    -- id / created_at included, because the function copies created_at and
    -- the fixture must be able to prove it rode along.
    CREATE TABLE scm.accounts (
      id           uuid    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      company_id   integer NOT NULL,
      account_code text    NOT NULL,
      account_name text    NOT NULL,
      account_type text    NOT NULL,
      parent_code  text,
      is_active    boolean NOT NULL DEFAULT true,
      acc_money    boolean NOT NULL DEFAULT false,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT accounts_company_account_code_unique UNIQUE (company_id, account_code)
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
      transit_account_code text    NOT NULL DEFAULT '326-0000',
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

    -- 0188's three composite FKs, DECLARED AS 0188 DECLARES THEM (and as the
    -- live database carries them, pg_constraint-verified 2026-09-03):
    -- RESTRICT, NOT VALID, not deferrable.
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

  /* The seeded tree's shape: the Maybank leaf under its CASH AT BANK header,
     carried by BOTH companies, referenced from every home the function
     touches — plus a bystander account that must not move. */
  await sql.unsafe(`
    INSERT INTO scm.accounts (company_id, account_code, account_name, account_type, parent_code, acc_money, created_at) VALUES
      (1,'310-0000','CASH AT BANK','ASSET',NULL,false,'2026-01-01T00:00:00Z'),
      (1,'310-0010','CASH AT BANK - MAYBANK','ASSET','310-0000',true,'2026-01-02T00:00:00Z'),
      (1,'310-0011','MAYBANK SUB','ASSET','310-0010',true,'2026-01-03T00:00:00Z'),
      (1,'930-0000','BANK CHARGES','EXPENSE',NULL,false,'2026-01-01T00:00:00Z'),
      (2,'310-0000','CASH AT BANK','ASSET',NULL,false,'2026-01-01T00:00:00Z'),
      (2,'310-0010','CASH AT BANK - MAYBANK','ASSET','310-0000',true,'2026-01-02T00:00:00Z');

    INSERT INTO scm.journal_entry_lines (company_id, account_code, debit_sen, credit_sen) VALUES
      (1,'310-0010',50000,0), (2,'310-0010',7000,0), (1,'930-0000',150,0);

    INSERT INTO scm.payment_vouchers (id, company_id, credit_account_code) VALUES
      ('pv-1',1,'310-0010'), ('pv-2',2,'310-0010');

    INSERT INTO scm.payment_voucher_lines (company_id, pv_id, debit_account_code) VALUES
      (1,'pv-1','930-0000'), (2,'pv-2','310-0010');

    INSERT INTO scm.acc_account_roles (company_id, role, account_code) VALUES
      (1,'BANK_DEFAULT','310-0010'), (2,'BANK_DEFAULT','310-0010'), (1,'CASH','930-0000');

    INSERT INTO scm.acc_vendor_memory (company_id, vendor_key, debit_account_code) VALUES
      (1,'TNB','310-0010');

    INSERT INTO scm.acc_company_acquirers (company_id, acquirer_code, transit_account_code, fee_account_code, bank_account_code) VALUES
      (1,'MBB','326-0000','930-0000','310-0010');

    INSERT INTO scm.acc_bank_statement_config (company_id, account_code, bank_code) VALUES
      (1,'310-0010','MBB');

    INSERT INTO scm.acc_bank_statements (company_id, account_code, file_name) VALUES
      (1,'310-0010','mbb-aug.csv');
  `);
}

async function connect(): Promise<Sql> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`SELECT 1`;
  return sql;
}

// A voucher-shaped insert that MUST refuse if the FKs still bite.
const DANGLING = `INSERT INTO scm.payment_vouchers (id, company_id, credit_account_code) VALUES ('pv-bad', 2, '999-9999')`;

describePg('0347 — acc_rename_account, proved against a real Postgres', () => {
  afterAll(async () => {
    /* Leave the shared database razeable for the next file (the relay test's
       own lesson): our FK children would block a later plain DROP. */
    if (admin) {
      await admin.unsafe(RAZE);
      await admin.end();
    }
  });

  beforeEach(async () => {
    admin ??= await connect();
    await resetToPreState(admin);
    await admin.unsafe(await migrationSql('_acc_chart_manage.sql'));
  });

  test('one call moves the code in every home, children follow, the FKs still bite', async () => {
    const [{ acc_rename_account: counts }] = await admin`
      SELECT scm.acc_rename_account('310-0010', '311-0010')`;

    expect(counts).toMatchObject({
      accounts: 2, children: 1, journal_lines: 2, pv_credit: 2, pv_debit: 1,
      vendor_memory: 1, acquirers: 1, bank_config: 1, bank_statements: 1, roles: 2,
    });

    const oldLeft = await admin`SELECT 1 FROM scm.accounts WHERE account_code = '310-0010'`;
    expect(oldLeft).toHaveLength(0);
    const renamed = await admin`
      SELECT company_id, account_name, parent_code, acc_money, created_at
      FROM scm.accounts WHERE account_code = '311-0010' ORDER BY company_id`;
    expect(renamed).toHaveLength(2);
    // The account is the same account — name, tree position, money flag and
    // birthday all rode along.
    expect(renamed[0]).toMatchObject({ company_id: 1, account_name: 'CASH AT BANK - MAYBANK', parent_code: '310-0000', acc_money: true });
    expect(new Date(renamed[0]!.created_at as string).toISOString()).toBe('2026-01-02T00:00:00.000Z');

    const [child] = await admin`SELECT parent_code FROM scm.accounts WHERE account_code = '310-0011'`;
    expect(child!.parent_code).toBe('311-0010');

    for (const [table, column] of [
      ['journal_entry_lines', 'account_code'],
      ['payment_vouchers', 'credit_account_code'],
      ['payment_voucher_lines', 'debit_account_code'],
      ['acc_vendor_memory', 'debit_account_code'],
      ['acc_company_acquirers', 'bank_account_code'],
      ['acc_bank_statement_config', 'account_code'],
      ['acc_bank_statements', 'account_code'],
      ['acc_account_roles', 'account_code'],
    ] as const) {
      const stale = await admin.unsafe(`SELECT 1 FROM scm.${table} WHERE ${column} = '310-0010'`);
      expect(stale, `${table}.${column} still holds the old code`).toHaveLength(0);
    }
    // The bystander and its references never moved.
    const [bystander] = await admin`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code = '930-0000'`;
    expect(bystander!.n).toBe(1);

    await expect(admin.unsafe(DANGLING)).rejects.toThrow(/payment_vouchers_company_credit_account_fk/);
  });

  test('renaming onto a live code raises and leaves NOTHING half-moved', async () => {
    await expect(admin`SELECT scm.acc_rename_account('310-0010', '930-0000')`)
      .rejects.toThrow(/already exists/);

    // The whole transaction rolled back: every home still shows the old code.
    const [jel] = await admin`SELECT count(*)::int AS n FROM scm.journal_entry_lines WHERE account_code = '310-0010'`;
    expect(jel!.n).toBe(2);
    const [acct] = await admin`SELECT count(*)::int AS n FROM scm.accounts WHERE account_code = '310-0010'`;
    expect(acct!.n).toBe(2);
  });

  test('unknown and malformed codes raise, and a hand replay of the migration is a no-op', async () => {
    await expect(admin`SELECT scm.acc_rename_account('888-0000', '889-0000')`)
      .rejects.toThrow(/does not exist/);
    await expect(admin`SELECT scm.acc_rename_account('310-0010', 'not-a-code')`)
      .rejects.toThrow(/account-code shape/);

    await admin.unsafe(await migrationSql('_acc_chart_manage.sql'));
    const [probe] = await admin`SELECT special_type FROM scm.accounts WHERE company_id = 1 AND account_code = '310-0010'`;
    expect(probe!.special_type).toBe('SBK');
  });
});
