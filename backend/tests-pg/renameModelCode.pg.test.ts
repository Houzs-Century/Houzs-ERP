import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* mig *_scm_rename_model_code against real Postgres (2990-0022). A model's code
 * is copied onto its SKUs (mfg_products.base_model) and onto the combo and quick
 * pick rows that match on it. The function moves the model and all of those in
 * ONE transaction, one company, and refuses what it cannot move safely.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

const M1 = '00000000-0000-0000-0000-000000000001';
const M2 = '00000000-0000-0000-0000-000000000002';
const M3 = '00000000-0000-0000-0000-000000000003';
const M9 = '00000000-0000-0000-0000-000000000009';
const TABLES = ['product_models', 'mfg_products', 'sofa_combo_pricing', 'sofa_quick_picks', 'personal_quick_picks', 'pos_sofa_combos'];

let admin: Sql;

async function migrationSql(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_rename_model_code.sql'));
  if (files.length !== 1) throw new Error(`expected one *_scm_rename_model_code.sql, found ${files.join(', ')}`);
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

async function reset(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
  await sql.unsafe(`
    DO $roles$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
    END $roles$;
    CREATE SCHEMA IF NOT EXISTS scm;
    DROP FUNCTION IF EXISTS scm.rename_model_code(bigint, uuid, text);
    DROP TABLE IF EXISTS ${TABLES.map((t) => `scm.${t}`).join(', ')} CASCADE;
    CREATE TABLE scm.product_models (id uuid PRIMARY KEY, company_id bigint NOT NULL, model_code text NOT NULL, category text NOT NULL);
    CREATE TABLE scm.mfg_products (id serial PRIMARY KEY, company_id bigint NOT NULL, model_id uuid, code text NOT NULL, base_model text);
    CREATE TABLE scm.sofa_combo_pricing (company_id bigint NOT NULL, base_model text NOT NULL);
    CREATE TABLE scm.sofa_quick_picks (company_id bigint NOT NULL, base_model text NOT NULL);
    CREATE TABLE scm.personal_quick_picks (company_id bigint NOT NULL, base_model text NOT NULL);
    CREATE TABLE scm.pos_sofa_combos (company_id bigint NOT NULL, base_model text NOT NULL, deleted_at timestamptz);
  `);
  await sql.unsafe(await migrationSql());
}

async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    TRUNCATE ${TABLES.map((t) => `scm.${t}`).join(', ')};
    INSERT INTO scm.product_models VALUES ('${M1}', 1, '8210', 'SOFA'), ('${M2}', 1, '5000', 'SOFA'), ('${M9}', 2, '8210', 'SOFA');
    INSERT INTO scm.mfg_products (company_id, model_id, code, base_model) VALUES
      (1, '${M1}', '8210-3S', '8210'), (1, NULL, '8210-CNR', '8210'), (1, '${M2}', '5000-3S', '5000'), (2, '${M9}', '8210-3S', '8210');
    INSERT INTO scm.sofa_combo_pricing VALUES (1, '8210'), (2, '8210');
    INSERT INTO scm.sofa_quick_picks VALUES (1, '8210'), (2, '8210');
    INSERT INTO scm.personal_quick_picks VALUES (1, '8210'), (2, '8210');
  `);
}

const rename = async (sql: Sql, company: number, model: string, code: string) =>
  (await sql`SELECT scm.rename_model_code(${company}, ${model}::uuid, ${code}) AS r`)[0]!.r as Record<string, unknown>;
const bases = async (sql: Sql, table: string, company: number) =>
  (await sql.unsafe(`SELECT base_model FROM scm.${table} WHERE company_id = ${company} ORDER BY 1`)).map((r) => r.base_model);

describePg('scm.rename_model_code', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await reset(admin);
  });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => { await seed(admin); });

  test('the model, its SKUs and every keyed row follow the new code, this company only', async () => {
    const r = await rename(admin, 1, M1, '8210X');
    expect(r).toMatchObject({ renamed: true, from: '8210', to: '8210X' });
    expect(await bases(admin, 'mfg_products', 1)).toEqual(['5000', '8210X', '8210X']);
    for (const t of ['sofa_combo_pricing', 'sofa_quick_picks', 'personal_quick_picks']) {
      expect(await bases(admin, t, 1)).toEqual(['8210X']);
      expect(await bases(admin, t, 2)).toEqual(['8210']);
    }
    expect(await bases(admin, 'mfg_products', 2)).toEqual(['8210']);
    expect((await admin`SELECT company_id, model_code FROM scm.product_models ORDER BY id`).map((m) => `${m.company_id}:${m.model_code}`))
      .toEqual(['1:8210X', '1:5000', '2:8210']);
    expect((await admin`SELECT code FROM scm.mfg_products WHERE company_id = 1 AND model_id = ${M1}::uuid`)[0]!.code).toBe('8210-3S');
  });

  test('a failure half way rolls the whole rename back', async () => {
    await admin.unsafe(`ALTER TABLE scm.personal_quick_picks ADD CONSTRAINT no_x CHECK (base_model <> '8210X')`);
    try {
      await expect(rename(admin, 1, M1, '8210X')).rejects.toThrow();
      expect(await bases(admin, 'mfg_products', 1)).toEqual(['5000', '8210', '8210']);
      expect(await bases(admin, 'sofa_combo_pricing', 1)).toEqual(['8210']);
      expect((await admin`SELECT model_code FROM scm.product_models WHERE id = ${M1}::uuid`)[0]!.model_code).toBe('8210');
    } finally {
      await admin.unsafe(`ALTER TABLE scm.personal_quick_picks DROP CONSTRAINT no_x`);
    }
  });

  test('a model of another company is not found, and nothing moves', async () => {
    expect(await rename(admin, 2, M1, '8210X')).toMatchObject({ renamed: false, refused: 'not_found' });
    expect(await bases(admin, 'mfg_products', 1)).toEqual(['5000', '8210', '8210']);
  });

  test('refuses a code another model or a keyed row already uses', async () => {
    expect(await rename(admin, 1, M1, '5000')).toMatchObject({ renamed: false, refused: 'code_taken' });
    await admin.unsafe(`INSERT INTO scm.sofa_quick_picks VALUES (1, 'STRAY')`);
    expect(await rename(admin, 1, M1, 'STRAY')).toMatchObject({ renamed: false, refused: 'code_taken' });
    expect(await rename(admin, 1, M1, '  ')).toMatchObject({ renamed: false, refused: 'empty_code' });
    expect(await bases(admin, 'mfg_products', 1)).toEqual(['5000', '8210', '8210']);
  });

  test('refuses when another model still holds the old code', async () => {
    await admin.unsafe(`INSERT INTO scm.product_models VALUES ('${M3}', 1, '8210', 'MATTRESS')`);
    expect(await rename(admin, 1, M1, '8210X')).toMatchObject({ renamed: false, refused: 'code_shared' });
  });

  test('refuses while a live 2990 POS combo is under the old code, allows it once retired', async () => {
    await admin.unsafe(`INSERT INTO scm.pos_sofa_combos VALUES (1, '8210', NULL)`);
    expect(await rename(admin, 1, M1, '8210X')).toMatchObject({ renamed: false, refused: 'pos_combos_in_use' });
    await admin.unsafe(`UPDATE scm.pos_sofa_combos SET deleted_at = now()`);
    expect(await rename(admin, 1, M1, '8210X')).toMatchObject({ renamed: true });
  });

  test('the same code is a no-op', async () => {
    expect(await rename(admin, 1, M1, '8210')).toMatchObject({ renamed: false, unchanged: true });
  });
});
