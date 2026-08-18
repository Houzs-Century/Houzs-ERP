import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { planPvRateAdoption, roundRate6 } from '../src/scm/lib/pv-rate-adoption';

/* Real PostgreSQL proof for "the payment defines the FX rate" (owner-approved
   2026-07-30) — the two halves of it that a fake PostgREST client CANNOT establish:

   1. THE CLAMP IS PL/pgSQL, NOT TYPESCRIPT. scm.settle_pi_paid_sen (mig 0147) is
      what decides how much of an allocation actually reaches the invoice, and the
      rate adoption keys off exactly that returned applied_sen. If the function's
      arithmetic and the pure decision disagree, the adoption fires on payments that
      moved no money (or misses ones that did). Only the real function settles that.

   2. THE RATE COLUMN IS numeric(14,6). The adopted rate is written into that
      column and read back by recostFromGrn on every later recost. A rate that does
      not survive the round-trip bit-for-bit would make planPvRateAdoption see a
      "change" on every subsequent payment and re-cost the GRN forever — or, worse,
      report a MISMATCH against the rate it had itself just written.

   The recost CASCADE beyond that point is deliberately not attempted here: it runs
   through supabase-js/PostgREST and the prod-only FIFO trigger, neither of which
   this raw-`postgres` harness stands up. It is covered instead in
   tests/pvRateFromPayment.test.ts, which drives the REAL recostFromGrn and asserts
   the FIFO lot moves off its 1:1 basis.

   Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. CI has
   one (`backend-postgres` -> `npm run test:pg`). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/* By SUFFIX, never by number — migration files get renumbered whenever a parallel
   PR takes a slot, and a number-pinned read would silently resolve to nothing. */
async function settleMigrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_settle_pi_paid_centi.sql'));
  if (files.length !== 1) {
    throw new Error(
      `expected exactly one *_scm_settle_pi_paid_centi.sql migration, found ${files.length}: ${files.join(', ')}`,
    );
  }
  return (await readFile(join(migrationsDir, files[0]), 'utf8')).replace(/_centi/g, '_sen');
}

let admin: Sql;

/* scm.purchase_invoices cut down to the columns this path reads and writes.
   exchange_rate is numeric(14,6) NOT NULL DEFAULT 1 exactly as migration 0082
   declares it — the precision is the thing under test, so it is not simplified. */
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
    CREATE TABLE scm.purchase_invoices (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_number text,
      grn_id        uuid,
      currency      text NOT NULL DEFAULT 'MYR',
      exchange_rate numeric(14,6) NOT NULL DEFAULT 1,
      total_sen   bigint NOT NULL DEFAULT 0,
      paid_sen    bigint NOT NULL DEFAULT 0,
      status        text NOT NULL DEFAULT 'POSTED',
      updated_at    timestamptz
    );
  `);

  await sql.unsafe(await settleMigrationSql());
}

/* The owner's real 2026-07-30 shape: one RMB invoice of ¥21,625.00 booked at rate 1
   because nobody had filled in the RMB rate, then paid at 0.619838. */
const FACE = 2_162_500;
const RMB_RATE = 0.619838;

type PiRow = { id: string; invoice_number: string; currency: string; exchange_rate: string; grn_id: string | null; total_sen: string; paid_sen: string; status: string };

async function seedPi(over: Partial<{ currency: string; rate: number; paid: number; status: string; grnId: string | null }> = {}): Promise<PiRow> {
  const rows = await admin<PiRow[]>`
    INSERT INTO scm.purchase_invoices (invoice_number, currency, exchange_rate, grn_id, total_sen, paid_sen, status)
    VALUES (
      '2990-PI-2607-004',
      ${over.currency ?? 'RMB'},
      ${over.rate ?? 1},
      ${over.grnId === undefined ? '11111111-1111-1111-1111-111111111111' : over.grnId},
      ${FACE},
      ${over.paid ?? 0},
      ${over.status ?? 'POSTED'}
    )
    RETURNING *`;
  return rows[0]!;
}

/** Call the REAL PL/pgSQL clamp, exactly as settlePiPaidSen's atomic path does. */
async function settle(piId: string, delta: number) {
  const rows = await admin<Array<{ applied_sen: string | null; new_paid_sen: string | null; new_status: string | null; reason: string | null }>>`
    SELECT * FROM scm.settle_pi_paid_sen(${piId}::uuid, ${delta}::bigint)`;
  const r = rows[0]!;
  return { appliedSen: Number(r.applied_sen ?? 0), newStatus: r.new_status, reason: r.reason };
}

async function readPi(piId: string): Promise<PiRow> {
  const rows = await admin<PiRow[]>`SELECT * FROM scm.purchase_invoices WHERE id = ${piId}::uuid`;
  return rows[0]!;
}

/** The production sequence, verbatim: settle -> plan off the REAL applied figure ->
 *  write the adopted rate. Returns the plan so each test can assert the decision. */
async function knockOff(pi: PiRow, delta: number, pv: { currency: string; rate: number }) {
  const settled = await settle(pi.id, delta);
  const fresh = await readPi(pi.id);
  const plan = planPvRateAdoption({
    appliedSen: settled.appliedSen,
    pvCurrency: pv.currency,
    pvExchangeRate: pv.rate,
    pi: {
      piId: fresh.id, docNo: fresh.invoice_number, currency: fresh.currency,
      exchangeRate: fresh.exchange_rate, grnId: fresh.grn_id,
    },
  });
  if (plan.action === 'adopt') {
    await admin`UPDATE scm.purchase_invoices SET exchange_rate = ${plan.rate}, updated_at = now() WHERE id = ${pi.id}::uuid`;
  }
  return { settled, plan };
}

describePg('the payment defines the FX rate — against real Postgres', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 4 });
    await resetFixture(admin);
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await admin`TRUNCATE scm.purchase_invoices`; });

  describe('the PL/pgSQL clamp is what the adoption keys off', () => {
    test('a full knock-off applies the face value and the un-rated invoice ADOPTS', async () => {
      const pi = await seedPi();
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });

      expect(settled.appliedSen).toBe(FACE);
      expect(settled.newStatus).toBe('PAID');
      expect(plan).toEqual({
        action: 'adopt', rate: RMB_RATE, oldRate: 1,
        grnId: '11111111-1111-1111-1111-111111111111',
      });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(RMB_RATE);
    });

    test('a PARTIAL knock-off still applies money, so the rate is still adopted', async () => {
      const pi = await seedPi();
      const { settled, plan } = await knockOff(pi, FACE / 2, { currency: 'RMB', rate: RMB_RATE });
      expect(settled.appliedSen).toBe(FACE / 2);
      expect(settled.newStatus).toBe('PARTIALLY_PAID');
      expect(plan).toMatchObject({ action: 'adopt', rate: RMB_RATE });
    });

    test('an ALREADY-PAID invoice is clamped to 0 by the FUNCTION, and nothing is adopted', async () => {
      // The critical composition: the clamp lives in the database, so only the
      // database can tell us the payment moved nothing onto this invoice.
      const pi = await seedPi({ paid: FACE, status: 'PAID' });
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(settled.appliedSen).toBe(0);
      expect(plan).toEqual({ action: 'skip', reason: 'nothing_applied' });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(1); // still the hole
    });

    test('a PARTIALLY over-allocated payment applies only the remainder — and that is enough to adopt', async () => {
      const pi = await seedPi({ paid: FACE - 100, status: 'PARTIALLY_PAID' });
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(settled.appliedSen).toBe(100);
      expect(plan).toMatchObject({ action: 'adopt', rate: RMB_RATE });
    });

    test('a DRAFT invoice is refused by the function, so no rate is adopted', async () => {
      const pi = await seedPi({ status: 'DRAFT' });
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(settled.appliedSen).toBe(0);
      expect(settled.reason).toBe('not_live');
      expect(plan).toEqual({ action: 'skip', reason: 'nothing_applied' });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(1);
    });

    test('a CANCELLED invoice likewise adopts nothing', async () => {
      const pi = await seedPi({ status: 'CANCELLED' });
      const { plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(plan).toEqual({ action: 'skip', reason: 'nothing_applied' });
    });
  });

  describe('an invoice with a deliberate rate is left alone by the real sequence', () => {
    test('the settlement lands but the stored rate is NOT overwritten', async () => {
      const pi = await seedPi({ rate: 0.62 });
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(settled.appliedSen).toBe(FACE);        // the money still moved
      expect(plan).toEqual({ action: 'report_mismatch', piRate: 0.62, pvRate: RMB_RATE });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(0.62); // untouched
    });
  });

  describe('an ALL-MYR knock-off is untouched by any of this', () => {
    test('the invoice settles and its rate stays 1', async () => {
      const pi = await seedPi({ currency: 'MYR', rate: 1 });
      const { settled, plan } = await knockOff(pi, FACE, { currency: 'MYR', rate: 1 });
      expect(settled.appliedSen).toBe(FACE);
      expect(plan).toEqual({ action: 'skip', reason: 'myr_invoice' });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(1);
    });
  });

  describe('numeric(14,6) — the adopted rate must survive the round-trip exactly', () => {
    test('0.619838 stores and reads back bit-for-bit, so a re-payment sees NO change', async () => {
      const pi = await seedPi();
      await knockOff(pi, FACE / 2, { currency: 'RMB', rate: RMB_RATE });
      const stored = (await readPi(pi.id)).exchange_rate;
      expect(Number(stored)).toBe(RMB_RATE);
      expect(roundRate6(stored)).toBe(RMB_RATE);

      /* The invariant that matters: the SECOND payment at the same rate must resolve
         to already_at_this_rate — NOT to report_mismatch against the rate this very
         code wrote a moment ago, and NOT to another adopt that re-costs the GRN
         again on every single payment. */
      const second = planPvRateAdoption({
        appliedSen: 1,
        pvCurrency: 'RMB',
        pvExchangeRate: RMB_RATE,
        pi: { piId: pi.id, docNo: pi.invoice_number, currency: 'RMB', exchangeRate: stored, grnId: null },
      });
      expect(second).toEqual({ action: 'skip', reason: 'already_at_this_rate' });
    });

    test('a rate with more than 6 decimals is truncated by the column, and the plan agrees', async () => {
      // planPvRateAdoption rounds to 6dp before writing precisely so the value it
      // believes it stored is the value the column holds.
      const pi = await seedPi();
      const { plan } = await knockOff(pi, FACE, { currency: 'RMB', rate: 0.6198384999 });
      expect(plan).toMatchObject({ action: 'adopt', rate: 0.619838 });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(0.619838);
    });

    test('the numeric column is what PostgREST hands back as a STRING, and the plan reads it correctly', async () => {
      const pi = await seedPi({ rate: 1 });
      const raw = (await readPi(pi.id)).exchange_rate;
      expect(typeof raw).toBe('string');   // '1.000000'
      expect(roundRate6(raw)).toBe(1);     // still recognised as the un-rated hole
    });
  });

  describe('the reversal a CANCEL performs leaves the rate standing', () => {
    test('paid_sen unwinds to 0 while exchange_rate keeps the adopted value', async () => {
      const pi = await seedPi();
      const { settled } = await knockOff(pi, FACE, { currency: 'RMB', rate: RMB_RATE });
      expect(Number((await readPi(pi.id)).exchange_rate)).toBe(RMB_RATE);

      // What cancelPaymentVoucherHandler does: settle the negative of what it applied.
      const reversed = await settle(pi.id, -settled.appliedSen);
      expect(reversed.appliedSen).toBe(-FACE);
      const after = await readPi(pi.id);
      expect(Number(after.paid_sen)).toBe(0);
      expect(after.status).toBe('POSTED');
      // The deliberate choice: the rate is NOT reverted to 1 (the R2 mis-cost).
      expect(Number(after.exchange_rate)).toBe(RMB_RATE);
    });
  });
});
