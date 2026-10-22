import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* mig *_scm_pos_sofa_combos against real Postgres: 2990's POS selling combos
 * move to scm.pos_sofa_combos, which only scm.pos_sofa_combo_insert / _retire
 * may write (owner ruling 2026-09-26: Houzs combos are Houzs's cost, 2990
 * combos are the POS's selling price, and Houzs may not change 2990's).
 *
 * The guard IS the feature, and a fake PostgREST client has no triggers, so
 * the only honest proof is here. SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_pos_sofa_combos.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_pos_sofa_combos.sql, found ${files.join(', ')}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

const id = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
let admin: Sql;

async function reset(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');

  await sql.unsafe(`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $roles$;
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP TABLE IF EXISTS scm.pos_sofa_combo_audit, scm.pos_sofa_combos, scm.pos_combo_lock_2990, scm.sofa_combo_pricing CASCADE;
    DROP FUNCTION IF EXISTS scm.pos_sofa_combo_insert(bigint, jsonb, jsonb), scm.pos_sofa_combo_retire(bigint, uuid, jsonb),
      scm.pos_sofa_combos_guard(), scm.pos_sofa_combo_audit_guard(), scm.sofa_combo_2990_lock(), scm.sofa_combo_2990_autolock() CASCADE;
    DROP TABLE IF EXISTS public.companies CASCADE;
    CREATE TABLE public.companies (id bigint PRIMARY KEY, code text);
    INSERT INTO public.companies VALUES (1, 'HOUZS'), (2, '2990');

    CREATE TABLE scm.sofa_combo_pricing (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint NOT NULL, base_model text NOT NULL,
      modules jsonb NOT NULL DEFAULT '[]', tier text, customer_id uuid, supplier_id uuid,
      prices_by_height jsonb NOT NULL DEFAULT '{}', selling_prices_by_height jsonb NOT NULL DEFAULT '{}',
      pwp_prices_by_height jsonb NOT NULL DEFAULT '{}', default_free_gifts jsonb NOT NULL DEFAULT '[]',
      label text, effective_from date NOT NULL, deleted_at timestamptz, notes text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), created_by uuid);

    INSERT INTO scm.sofa_combo_pricing (id, company_id, base_model, modules, tier, selling_prices_by_height, prices_by_height, pwp_prices_by_height, effective_from, created_at, deleted_at, supplier_id) VALUES
      ('${id(1)}', 2, 'Xammar', '[["1S"]]', 'PRICE_1', '{"24":149000}', '{"24":90000}', '{"24":99000}', '2026-05-31', '2026-05-31T00:00:00Z', NULL, NULL),
      ('${id(2)}', 2, 'Xammar', '[["2S"]]', 'PRICE_1', '{"24":199000}', '{}', '{}', '2026-05-31', '2026-05-31T00:00:00Z', '2026-06-01T00:00:00Z', NULL),
      ('${id(3)}', 2, 'Boaat', '[["1S"]]', 'PRICE_2', '{"24":1}', '{"24":1}', '{}', '2026-08-19', '2026-08-19T00:00:00Z', NULL, NULL),
      ('${id(4)}', 2, 'Lotti', '[["1S","2S","3S"]]', 'PRICE_1', '{"24":360000}', '{"24":360000}', '{}', '2026-09-26', '2026-09-26T07:33:00Z', '2026-09-26T08:00:00Z', NULL),
      ('${id(5)}', 2, 'Qubbu', '[["1S"]]', 'PRICE_1', '{"24":120000}', '{"24":80000}', '{}', '2026-09-27', '2026-09-27T03:00:00Z', NULL, NULL),
      ('${id(6)}', 2, 'Xammar', '[["1S"]]', 'PRICE_1', '{"24":1}', '{}', '{}', '2026-05-31', '2026-05-31T00:00:00Z', NULL, gen_random_uuid()),
      ('${id(7)}', 1, 'HouzsSofa', '[["1S"]]', 'PRICE_1', '{"24":1}', '{}', '{}', '2026-05-31', '2026-05-31T00:00:00Z', NULL, NULL);

    -- The hand-applied temporary lock the migration retires.
    CREATE TABLE scm.pos_combo_lock_2990 (combo_id uuid PRIMARY KEY, locked_at timestamptz DEFAULT now(), source text);
    INSERT INTO scm.pos_combo_lock_2990 (combo_id, source) VALUES ('${id(1)}', 'live'), ('${id(3)}', 'live'), ('${id(5)}', 'pos_insert');
    CREATE FUNCTION scm.sofa_combo_2990_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE FUNCTION scm.sofa_combo_2990_autolock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER trg_sofa_combo_2990_lock BEFORE INSERT OR UPDATE OR DELETE ON scm.sofa_combo_pricing FOR EACH ROW EXECUTE FUNCTION scm.sofa_combo_2990_lock();
    CREATE TRIGGER trg_sofa_combo_2990_autolock AFTER INSERT ON scm.sofa_combo_pricing FOR EACH ROW EXECUTE FUNCTION scm.sofa_combo_2990_autolock();
  `);
}

const apply = async (sql: Sql) => sql.unsafe(await migrationSql());
const count = async (sql: Sql, q: string) => Number((await sql.unsafe(q))[0]!.n);

async function refused(sql: Sql, q: string): Promise<string> {
  try {
    await sql.begin(async (tx) => { await tx.unsafe(q); });
  } catch (e) {
    return String((e as Error).message);
  }
  return '';
}

describePg('2990 POS combos in their own guarded table (mig *_scm_pos_sofa_combos)', () => {
  beforeAll(async () => { admin = postgres(url, { max: 2, onnotice: () => {} }); });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await reset(admin); await apply(admin); });

  test('imports exactly company 2\'s POS-authored PRICE_1 combos, ids and history kept', async () => {
    const rows = await admin.unsafe(`SELECT id::text AS id, deleted_at IS NOT NULL AS retired FROM scm.pos_sofa_combos ORDER BY id`);
    // 1 live, 2 retired history, 5 locked during the lock window. Not 3 (PRICE_2
    // = Houzs cost), 4 (Houzs row, not locked), 6 (supplier), 7 (company 1).
    expect(rows.map((r) => r.id)).toEqual([id(1), id(2), id(5)]);
    expect(rows.find((r) => r.id === id(2))!.retired).toBe(true);
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combo_audit WHERE action = 'import'`)).toBe(3);
    expect(await count(admin, `SELECT count(*) n FROM scm.sofa_combo_pricing`)).toBe(7);
  });

  test('retires the temporary lock and is safe to re-apply', async () => {
    expect((await admin.unsafe(`SELECT to_regclass('scm.pos_combo_lock_2990') AS t`))[0]!.t).toBeNull();
    expect(await count(admin, `SELECT count(*) n FROM pg_trigger WHERE tgname LIKE 'trg_sofa_combo_2990%'`)).toBe(0);
    await apply(admin);
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combos`)).toBe(3);
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combo_audit WHERE action = 'import'`)).toBe(3);
  });

  test('no direct write gets through: insert, retire, price edit, delete, truncate', async () => {
    expect(await refused(admin, `INSERT INTO scm.pos_sofa_combos (company_id, base_model, effective_from) VALUES (2, 'X', '2026-10-01')`)).toMatch(/written only by the 2990 POS/);
    expect(await refused(admin, `UPDATE scm.pos_sofa_combos SET deleted_at = now() WHERE id = '${id(1)}'`)).toMatch(/written only by the 2990 POS/);
    expect(await refused(admin, `UPDATE scm.pos_sofa_combos SET selling_prices_by_height = '{}' WHERE id = '${id(1)}'`)).toMatch(/written only by the 2990 POS/);
    expect(await refused(admin, `DELETE FROM scm.pos_sofa_combos WHERE id = '${id(1)}'`)).toMatch(/never deleted/);
    expect(await refused(admin, `TRUNCATE scm.pos_sofa_combos`)).toMatch(/never deleted/);
    // Even holding the writer credential, a combo is append-only.
    expect(await refused(admin, `SELECT set_config('scm.pos_sofa_combo_writer', 'pos', true); UPDATE scm.pos_sofa_combos SET selling_prices_by_height = '{}' WHERE id = '${id(1)}'`)).toMatch(/append-only/);
    expect(await refused(admin, `DELETE FROM scm.pos_sofa_combo_audit`)).toMatch(/append-only/);
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combos WHERE deleted_at IS NULL`)).toBe(2);
  });

  test('the two functions write, audit the real caller, and stay inside the company', async () => {
    const [created] = await admin.unsafe(`SELECT * FROM scm.pos_sofa_combo_insert(2,
      '{"base_model":"Xammar","modules":[["1A(LHF)","1A(RHF)"],["2A(LHF)","2A(RHF)"]],"tier":"PRICE_1","selling_prices_by_height":{"24":249000},"effective_from":"2026-09-27"}'::jsonb,
      '{"user_id":42,"name":"Loo","email":"loo@example.com"}'::jsonb)`);
    expect(created!.created_by_name).toBe('Loo');
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combo_audit WHERE action = 'create' AND actor_user_id = 42 AND combo_id = '${created!.id}'`)).toBe(1);

    const retire = async (co: number) => (await admin.unsafe(`SELECT scm.pos_sofa_combo_retire(${co}, '${created!.id}', '{"user_id":42,"name":"Loo"}'::jsonb) AS r`))[0]!.r;
    expect(await retire(1)).toBe(false);   // another company's id resolves to nothing
    expect(await retire(2)).toBe(true);
    expect(await retire(2)).toBe(false);   // already retired
    expect(await count(admin, `SELECT count(*) n FROM scm.pos_sofa_combo_audit WHERE action = 'retire' AND combo_id = '${created!.id}'`)).toBe(1);
  });

  test('PostgREST can read but never write the table directly; only service_role runs the writers', async () => {
    const [g] = await admin.unsafe(`SELECT
      has_table_privilege('service_role', 'scm.pos_sofa_combos', 'SELECT') AS sel,
      has_table_privilege('service_role', 'scm.pos_sofa_combos', 'INSERT') AS ins,
      has_table_privilege('service_role', 'scm.pos_sofa_combos', 'UPDATE') AS upd,
      has_table_privilege('anon', 'scm.pos_sofa_combos', 'SELECT') AS anon_sel,
      has_function_privilege('service_role', 'scm.pos_sofa_combo_insert(bigint, jsonb, jsonb)', 'EXECUTE') AS svc,
      has_function_privilege('anon', 'scm.pos_sofa_combo_insert(bigint, jsonb, jsonb)', 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', 'scm.pos_sofa_combo_retire(bigint, uuid, jsonb)', 'EXECUTE') AS auth_exec`);
    expect(g).toMatchObject({ sel: true, ins: false, upd: false, anon_sel: false, svc: true, anon_exec: false, auth_exec: false });
  });
});
