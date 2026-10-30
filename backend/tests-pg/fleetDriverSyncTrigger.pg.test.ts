import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* Fleet drivers stop vanishing — proves, on a real postgres:16, the fixed
 * scm.sync_user_to_tms() trigger (migration 20261029T1700):
 *   - an "outsource transporter" (a 3PL / Penang driver) keeps a Fleet row
 *     (in_house = false), instead of being deactivated and disappearing;
 *   - a dispatcher-entered phone is NOT blanked when the account has none;
 *   - a mere position change does not retire the Fleet row — only disabling
 *     the account does.
 * SKIPPED without TEST_DATABASE_URL (CI: the postgres job runs npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'fleet_driver_sync_trigger';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_fix_fleet_sync_user_to_tms.sql'));
  if (files.length !== 1) throw new Error(`expected one *_fix_fleet_sync_user_to_tms.sql, found ${files.length}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

/* The columns the trigger reads/writes; positions are stored Title-Case and the
   trigger lower()s them. POS 1 = driver (in-house), 2 = outsource transporter
   (3PL), 3 = a non-driver role, 4 = storekeeper (a helper role). */
const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  DROP TABLE IF EXISTS public.users CASCADE;
  DROP TABLE IF EXISTS public.positions CASCADE;
  DROP TABLE IF EXISTS public.companies CASCADE;

  CREATE TABLE public.companies (id bigint PRIMARY KEY, code text NOT NULL);
  INSERT INTO public.companies (id, code) VALUES (1, 'HOUZS');

  CREATE TABLE public.positions (id bigint PRIMARY KEY, name text NOT NULL);
  INSERT INTO public.positions (id, name) VALUES
    (1, 'Driver'), (2, 'Outsource Transporter'), (3, 'Sales'), (4, 'Storekeeper');

  CREATE TABLE public.users (
    id integer PRIMARY KEY,
    name text NOT NULL,
    phone text,
    ic_number text,
    status text NOT NULL DEFAULT 'active',
    position_id bigint REFERENCES public.positions(id)
  );

  CREATE SEQUENCE scm.driver_code_seq;
  CREATE SEQUENCE scm.helper_code_seq;

  CREATE TABLE scm.drivers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id integer, driver_code text, name text, phone text, ic_number text,
    in_house boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
    company_id bigint
  );
  CREATE TABLE scm.helpers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id integer, helper_code text, name text, contact text, ic_number text,
    in_house boolean NOT NULL DEFAULT true, active boolean NOT NULL DEFAULT true,
    company_id bigint
  );
`;

let a: Sql;
let admin: Sql;

function urlFor(db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function driver(userId: number): Promise<{ active: boolean; in_house: boolean; name: string; phone: string | null } | undefined> {
  const rows = await a<Array<{ active: boolean; in_house: boolean; name: string; phone: string | null }>>`
    SELECT active, in_house, name, phone FROM scm.drivers WHERE user_id = ${userId}`;
  return rows[0];
}

describePg('Fleet driver sync trigger (scm.sync_user_to_tms)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    a = postgres(urlFor(DB), { max: 1, prepare: false });
  });

  afterAll(async () => {
    await a?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await a.unsafe(FIXTURE);
    await applyMigration(a);
  });

  test('an outsource transporter keeps a Fleet row (in_house=false, active)', async () => {
    await a`INSERT INTO public.users (id, name, phone, status, position_id) VALUES (1, 'Pak Mat', '+60123456789', 'invited', 2)`;
    const d = await driver(1);
    expect(d).toBeDefined();
    expect(d!.active).toBe(true);
    expect(d!.in_house).toBe(false);
    expect(d!.phone).toBe('+60123456789');
  });

  test('position exactly driver is in-house', async () => {
    await a`INSERT INTO public.users (id, name, phone, status, position_id) VALUES (2, 'Ali', '+60111', 'active', 1)`;
    const d = await driver(2);
    expect(d!.in_house).toBe(true);
    expect(d!.active).toBe(true);
  });

  test('a dispatcher-entered phone is not blanked when the account has none', async () => {
    // Account has no phone -> Fleet row starts blank.
    await a`INSERT INTO public.users (id, name, status, position_id) VALUES (3, 'Jaya', 'active', 1)`;
    expect((await driver(3))!.phone).toBe('');
    // Dispatcher fills the phone on the Fleet row.
    await a`UPDATE scm.drivers SET phone = '+60199' WHERE user_id = 3`;
    // Any later edit of the account must NOT wipe it back to blank.
    await a`UPDATE public.users SET name = 'Jaya Kumar' WHERE id = 3`;
    const d = await driver(3);
    expect(d!.phone).toBe('+60199');
    expect(d!.name).toBe('Jaya Kumar');
    expect(d!.active).toBe(true);
  });

  test('a position change does not retire the row; disabling the account does', async () => {
    await a`INSERT INTO public.users (id, name, phone, status, position_id) VALUES (4, 'Samad', '+60122', 'active', 1)`;
    expect((await driver(4))!.active).toBe(true);
    // Re-labelled to a non-driver position while still active -> stays in Fleet.
    await a`UPDATE public.users SET position_id = 3 WHERE id = 4`;
    expect((await driver(4))!.active).toBe(true);
    // Disabling the account (person left) is what retires the Fleet row.
    await a`UPDATE public.users SET status = 'disabled' WHERE id = 4`;
    expect((await driver(4))!.active).toBe(false);
  });
});
