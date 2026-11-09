import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* Migration *_acc_receipt_customer_names.sql on real Postgres (owner 2026-11-09, printing
   an official receipt: "Confirmed: Claude, for the owner …" 是什么东西 / 为甚没有name 这些 →
   做, Confirmed 写 Chew). Proves: a nameless receipt takes its order's customer (its own
   company's order, trimmed) or its invoice's; a receipt with a name keeps it; an order
   with none gives none; the catch-up's confirmer becomes Chew and nobody else's changes;
   a second run changes nothing. SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const migration = (): string => {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('_acc_receipt_customer_names.sql'));
  if (files.length !== 1) throw new Error(`expected one *_acc_receipt_customer_names.sql, found ${files.length}`);
  return readFileSync(join(migrationsDir, files[0]!), 'utf8');
};

const CATCH_UP = 'Claude, for the owner (2026-11-09) — matched in Bank recon';
const INVOICE = '9b2f5c1e-7a40-4d1b-9a8e-3c5d2e1f0a11';
let sql: Sql;

describePg('official receipts take their customer names, and the catch-up its confirmer', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    sql = postgres(url, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
    await sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS scm;
      DROP TABLE IF EXISTS scm.acc_official_receipts, scm.mfg_sales_orders, scm.sales_invoices CASCADE;
      CREATE TABLE scm.acc_official_receipts (id bigint PRIMARY KEY, company_id integer NOT NULL, or_number text NOT NULL, status text NOT NULL,
        payment_source text NOT NULL, payment_id text NOT NULL, doc_no text, customer_name text, issued_by text, issued_at timestamptz);
      CREATE TABLE scm.mfg_sales_orders (company_id bigint NOT NULL, doc_no text NOT NULL, debtor_name text);
      CREATE TABLE scm.sales_invoices (id uuid PRIMARY KEY, company_id bigint NOT NULL, debtor_name text);
    `);
    await sql`INSERT INTO scm.mfg_sales_orders (company_id, doc_no, debtor_name) VALUES
      (2, '2990-SO-2608-040', 'Lisa Gan'), (1, '2990-SO-2608-040', 'Someone of another company'),
      (1, 'HC-SO-2609-001', '  Tan Ah Kow  '), (2, '2990-SO-2609-099', '')`;
    await sql`INSERT INTO scm.sales_invoices (id, company_id, debtor_name) VALUES (${INVOICE}, 2, 'Acme Sdn Bhd')`;
    await sql`INSERT INTO scm.acc_official_receipts (id, company_id, or_number, status, payment_source, payment_id, doc_no, customer_name, issued_by, issued_at) VALUES
      (1, 2, '2990-HOR-2611-021', 'FORMAL', 'SOPAY', 'p1', '2990-SO-2608-040', NULL, ${CATCH_UP}, '2026-11-09T09:42:23Z'),
      (2, 1, 'HC-MOR-2609-255', 'FORMAL', 'SOPAY', 'p2', 'HC-SO-2609-001', '', 'Ivy', '2026-10-01T03:00:00Z'),
      (3, 2, '2990-DraftOR-2609-010', 'DRAFT', 'SOPAY', 'p3', '2990-SO-2609-099', NULL, NULL, NULL),
      (4, 2, '2990-DraftOR-2610-002', 'DRAFT', 'SIPAY', 'p4', ${INVOICE}, NULL, NULL, NULL),
      (5, 2, '2990-DraftOR-2610-003', 'CANCELLED', 'SOPAY', 'p5', '2990-SO-2608-040', 'Kept Name', NULL, NULL),
      (6, 2, '2990-DraftOR-2610-004', 'DRAFT', 'SOPAY', 'p6', '2990-SO-NOWHERE', NULL, NULL, NULL)`;
    await sql.unsafe(migration());
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe('DROP TABLE IF EXISTS scm.acc_official_receipts, scm.mfg_sales_orders, scm.sales_invoices CASCADE');
    await sql.end();
  });

  const read = async () => (await sql`SELECT id, customer_name, issued_by FROM scm.acc_official_receipts ORDER BY id`)
    .map((r) => [Number(r.id), r.customer_name, r.issued_by]);

  test('each nameless receipt takes its own company\'s order or its invoice; a kept name stays; the catch-up names Chew', async () => {
    expect(await read()).toEqual([
      [1, 'Lisa Gan', 'Chew'],
      [2, 'Tan Ah Kow', 'Ivy'],
      [3, null, null],
      [4, 'Acme Sdn Bhd', null],
      [5, 'Kept Name', null],
      [6, null, null],
    ]);
  });

  test('a second run changes nothing', async () => {
    const before = await read();
    await sql.unsafe(migration());
    expect(await read()).toEqual(before);
  });
});
