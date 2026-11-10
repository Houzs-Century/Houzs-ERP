import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
// @ts-expect-error — plain .mjs helper, no types; the SAME splitter pg-migrate.mjs uses.
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';

/* Backlog A1 — a delivery-return line is never credited for more units than came
 * back. Proves on a real postgres that the migration's trigger:
 *   - lets credit notes take exactly the returned units, across notes;
 *   - gives a CANCELLED note's units back;
 *   - lets exactly one of two concurrent notes take the last unit;
 *   - refuses another company's return line and a line with no qty;
 *   - leaves lines that name no return line alone.
 * SKIPPED without TEST_DATABASE_URL (CI: backend-postgres -> npm run test:pg). */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const DB = 'a1_credit_note_return_cap';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

const FIXTURE = `
  DROP SCHEMA IF EXISTS scm CASCADE;
  CREATE SCHEMA scm;
  CREATE TABLE scm.delivery_returns (id uuid PRIMARY KEY, company_id bigint NOT NULL);
  CREATE TABLE scm.delivery_return_items (
    id uuid PRIMARY KEY, company_id bigint NOT NULL,
    delivery_return_id uuid NOT NULL REFERENCES scm.delivery_returns(id), qty_returned integer NOT NULL
  );
  CREATE TABLE scm.acc_credit_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED'))
  );
  CREATE TABLE scm.acc_credit_note_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id bigint NOT NULL,
    note_id uuid NOT NULL REFERENCES scm.acc_credit_notes(id) ON DELETE CASCADE,
    line_no int NOT NULL DEFAULT 1, account_code text NOT NULL DEFAULT '510-0000',
    amount_sen bigint NOT NULL DEFAULT 100 CHECK (amount_sen > 0)
  );
`;

const DR = '00000000-0000-0000-0000-0000000000d1';
const LINE = '00000000-0000-0000-0000-0000000000e1';
const OTHER_CO_LINE = '00000000-0000-0000-0000-0000000000e2';

let admin: Sql;
let a: Sql;
let b: Sql;

function urlFor(db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? 'unknown'; }
}

async function note(sql: Sql, status = 'DRAFT', company = 1): Promise<string> {
  const [r] = await sql`INSERT INTO scm.acc_credit_notes (company_id, status) VALUES (${company}, ${status}) RETURNING id`;
  return String(r!.id);
}
const credit = (sql: Sql, noteId: string, qty: number | null, item: string | null = LINE, company = 1) =>
  sql`INSERT INTO scm.acc_credit_note_lines (company_id, note_id, delivery_return_item_id, qty) VALUES (${company}, ${noteId}, ${item}, ${qty})`;

describePg('credit note lines are capped at the units returned', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DB}`);
    a = postgres(urlFor(DB), { max: 1, onnotice: () => undefined });
    b = postgres(urlFor(DB), { max: 1, onnotice: () => undefined });
  });
  afterAll(async () => {
    await a?.end(); await b?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });
  beforeEach(async () => {
    await a.unsafe(FIXTURE);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_acc_credit_note_delivery_return.sql'));
    expect(files).toHaveLength(1);
    const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
    await a.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
    await a`INSERT INTO scm.delivery_returns VALUES (${DR}, 1)`;
    await a`INSERT INTO scm.delivery_return_items VALUES (${LINE}, 1, ${DR}, 3), (${OTHER_CO_LINE}, 2, ${DR}, 3)`;
  });

  test('takes exactly the returned units across notes, and refuses the next one', async () => {
    await credit(a, await note(a, 'POSTED'), 2);
    await credit(a, await note(a), 1);
    expect(await codeOf(credit(a, await note(a), 1))).toBe('23514');
  });

  test('a cancelled note gives its units back', async () => {
    const n = await note(a);
    await credit(a, n, 3);
    expect(await codeOf(credit(a, await note(a), 1))).toBe('23514');
    await a`UPDATE scm.acc_credit_notes SET status = 'CANCELLED' WHERE id = ${n}`;
    expect(await codeOf(credit(a, await note(a), 3))).toBeNull();
  });

  test('two lines of one statement are counted together', async () => {
    const n = await note(a);
    const two = a`INSERT INTO scm.acc_credit_note_lines (company_id, note_id, delivery_return_item_id, qty) VALUES (1, ${n}, ${LINE}, 2), (1, ${n}, ${LINE}, 2)`;
    expect(await codeOf(two)).toBe('23514');
  });

  test('an edit that raises a line past the cap is refused', async () => {
    const n = await note(a);
    await credit(a, n, 1);
    expect(await codeOf(a`UPDATE scm.acc_credit_note_lines SET qty = 4 WHERE note_id = ${n}`)).toBe('23514');
    expect(await codeOf(a`UPDATE scm.acc_credit_note_lines SET qty = 3 WHERE note_id = ${n}`)).toBeNull();
  });

  test('exactly one of two concurrent notes takes the last unit', async () => {
    await credit(a, await note(a), 2);
    const na = await note(a);
    const nb = await note(a);
    const results = await Promise.all([
      codeOf(a.begin(async (tx) => { await credit(tx as unknown as Sql, na, 1); await tx`SELECT pg_sleep(0.2)`; })),
      codeOf(b.begin(async (tx) => { await tx`SELECT pg_sleep(0.05)`; await credit(tx as unknown as Sql, nb, 1); })),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.filter((r) => r === '23514')).toHaveLength(1);
  });

  test("refuses another company's return line and a line with no qty", async () => {
    expect(await codeOf(credit(a, await note(a), 1, OTHER_CO_LINE, 1))).toBe('23503');
    expect(await codeOf(credit(a, await note(a), null))).toBe('23502');
  });

  test('a line naming no return line is untouched', async () => {
    expect(await codeOf(credit(a, await note(a), null, null))).toBeNull();
  });
});
