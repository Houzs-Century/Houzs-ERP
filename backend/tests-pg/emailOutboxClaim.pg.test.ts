import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { d1Compat } from '../src/db/d1-compat';
import { claimOutboxRow, drainEmailOutbox, EMAIL_CLAIM_LEASE_MS } from '../src/services/email';
import type { Env } from '../src/types';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* B14 (issue #5459, sister Conts #185): TWO DRAINS AT ONCE MUST NOT SEND ONE EMAIL TWICE.
 *
 * The D1 suite (tests/emailOutbox.test.ts) runs on SQLite, which serialises
 * every statement, so it cannot show what Postgres does when two Workers claim
 * the same row on two connections. Production is Postgres, so the race is run
 * here: real migration file, real d1-compat adapter, one connection per drain,
 * and a Resend stand-in slow enough that both drains hold the same batch from
 * their SELECT before either finishes sending.
 *
 * Runs against CI's postgres:16 (`npm run test:pg`); SKIPPED without
 * TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const SCHEMA = 'b14_email_outbox_claim';
const ROWS = 20;
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/* Located by suffix: migrations are renumbered at merge, and a number-pinned
   read would find nothing and pass vacuously. */
async function applyClaimMigration(sql: Sql): Promise<number> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_email_outbox_claim.sql'));
  if (files.length !== 1) throw new Error(`expected one *_email_outbox_claim.sql, found ${files.join(', ')}`);
  const stmts = splitSqlStatements(await readFile(join(migrationsDir, files[0]!), 'utf8')) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
  return stmts.length;
}

let admin: Sql;
const clients: Sql[] = [];

function connect(): Sql {
  const c = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: SCHEMA } });
  clients.push(c);
  return c;
}

function envOver(sql: Sql): Env {
  return { DB: d1Compat(() => sql), RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Houzs Test <noreply@test.local>' } as unknown as Env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describePg('email outbox claim on Postgres (B14)', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    admin = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: SCHEMA } });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    const base = splitSqlStatements(await readFile(join(migrationsDir, '0005_email_outbox.sql'), 'utf8')) as string[];
    for (const s of base) await admin.unsafe(s);
    /* The columns later migrations added (0008 sent_at as text, 0094, 0269,
       20261022T0300), in their production types. */
    await admin.unsafe(`ALTER TABLE email_outbox ALTER COLUMN sent_at TYPE text USING sent_at::text`);
    await admin.unsafe(`ALTER TABLE email_outbox
      ADD COLUMN IF NOT EXISTS company_code text, ADD COLUMN IF NOT EXISTS cc_address text,
      ADD COLUMN IF NOT EXISTS bcc_address text, ADD COLUMN IF NOT EXISTS from_address text,
      ADD COLUMN IF NOT EXISTS headers text, ADD COLUMN IF NOT EXISTS attachments text,
      ADD COLUMN IF NOT EXISTS provider_id text`);
    await admin.unsafe(`CREATE TABLE email_log (id serial PRIMARY KEY, purpose text NOT NULL, ref_type text, ref_id integer,
      to_addr text NOT NULL, subject text, status text NOT NULL, provider_id text, error text, created_at timestamptz DEFAULT now())`);
    await admin.unsafe(`CREATE TABLE app_settings (key text PRIMARY KEY, value text NOT NULL)`);
    expect(await applyClaimMigration(admin)).toBeGreaterThan(0);
  });

  afterAll(async () => {
    if (admin) await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await Promise.all([admin, ...clients].filter(Boolean).map((c) => c.end()));
  });

  beforeEach(async () => {
    await admin.unsafe(`DELETE FROM email_outbox`);
    await admin.unsafe(`DELETE FROM email_log`);
  });

  afterEach(() => vi.unstubAllGlobals());

  test('the migration is idempotent (applies a second time cleanly)', async () => {
    await applyClaimMigration(admin);
    const [col] = await admin`SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${SCHEMA} AND table_name = 'email_outbox' AND column_name = 'claimed_at'`;
    expect(col).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });

  test('two drains running at once send every pending email exactly once', async () => {
    for (let i = 0; i < ROWS; i++) {
      await admin`INSERT INTO email_outbox (id, to_address, subject, body_html, purpose, status, attempts)
        VALUES (${`row-${i}`}, ${`c${i}@test.local`}, ${`DO ${i}`}, '<p>x</p>', 'generic', 'pending', 0)`;
    }
    const sentSubjects: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith('https://api.resend.com/emails')) throw new Error(`unexpected fetch ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { subject: string };
      sentSubjects.push(body.subject);
      await sleep(15);
      return new Response(JSON.stringify({ id: `prov-${body.subject}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const [a, b] = await Promise.all([drainEmailOutbox(envOver(connect())), drainEmailOutbox(envOver(connect()))]);

    expect(sentSubjects).toHaveLength(ROWS);
    expect(new Set(sentSubjects).size).toBe(ROWS);
    expect(a.processed + b.processed).toBe(ROWS);
    expect(a.sent + b.sent).toBe(ROWS);
    const rows = await admin`SELECT status, attempts, claimed_at FROM email_outbox`;
    expect(rows).toHaveLength(ROWS);
    for (const r of rows) expect(r).toEqual({ status: 'sent', attempts: 1, claimed_at: null });
  });

  test('ten claimers racing one row on ten connections: exactly one wins', async () => {
    await admin`INSERT INTO email_outbox (id, to_address, subject, purpose, status, attempts)
      VALUES ('race-1', 'r@test.local', 'PO', 'generic', 'pending', 2)`;
    const envs = Array.from({ length: 10 }, () => envOver(connect()));
    const now = Date.now();
    const results = await Promise.all(envs.map((e) => claimOutboxRow(e, 'race-1', now)));
    expect(results.filter(Boolean)).toEqual([{ attempts: 2 }]);
  });

  test('a claim inside the lease is left alone; one past it (a Worker killed mid-send) is taken again', async () => {
    const now = Date.now();
    await admin`INSERT INTO email_outbox (id, to_address, subject, purpose, status, attempts, claimed_at) VALUES
      ('live', 'l@test.local', 'live', 'generic', 'pending', 1, ${new Date(now - 60_000).toISOString()}),
      ('dead', 'd@test.local', 'dead', 'generic', 'pending', 1, ${new Date(now - EMAIL_CLAIM_LEASE_MS - 60_000).toISOString()}),
      ('done', 'x@test.local', 'done', 'generic', 'sent', 1, NULL)`;
    const env = envOver(connect());
    expect(await claimOutboxRow(env, 'live', now)).toBeNull();
    expect(await claimOutboxRow(env, 'dead', now)).toEqual({ attempts: 1 });
    expect(await claimOutboxRow(env, 'done', now)).toBeNull();
  });
});
