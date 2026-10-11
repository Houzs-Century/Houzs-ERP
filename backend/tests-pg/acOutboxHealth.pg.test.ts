import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

/* Real PostgreSQL proof for migration 0280 and for check-ac-outbox-health.mjs.
   Hard rule 4 says a lost sync must be impossible to MISS; the health check is
   how anyone asks, from outside, whether that is true. A diagnostic nobody has
   ever executed is a diagnostic nobody should trust — and the specific failure
   this repo keeps being bitten by is a query naming a column that does not
   exist, which PostgREST and postgres.js both answer with a hard error rather
   than a degraded result (that is exactly how D11 and D13 were found).

   So this suite applies the REAL migrations to the postgres:16 service
   container in CI and runs the REAL script as a subprocess against it. Every
   SELECT in the script is executed. A phantom column cannot survive it.

   Skipped, not failed, without TEST_DATABASE_URL: locally there is no PG. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
const scriptPath = fileURLToPath(new URL('../scripts/check-ac-outbox-health.mjs', import.meta.url));

// By SUFFIX, never by number — these files get renumbered whenever a parallel
// PR takes the slot, and a number-pinned read would silently resolve to nothing.
async function migrationBySuffix(suffix: string): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(suffix));
  if (files.length !== 1) {
    throw new Error(`expected exactly one *${suffix} migration, found ${files.length}: ${files.join(', ')}`);
  }
  return readFile(join(migrationsDir, files[0]), 'utf8');
}

let admin: Sql;

/* The tables 0277 and 0280 attach to, cut down to the columns they touch. The
   six document tables exist because 0277 ALTERs all of them, and the health
   check's orphan section reads created_at + the document number off each. */
async function resetFixture(sql: Sql): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
  }
  if (parsed.pathname !== '/houzs_test') {
    throw new Error('PG integration tests refuse any database other than houzs_test');
  }
  await sql.unsafe(`
    DROP SCHEMA IF EXISTS scm CASCADE;
    CREATE SCHEMA scm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE scm.app_config (
      key text PRIMARY KEY, value text, description text);
    CREATE TABLE scm.mfg_sales_orders (
      doc_no text PRIMARY KEY, status text, so_date date, debtor_name text,
      linked_ac_docno text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.purchase_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), po_number text, status text,
      po_date date, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.delivery_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.grns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.sales_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE scm.purchase_invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), doc_no text, status text,
      created_at timestamptz NOT NULL DEFAULT now());
  `);
  // The real migrations, in order. 0280 stacks on 0277 and drops two of its
  // indexes by name, so applying both is also a proof that those names match.
  await sql.unsafe(await migrationBySuffix('_scm_autocount_outbox.sql'));
  await sql.unsafe(await migrationBySuffix('_scm_autocount_outbox_alarm.sql'));
}

/**
 * Run the real script against the test database and return its stdout.
 *
 * child_process is imported LAZILY on purpose. `npm test` collects this file
 * under the Cloudflare workers pool, where a module-scope `node:child_process`
 * import fails the whole file at load time — before describe.skip can spare it.
 * Inside the helper it is only ever reached on the PG runner.
 */
async function health(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [scriptPath], {
    env: { ...process.env, DATABASE_URL: url, TOP: '10' },
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

describePg('migration 0280 + check-ac-outbox-health against real PostgreSQL', () => {
  beforeAll(async () => {
    admin = postgres(url, { ssl: false, prepare: false, max: 1, onnotice: () => {} });
  });
  afterAll(async () => { await admin?.end({ timeout: 5 }); });
  beforeEach(async () => { await resetFixture(admin); });

  test('0280 adds the three columns the durable queue needs', async () => {
    const cols = await admin`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'scm' AND table_name = 'autocount_outbox'
         AND column_name IN ('next_attempt_at', 'first_waiting_at', 'alerted_at')
       ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(
      ['alerted_at', 'first_waiting_at', 'next_attempt_at'],
    );
    // next_attempt_at must default to now() so every PRE-EXISTING row stays
    // immediately eligible. A NULL default would strand the whole backlog the
    // moment the migration ran — the exact opposite of what it is for.
    const notNull = cols.find((c) => c.column_name === 'next_attempt_at');
    expect(notNull?.is_nullable).toBe('NO');
  });

  test('the dedupe index is scoped to the COMPANY, so two companies minting the same document number do not collapse', async () => {
    await admin`
      INSERT INTO scm.autocount_outbox (company_id, op, doc_type, doc_no, payload, dedupe_key)
      VALUES (1, 'create_so', 'SO', 'SO-2608-001', '{}'::jsonb, 'create_so:SO-2608-001')`;
    /* 0277's index was UNIQUE on dedupe_key ALONE. Houzs and 2990 both run an
       SO-YYMM-NNN series, so this second insert used to violate it, enqueueAcOp
       caught the 23505 as a benign "already queued", and ONE company's document
       was never sent — with nothing anywhere reporting it. */
    await expect(admin`
      INSERT INTO scm.autocount_outbox (company_id, op, doc_type, doc_no, payload, dedupe_key)
      VALUES (2, 'create_so', 'SO', 'SO-2608-001', '{}'::jsonb, 'create_so:SO-2608-001')`,
    ).resolves.toBeDefined();

    // Same company, same intent, still collapses — that is the mechanism working.
    await expect(admin`
      INSERT INTO scm.autocount_outbox (company_id, op, doc_type, doc_no, payload, dedupe_key)
      VALUES (1, 'create_so', 'SO', 'SO-2608-001', '{}'::jsonb, 'create_so:SO-2608-001')`,
    ).rejects.toThrow(/duplicate key/i);
  });

  test('every query in the health check executes against the real schema', async () => {
    const stdout = await health();
    // A phantom column anywhere would have thrown 42703 and exited 1 instead.
    for (const section of [
      'SECTION 0 — CONFIGURATION',
      'SECTION 1 — QUEUE BY STATUS',
      'SECTION 2 — SKIPPED ROWS',
      'SECTION 3 — OLDEST UNDELIVERED',
      'SECTION 4 — ALARM COVERAGE',
      'SECTION 5 — DOCUMENTS LINKED TO AUTOCOUNT',
      'SECTION 6 — ORPHANS',
      'VERDICT:',
    ]) expect(stdout).toContain(section);
    // 0277 seeds the flag OFF, and that must be reported, not assumed.
    expect(stdout).toContain('OFF');
  });

  test('an empty queue does not accuse anything of being an orphan', async () => {
    await admin`
      INSERT INTO scm.mfg_sales_orders (doc_no, status, created_at)
      VALUES ('HC-SO-OLD', 'CONFIRMED', now() - interval '30 days')`;
    const stdout = await health();
    /* Every ERP document predates the write-back while the outbox is empty.
       Calling 13,000 of them orphans would be a WRONG answer, and a wrong
       answer is worse than a blank. */
    expect(stdout).toContain('SKIPPED — the outbox has never held a row');
    expect(stdout).toContain('VERDICT: OK');
  });

  test('a document committed with NO outbox row is reported as an orphan', async () => {
    // A row exists, so the queue has a lifetime and orphans become measurable.
    await admin`
      INSERT INTO scm.autocount_outbox (company_id, op, doc_type, doc_no, payload, created_at)
      VALUES (1, 'create_so', 'SO', 'HC-SO-1', '{}'::jsonb, now() - interval '1 hour')`;
    await admin`
      INSERT INTO scm.mfg_sales_orders (doc_no, status, created_at)
      VALUES ('HC-SO-1', 'CONFIRMED', now() - interval '1 hour')`;
    /* The dual write's blind spot: committed, but the enqueue was lost. There
       is no outbox row, so no status, no error and no alarm describes it —
       section 6 is the only place it is visible at all. */
    await admin`
      INSERT INTO scm.mfg_sales_orders (doc_no, status, created_at)
      VALUES ('HC-SO-LOST', 'CONFIRMED', now() - interval '30 minutes')`;

    const stdout = await health();
    expect(stdout).toContain('1 orphan(s)');
    expect(stdout).toContain('HC-SO-LOST');
    expect(stdout).toContain('VERDICT: ALARM');
    expect(stdout).toContain('ORPHAN document(s)');
    // The one that DID get a row must not be accused.
    expect(stdout).not.toContain('e.g. HC-SO-1 ');
  });

  test('a failed row raises ALARM and a skipped row is read back with its reason', async () => {
    await admin`
      INSERT INTO scm.autocount_outbox
        (company_id, op, doc_type, doc_no, payload, status, attempts, last_error, alerted_at)
      VALUES (1, 'create_so', 'SO', 'HC-SO-9', '{}'::jsonb, 'failed', 8,
              'Gave up after 8 attempts. Last error: tunnel down', now())`;
    await admin`
      INSERT INTO scm.autocount_outbox
        (company_id, op, doc_type, doc_no, payload, status, last_error)
      VALUES (1, 'so_to_do', 'DO', 'HC-DO-3', '{}'::jsonb, 'skipped',
              'merged from several sales orders: AutoCount has no shape for that')`;

    const stdout = await health();
    expect(stdout).toContain('VERDICT: ALARM');
    expect(stdout).toContain('1 FAILED row(s)');
    expect(stdout).toContain('merged from several sales orders');
    expect(stdout).toContain('HC-SO-9');
  });

  test('an undeliverable row that nobody was told about is itself reported', async () => {
    await admin`UPDATE scm.app_config SET value = 'all' WHERE key = 'scm.autocount_writeback'`;
    await admin`
      INSERT INTO scm.autocount_outbox
        (company_id, op, doc_type, doc_no, payload, status, attempts, alerted_at)
      VALUES (1, 'create_so', 'SO', 'HC-SO-Q', '{}'::jsonb, 'failed', 8, NULL)`;

    const stdout = await health();
    /* alerted_at IS NULL on a failed row means the alarm pass never ran. That
       is the alarm ITSELF failing, which no other section can see. */
    expect(stdout).toContain('the alarm pass is not running');
    expect(stdout).toContain('VERDICT: ALARM');
  });

  test('a stalled waiting row is counted as undeliverable even though it never failed', async () => {
    await admin`UPDATE scm.app_config SET value = 'all' WHERE key = 'scm.autocount_writeback'`;
    await admin`
      INSERT INTO scm.autocount_outbox
        (company_id, op, doc_type, doc_no, payload, status, attempts, first_waiting_at, alerted_at)
      VALUES (1, 'so_to_do', 'DO', 'HC-DO-7', '{}'::jsonb, 'pending', 0,
              now() - interval '3 days', NULL)`;

    const stdout = await health();
    /* A waiting row burns no attempt, so it never becomes 'failed' and every
       status-based count reads it as healthy pending work. Only its AGE
       distinguishes "waiting 40 seconds" from "waiting three days". */
    expect(stdout).toContain('of which WAITING on a parent ... 1');
    expect(stdout).toContain('stalled > 6h waiting .......... 1');
    expect(stdout).toContain('VERDICT: ALARM');
  });
});
