import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* END-TO-END PROOF that mig *_scm_document_cancel_requests_do lets the
 * cancellation ledger hold a DELIVERY ORDER row, against real Postgres.
 *
 * Owner 2026-09-14: 「DO cancel need pop out window for reason」. The guard in
 * front of PATCH /delivery-orders-mfg/:id/status writes an EXECUTED row with
 * doc_type 'DO' after a cancel runs. The table was created (mig
 * 20260908T1400) with an INLINE, unnamed `CHECK (doc_type IN ('SO','PO'))`, so
 * the migration has to drop Postgres's generated name for it. A name that did
 * not match would make the DROP a silent no-op, the ADD a SECOND check, and the
 * old one would go on refusing 'DO' — which is exactly what these tests would
 * catch and a fake PostgREST client never could.
 *
 * The table is built by the REAL create migration, not a hand copy, so the
 * constraint name under test is the one Postgres itself generates.
 *
 * Runs against CI's postgres:16 service container (`backend-postgres` ->
 * `npm run test:pg`); SKIPPED, not failed, without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

// By SUFFIX, never by name — a renamed migration must fail loudly, not pass vacuously.
async function migrationSql(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]!), 'utf8');
}

/** Apply a file the way scripts/pg-migrate.mjs does: split, one transaction. */
async function apply(sql: Sql, text: string): Promise<void> {
  const stmts = splitSqlStatements(text) as string[];
  await sql.begin(async (tx) => {
    for (const s of stmts) await tx.unsafe(s);
  });
}

let admin: Sql;

const insert = (sql: Sql, docType: string) => sql`
  INSERT INTO scm.document_cancel_requests
    (company_id, doc_type, doc_key, doc_number, status, reason, requested_by)
  VALUES (1, ${docType}, ${`${docType}-key`}, ${`${docType}-1`}, 'EXECUTED', 'Customer postponed the delivery', 11)`;

const docTypeChecks = (sql: Sql) => sql<{ conname: string; def: string }[]>`
  SELECT c.conname, pg_get_constraintdef(c.oid) AS def
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'scm' AND t.relname = 'document_cancel_requests'
    AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%doc_type%'`;

describePg('scm.document_cancel_requests accepts a delivery order (real Postgres)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    if (parsed.pathname !== '/houzs_test') {
      throw new Error('PG integration tests require the disposable houzs_test database');
    }
    admin = postgres(url, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await admin?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await admin.unsafe('CREATE SCHEMA IF NOT EXISTS scm');
    await admin.unsafe('DROP TABLE IF EXISTS scm.document_cancel_requests CASCADE');
    await apply(admin, await migrationSql('_scm_document_cancel_requests.sql'));
  });

  test('before the migration a DO row is refused — the state production is in', async () => {
    await expect(insert(admin, 'PO')).resolves.toBeDefined();
    await expect(insert(admin, 'DO')).rejects.toThrow(/document_cancel_requests_doc_type_check/);
  });

  test('after it a DO row is accepted, SO and PO still are, and anything else is not', async () => {
    await apply(admin, await migrationSql('_scm_document_cancel_requests_do.sql'));
    await expect(insert(admin, 'SO')).resolves.toBeDefined();
    await expect(insert(admin, 'PO')).resolves.toBeDefined();
    await expect(insert(admin, 'DO')).resolves.toBeDefined();
    await expect(insert(admin, 'XX')).rejects.toThrow(/document_cancel_requests_doc_type_check/);
    const checks = await docTypeChecks(admin);
    expect(checks.map((c) => c.conname)).toEqual(['document_cancel_requests_doc_type_check']);
  });

  test('it keeps the rows already there and can be run twice', async () => {
    await insert(admin, 'PO');
    const text = await migrationSql('_scm_document_cancel_requests_do.sql');
    await apply(admin, text);
    await apply(admin, text);
    const [{ n }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM scm.document_cancel_requests WHERE doc_type = 'PO'`;
    expect(n).toBe(1);
    expect(await docTypeChecks(admin)).toHaveLength(1);
  });
});
