import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types.
import { readAddons, readModels, planModels, writeModels, readPools, swapInPool } from '../scripts/lib/hc0173-model-special-sql.mjs';

/* HC-0173 — repair-hc0173-model-special-codes.mjs's SQL on a real postgres, so
 * the jsonb rewrite (order kept, no duplicate) is exercised. SKIPPED without
 * TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'hc0173_model_special_repair';
const CO = 1;
const M = (n: number) => `0173${String(n).padStart(4, '0')}-0000-4000-8000-000000000000`;

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TABLE scm.special_addons (
    id serial PRIMARY KEY, company_id bigint NOT NULL, code text NOT NULL,
    categories text[], active boolean NOT NULL DEFAULT true
  );
  CREATE TABLE scm.product_models (
    id uuid PRIMARY KEY, company_id bigint NOT NULL, category text NOT NULL, model_code text NOT NULL,
    name text, active boolean DEFAULT true, allowed_options jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz
  );
`;

/* Production on 2026-10-28: CELENE (A) ticks the old Hydraulic, CROWN (S+S)
   already ticks HYDRAULIC. The rest are the shapes around them. */
async function seed(sql: Sql): Promise<void> {
  await sql.unsafe(`
    INSERT INTO scm.special_addons (company_id, code, categories, active) VALUES
      (1, 'Hydraulic', '{BEDFRAME}', false),
      (1, 'HYDRAULIC', '{BEDFRAME}', true);
    INSERT INTO scm.product_models (id, company_id, category, model_code, name, allowed_options) VALUES
      ('${M(1)}', 1, 'BEDFRAME', 'CELENE (A)', 'CELENE (A)',
        '{"sizes":["K","Q"],"specials":["1 Piece Divan","Hydraulic","Right Drawer"]}'),
      ('${M(2)}', 1, 'BEDFRAME', 'MIXED', 'MIXED',
        '{"specials":["HYDRAULIC","Left Drawer","Hydraulic"]}'),
      ('${M(3)}', 1, 'BEDFRAME', 'CROWN (S+S)', 'CROWN (S+S)',
        '{"specials":["1 Piece Divan","HYDRAULIC"]}'),
      ('${M(4)}', 1, 'BEDFRAME', 'OPEN POOL', 'OPEN POOL', '{"sizes":["K"]}'),
      ('${M(5)}', 1, 'SOFA', 'SOFA WITH OLD CODE', 'SOFA WITH OLD CODE',
        '{"specials":["Hydraulic"]}'),
      ('${M(6)}', 2, 'BEDFRAME', 'OTHER CO', 'OTHER CO',
        '{"specials":["Hydraulic"]}');
  `);
}

let admin: Sql;
let db: Sql;

function urlFor(name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const plan = async (sql: Sql) => {
  const [toRow] = (await readAddons(sql, CO, ['HYDRAULIC'])) as Array<{ categories: string[] }>;
  return planModels(await readModels(sql, CO, 'Hydraulic'), 'Hydraulic', 'HYDRAULIC', toRow.categories);
};

const pool = async (sql: Sql, id: string) =>
  (await sql`SELECT allowed_options AS o FROM scm.product_models WHERE id = ${id}::uuid`)[0].o;

test('swapInPool keeps FROM\'s place and drops a FROM after an existing TO', () => {
  expect(swapInPool(['A', 'Hydraulic', 'B'], 'Hydraulic', 'HYDRAULIC')).toEqual(['A', 'HYDRAULIC', 'B']);
  expect(swapInPool(['HYDRAULIC', 'A', 'Hydraulic'], 'Hydraulic', 'HYDRAULIC')).toEqual(['HYDRAULIC', 'A']);
});

describePg('HC-0173 — Model pools move off the retired Hydraulic code, on real jsonb', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refusing a non-local TEST_DATABASE_URL');
    admin = postgres(url, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    db = postgres(urlFor(DB), { max: 1, prepare: false });
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.unsafe(FIXTURE);
    await seed(db);
  });

  test('plans the company-1 bedframe pools naming Hydraulic; a sofa pool is named and left alone', async () => {
    const { work, refused } = await plan(db);
    expect(work.map((m: { model_code: string; hadTo: boolean }) => [m.model_code, m.hadTo]))
      .toEqual([['CELENE (A)', false], ['MIXED', true]]);
    expect(refused.map((m: { model_code: string }) => m.model_code)).toEqual(['SOFA WITH OLD CODE']);
  });

  test('the write swaps in place, keeps the rest of allowed_options, and matches the planned list', async () => {
    const { work } = await plan(db);
    const ids = work.map((m: { id: string }) => m.id);
    const written = await db.begin((tx) => writeModels(tx, CO, ids, 'Hydraulic', 'HYDRAULIC'));
    expect(written).toHaveLength(2);

    expect(await pool(db, M(1))).toEqual({ sizes: ['K', 'Q'], specials: ['1 Piece Divan', 'HYDRAULIC', 'Right Drawer'] });
    expect(await pool(db, M(2))).toEqual({ specials: ['HYDRAULIC', 'Left Drawer'] });
    const after = await readPools(db, CO, ids);
    for (const m of work) {
      expect(after.find((r: { id: string }) => r.id === m.id).specials).toEqual(m.next);
    }
    expect((await pool(db, M(3))).specials).toEqual(['1 Piece Divan', 'HYDRAULIC']);
    expect((await pool(db, M(5))).specials).toEqual(['Hydraulic']);
    expect((await pool(db, M(6))).specials).toEqual(['Hydraulic']);
  });

  test('re-run is inert', async () => {
    const { work } = await plan(db);
    await db.begin((tx) => writeModels(tx, CO, work.map((m: { id: string }) => m.id), 'Hydraulic', 'HYDRAULIC'));
    expect((await plan(db)).work).toEqual([]);
  });
});
