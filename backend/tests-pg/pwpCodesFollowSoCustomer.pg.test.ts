import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/* mig *_scm_pwp_codes_follow_so_customer against real Postgres: changing an
 * SO's customer_id re-points its AVAILABLE codes (same company) and leaves
 * REDEEMED codes, other SOs' codes and other companies alone.
 * SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

let sql: Sql;

const A = '00000000-0000-0000-0000-00000000000a';
const B = '00000000-0000-0000-0000-00000000000b';
const C = '00000000-0000-0000-0000-00000000000c';

describePg('pwp codes follow the SO customer', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('refuse non-local TEST_DATABASE_URL');
    if (parsed.pathname !== '/houzs_test') throw new Error('PG integration tests require the disposable houzs_test database');
    sql = postgres(url, { max: 1, onnotice: () => {} });
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_scm_pwp_codes_follow_so_customer.sql'));
    if (files.length !== 1) throw new Error(`expected one migration, found ${files.join(', ')}`);
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS scm;
      DROP TABLE IF EXISTS scm.pwp_codes, scm.mfg_sales_orders CASCADE;
      CREATE TABLE scm.mfg_sales_orders (doc_no text PRIMARY KEY, company_id bigint NOT NULL, customer_id uuid);
      CREATE TABLE scm.pwp_codes (code text PRIMARY KEY, company_id bigint NOT NULL, source_doc_no text,
        customer_id uuid, status text NOT NULL, updated_at timestamptz);
    `);
    await sql.unsafe(await readFile(join(migrationsDir, files[0]!), 'utf8'));
  });
  afterAll(async () => { await sql?.end(); });

  test('customer change moves AVAILABLE codes; REDEEMED, third-customer, other SO, other company stay', async () => {
    await sql.unsafe(`
      INSERT INTO scm.mfg_sales_orders VALUES ('SO-1', 1, '${A}'), ('SO-2', 1, '${A}');
      INSERT INTO scm.pwp_codes (code, company_id, source_doc_no, customer_id, status) VALUES
        ('AVAIL', 1, 'SO-1', '${A}', 'AVAILABLE'),
        ('USED', 1, 'SO-1', '${A}', 'REDEEMED'),
        ('THIRD', 1, 'SO-1', '${C}', 'AVAILABLE'),
        ('OTHERSO', 1, 'SO-2', '${A}', 'AVAILABLE'),
        ('OTHERCO', 2, 'SO-1', '${A}', 'AVAILABLE');
      UPDATE scm.mfg_sales_orders SET customer_id = '${B}' WHERE doc_no = 'SO-1';
    `);
    const rows = await sql<{ code: string; customer_id: string }[]>`SELECT code, customer_id FROM scm.pwp_codes`;
    expect(Object.fromEntries(rows.map((r) => [r.code, r.customer_id])))
      .toEqual({ AVAIL: B, USED: A, THIRD: C, OTHERSO: A, OTHERCO: A });
  });
});
