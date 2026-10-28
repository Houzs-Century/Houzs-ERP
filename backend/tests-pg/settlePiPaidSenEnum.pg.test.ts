import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Real PostgreSQL proof that scm.settle_pi_paid_sen writes the invoice's status
   as the ENUM it is (docs/bugs/0700).

   THE BUG. scm.purchase_invoices.status is scm.purchase_invoice_status. 0147 —
   and 0305, which carried its body over to the _sen names — wrote the new
   status as a CASE of bare literals, trusting the planner to coerce them to the
   column's type. It coerces ONE bare literal; a CASE whose branches are all
   untyped literals is resolved on its own first ("all unknown → text"), and
   text has no assignment cast to an enum. So every call raised 42804, and every
   SUPPLIER_PAYMENT approval left its invoices at paid_sen 0 / POSTED with
   applied_sen 0 on the allocation. Reproduced on staging 2026-09-08 against the
   live definition (a DO-block probe, rolled back on purpose).

   WHY pvRateAdoption.pg.test.ts never saw it: its fixture declares
   `status text`. The function ran fine against a table that is not the table.
   This fixture declares the enum with the live label set, and integer money
   columns as the real table has them.

   WHICH DEFINITION. The LATEST one in the migration tree, found by scanning
   every file in runner order — so on the tree before the fix this resolves to
   0305's body and the first test fails with that very 42804 (that is the RED),
   and any later migration that redefines the function is what gets tested
   here, never a copy.

   Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. CI
   has one (`backend-postgres` -> `npm run test:pg`). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/* One CREATE [OR REPLACE] FUNCTION statement, up to its own $function$ terminator. */
const DEFINITION = /CREATE (?:OR REPLACE )?FUNCTION scm\.settle_pi_paid_sen\([\s\S]*?\n\$function\$;/;

async function latestSettleDefinition(): Promise<{ file: string; sql: string }> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  let found: { file: string; sql: string } | null = null;
  for (const file of files) {
    const m = DEFINITION.exec(await readFile(join(migrationsDir, file), 'utf8'));
    if (m) found = { file, sql: m[0] };
  }
  if (!found) throw new Error('no migration in the tree defines scm.settle_pi_paid_sen');
  return found;
}

let admin: Sql;
let definition: { file: string; sql: string };

/* scm.purchase_invoices cut down to what the function reads and writes — with
   the status column as the ENUM it really is (labels as on prod/staging
   2026-09-08) and the money columns integer, as 0305 left them. */
async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests require the disposable houzs_test database');
  }

  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS scm;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$;

    DROP TABLE IF EXISTS scm.purchase_invoices CASCADE;
    DROP TYPE IF EXISTS scm.purchase_invoice_status CASCADE;
    CREATE TYPE scm.purchase_invoice_status AS ENUM
      ('DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED', 'VOID', 'ON_HOLD');
    CREATE TABLE scm.purchase_invoices (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_number text,
      total_sen      integer NOT NULL DEFAULT 0,
      paid_sen       integer NOT NULL DEFAULT 0,
      status         scm.purchase_invoice_status NOT NULL DEFAULT 'POSTED',
      updated_at     timestamptz
    );
    -- 0305's statement is a bare CREATE FUNCTION: clear any earlier replay
    -- (pvRateAdoption installs one) so the definition under test is the one
    -- that runs, not an "already exists" error.
    DROP FUNCTION IF EXISTS scm.settle_pi_paid_sen(uuid, bigint);
  `);
  await sql.unsafe(definition.sql);
}

type PiRow = { id: string; invoice_number: string; total_sen: number; paid_sen: number; status: string };

async function seedPi(over: Partial<{ no: string; total: number; paid: number; status: string }> = {}): Promise<PiRow> {
  const rows = await admin<PiRow[]>`
    INSERT INTO scm.purchase_invoices (invoice_number, total_sen, paid_sen, status)
    VALUES (${over.no ?? '2990-PI-2607-002'}, ${over.total ?? 212_000}, ${over.paid ?? 0},
            ${over.status ?? 'POSTED'}::scm.purchase_invoice_status)
    RETURNING *`;
  return rows[0]!;
}

/** The REAL function, exactly as settlePiPaidSen's rpc reaches it. */
async function settle(piId: string, delta: number) {
  const rows = await admin<Array<{ applied_sen: string | null; new_paid_sen: string | null; new_status: string | null; reason: string | null }>>`
    SELECT * FROM scm.settle_pi_paid_sen(${piId}::uuid, ${delta}::bigint)`;
  const r = rows[0]!;
  return { appliedSen: Number(r.applied_sen ?? 0), newPaidSen: r.new_paid_sen == null ? null : Number(r.new_paid_sen), newStatus: r.new_status, reason: r.reason };
}

async function readPi(piId: string): Promise<PiRow> {
  const rows = await admin<PiRow[]>`SELECT * FROM scm.purchase_invoices WHERE id = ${piId}::uuid`;
  return rows[0]!;
}

describePg('scm.settle_pi_paid_sen against the REAL status enum (docs/bugs/0700)', () => {
  beforeAll(async () => {
    definition = await latestSettleDefinition();
    admin = postgres(url, { max: 4 });
    await resetFixture(admin);
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await admin`TRUNCATE scm.purchase_invoices`; });

  test('the newest definition in the tree types the status it writes', () => {
    // 0305's body is what a tree without the fix resolves to, and it does not.
    expect(definition.sql, `newest definition is in ${definition.file}`).toContain('::scm.purchase_invoice_status');
  });

  test('a full knock-off lands PAID on the enum column — 2990-PI-2607-002, RM 2,120.00', async () => {
    const pi = await seedPi();
    const r = await settle(pi.id, 212_000);
    expect(r).toEqual({ appliedSen: 212_000, newPaidSen: 212_000, newStatus: 'PAID', reason: null });
    const after = await readPi(pi.id);
    expect(after.status).toBe('PAID');
    expect(Number(after.paid_sen)).toBe(212_000);
  });

  test('a partial knock-off lands PARTIALLY_PAID — 2990-PI-2607-023, RM 1,184.00 of 1,254.00', async () => {
    const pi = await seedPi({ no: '2990-PI-2607-023', total: 125_400 });
    const r = await settle(pi.id, 118_400);
    expect(r.appliedSen).toBe(118_400);
    expect(r.newStatus).toBe('PARTIALLY_PAID');
    expect((await readPi(pi.id)).status).toBe('PARTIALLY_PAID');
  });

  test('a second voucher is clamped at the outstanding and still lands PAID', async () => {
    const pi = await seedPi({ paid: 100_000, status: 'PARTIALLY_PAID' });
    const r = await settle(pi.id, 212_000);
    expect(r.appliedSen).toBe(112_000);
    expect(r.newStatus).toBe('PAID');
    expect(Number((await readPi(pi.id)).paid_sen)).toBe(212_000);
  });

  test('the cancel path settles the negative of applied_sen and lands back on POSTED', async () => {
    const pi = await seedPi();
    const paid = await settle(pi.id, 212_000);
    const reversed = await settle(pi.id, -paid.appliedSen);
    expect(reversed.appliedSen).toBe(-212_000);
    expect(reversed.newStatus).toBe('POSTED');
    const after = await readPi(pi.id);
    expect(after.status).toBe('POSTED');
    expect(Number(after.paid_sen)).toBe(0);
  });

  test('DRAFT and CANCELLED are refused as not_live, the enum read back as text', async () => {
    for (const status of ['DRAFT', 'CANCELLED']) {
      const pi = await seedPi({ status });
      const r = await settle(pi.id, 212_000);
      expect(r).toEqual({ appliedSen: 0, newPaidSen: 0, newStatus: status, reason: 'not_live' });
      expect((await readPi(pi.id)).status).toBe(status);
    }
  });
});
