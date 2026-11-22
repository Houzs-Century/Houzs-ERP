import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter the migration runner uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* *_scm_pv_allocation_settle_once.sql on real PostgreSQL (ported from Conts-ERP #1137, D1 D2 D12):
 *   - settle_pv_allocation settles once: a second call moves nothing;
 *   - unsettle_pv_allocation takes back exactly what was applied, once;
 *   - apply_supplier_advance: two applies racing for the same advance cannot both spend it.
 * The settle functions it builds on are the LATEST definitions in the migration tree (as
 * settlePiPaidSenEnum.pg.test.ts finds them). Skipped without TEST_DATABASE_URL; CI has one. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

const PV = '00000000-0000-0000-0000-0000000000a1';
const PI = '00000000-0000-0000-0000-0000000000b1';
const PI2 = '00000000-0000-0000-0000-0000000000b2';
const AL = '00000000-0000-0000-0000-0000000000c1';

/* The tables the functions read and write, cut down to their columns, with the PI status as the enum it is. */
const FIXTURE = `
  CREATE SCHEMA IF NOT EXISTS scm;
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $$;
  DROP TABLE IF EXISTS scm.pv_allocations, scm.acc_supplier_advances, scm.payment_vouchers, scm.ap_invoices, scm.purchase_invoices CASCADE;
  DROP TYPE IF EXISTS scm.purchase_invoice_status CASCADE;
  DROP FUNCTION IF EXISTS scm.settle_pi_paid_sen(uuid, bigint);
  DROP FUNCTION IF EXISTS scm.settle_api_paid_sen(uuid, bigint);
  CREATE TYPE scm.purchase_invoice_status AS ENUM ('DRAFT','POSTED','PARTIALLY_PAID','PAID','CANCELLED','VOID','ON_HOLD');
  CREATE TABLE scm.purchase_invoices (id uuid PRIMARY KEY, status scm.purchase_invoice_status NOT NULL DEFAULT 'POSTED',
    total_sen integer NOT NULL, paid_sen integer NOT NULL DEFAULT 0, updated_at timestamptz);
  CREATE TABLE scm.ap_invoices (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'POSTED',
    total_sen bigint NOT NULL, paid_sen bigint NOT NULL DEFAULT 0, updated_at timestamptz);
  CREATE TABLE scm.payment_vouchers (id uuid PRIMARY KEY, status text NOT NULL, posted_at timestamptz);
  CREATE TABLE scm.pv_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pv_id uuid NOT NULL, pi_id uuid,
    amount_sen bigint NOT NULL DEFAULT 0, applied_sen bigint NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
    company_id bigint DEFAULT 1, from_advance boolean NOT NULL DEFAULT false, ap_invoice_id uuid);
  CREATE TABLE scm.acc_supplier_advances (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, company_id integer NOT NULL,
    supplier_id text NOT NULL, pv_id text NOT NULL UNIQUE, pv_number text NOT NULL,
    amount_sen bigint NOT NULL CHECK (amount_sen > 0),
    applied_sen bigint NOT NULL DEFAULT 0 CHECK (applied_sen >= 0 AND applied_sen <= amount_sen),
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
`;

async function latestDefinition(name: string): Promise<string> {
  const re = new RegExp(`CREATE (?:OR REPLACE )?FUNCTION scm\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let found: string | null = null;
  for (const file of files) {
    const m = re.exec(await readFile(join(migrationsDir, file), 'utf8'));
    if (m) found = m[0];
  }
  if (!found) throw new Error(`no migration in the tree defines scm.${name}`);
  return found;
}

let sql: Sql;

describePg('a payment voucher settles and unwinds each invoice exactly once', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    if (parsed.pathname !== '/houzs_test') {
      throw new Error('PG integration tests require the disposable houzs_test database');
    }
    sql = postgres(url, { max: 4, onnotice: () => {} });
  });
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  beforeEach(async () => {
    await sql.unsafe(FIXTURE);
    await sql.unsafe(await latestDefinition('settle_pi_paid_sen'));
    await sql.unsafe(await latestDefinition('settle_api_paid_sen'));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_pv_allocation_settle_once.sql'));
    if (files.length !== 1) throw new Error(`expected one *_scm_pv_allocation_settle_once.sql, found ${files.length}`);
    const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
    for (const s of stmts) await sql.unsafe(s);
    await sql.unsafe(`
      INSERT INTO scm.payment_vouchers VALUES ('${PV}', 'POSTED', now());
      INSERT INTO scm.purchase_invoices (id, total_sen) VALUES ('${PI}', 200000), ('${PI2}', 150000);
      INSERT INTO scm.pv_allocations (id, pv_id, pi_id, amount_sen) VALUES ('${AL}', '${PV}', '${PI}', 250000);
    `);
  });

  const paid = async (id: string) => Number((await sql.unsafe<Array<{ paid_sen: string }>>(
    'SELECT paid_sen FROM scm.purchase_invoices WHERE id = $1', [id]))[0]!.paid_sen);

  test('settle once: the clamp is recorded, and a second call moves nothing', async () => {
    const [first] = await sql.unsafe(`SELECT * FROM scm.settle_pv_allocation('${AL}')`);
    expect(first).toMatchObject({ applied: '200000', asked: '250000', already_settled: false });
    expect(await paid(PI)).toBe(200000);
    const [second] = await sql.unsafe(`SELECT * FROM scm.settle_pv_allocation('${AL}')`);
    expect(second).toMatchObject({ applied: '200000', already_settled: true });
    expect(await paid(PI)).toBe(200000);
  });

  test('unsettle once: exactly what was applied comes off, and a second call takes nothing', async () => {
    await sql.unsafe(`SELECT * FROM scm.settle_pv_allocation('${AL}')`);
    const [r1] = await sql.unsafe(`SELECT * FROM scm.unsettle_pv_allocation('${AL}')`);
    expect(r1).toMatchObject({ reversed: '200000', recorded: '200000' });
    expect(await paid(PI)).toBe(0);
    await sql.unsafe(`SELECT * FROM scm.unsettle_pv_allocation('${AL}')`);
    expect(await paid(PI)).toBe(0);
    const [a] = await sql.unsafe(`SELECT applied_sen, settled_at FROM scm.pv_allocations WHERE id = '${AL}'`);
    expect(a).toMatchObject({ applied_sen: '0', settled_at: null });
  });

  test('two applies racing for one advance: the second is refused, the advance is spent once', async () => {
    await sql.unsafe(`INSERT INTO scm.acc_supplier_advances (company_id, supplier_id, pv_id, pv_number, amount_sen)
                      VALUES (1, 'sup-1', '${PV}', 'PV-1', 100000)`);
    const want = (pi: string) => sql.unsafe(
      'SELECT * FROM scm.apply_supplier_advance($1::uuid, 1, $2::jsonb)',
      [PV, sql.json([{ pi_id: pi, amount_sen: 100000 }])] as never[],
    ).then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
    const outcomes = await Promise.all([want(PI), want(PI2)]);
    expect(outcomes.sort()).toEqual(['P0415', 'ok']);
    const [adv] = await sql.unsafe('SELECT applied_sen FROM scm.acc_supplier_advances');
    expect(adv!.applied_sen).toBe('100000');
    expect((await paid(PI)) + (await paid(PI2))).toBe(100000);
    const rows = await sql.unsafe('SELECT * FROM scm.pv_allocations WHERE from_advance');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settled_at).not.toBeNull();
  });

  test("a cancelled voucher's advance cannot be applied", async () => {
    await sql.unsafe(`INSERT INTO scm.acc_supplier_advances (company_id, supplier_id, pv_id, pv_number, amount_sen)
                      VALUES (1, 'sup-1', '${PV}', 'PV-1', 100000)`);
    await sql.unsafe(`UPDATE scm.payment_vouchers SET status = 'CANCELLED'`);
    await expect(sql.unsafe(`SELECT * FROM scm.apply_supplier_advance('${PV}', 1, '[{"pi_id":"${PI}","amount_sen":1000}]'::jsonb)`))
      .rejects.toMatchObject({ code: 'P0415' });
    expect(await paid(PI)).toBe(0);
  });

  test('the backfill marks a visibly settled allocation of a POSTED voucher, and leaves an unsettled one open', async () => {
    const stmts = splitSqlStatements(await readFile(join(migrationsDir,
      (await readdir(migrationsDir)).find((f) => f.endsWith('_scm_pv_allocation_settle_once.sql'))!), 'utf8')) as string[];
    const backfill = stmts.find((s) => /UPDATE scm\.pv_allocations a/.test(s))!;
    const AL2 = '00000000-0000-0000-0000-0000000000c2';
    await sql.unsafe(`
      UPDATE scm.pv_allocations SET applied_sen = 200000, settled_at = NULL WHERE id = '${AL}';
      INSERT INTO scm.pv_allocations (id, pv_id, pi_id, amount_sen, applied_sen) VALUES ('${AL2}', '${PV}', '${PI2}', 50000, 0);
    `);
    await sql.unsafe(backfill);
    const rows = await sql.unsafe<Array<{ id: string; settled_at: Date | null }>>('SELECT id, settled_at FROM scm.pv_allocations ORDER BY id');
    expect(rows.find((r) => r.id === AL)!.settled_at).not.toBeNull();
    expect(rows.find((r) => r.id === AL2)!.settled_at).toBeNull();
  });
});
