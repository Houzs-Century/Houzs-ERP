import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  FIELD_PIN_DELETE_SQL,
  FIELD_PIN_FAIL_SQL,
  FIELD_PIN_MAX_FAILURES,
  FIELD_PIN_RESET_SQL,
  FIELD_PIN_UPSERT_SQL,
  FIELD_SESSIONS_DELETE_SQL,
} from '../src/services/fieldPin';

/* *_field_pins.sql and the exact statements the crew PIN routes run, on real
 * Postgres (CI's postgres:16 service, `npm run test:pg`). A stubbed client
 * cannot prove the lock arithmetic, the interval, or the ON CONFLICT path.
 * SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const SCHEMA = 'field_pin_test';
let sql: Sql;

const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));
async function migration(): Promise<string> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_field_pins.sql'));
  if (files.length !== 1) throw new Error(`expected one *_field_pins.sql, found ${files.length}`);
  return (await readFile(join(migrationsDir, files[0]!), 'utf8')).replaceAll('public.', `${SCHEMA}.`);
}

/* The routes bind with `?` (D1-compatible); postgres.js wants $n. */
const pg = (q: string) => {
  let n = 0;
  return q.replace(/\?/g, () => `$${++n}`);
};
const run = (q: string, ...args: unknown[]) => sql.unsafe(pg(q), args as never[]);

describePg('field_pins (real postgres)', () => {
  beforeAll(async () => {
    const parsed = new URL(url);
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('PG integration tests refuse any non-local TEST_DATABASE_URL');
    }
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.users (id serial PRIMARY KEY);
      CREATE TABLE ${SCHEMA}.sessions (token text PRIMARY KEY, user_id integer, origin text);
      SET search_path TO ${SCHEMA};
      INSERT INTO users (id) VALUES (42), (43);
    `);
    const m = await migration();
    await sql.unsafe(m);
    await sql.unsafe(m); // a re-run of the deploy step changes nothing
  });

  afterAll(async () => {
    await sql?.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql?.end();
  });

  test('a new PIN starts unlocked with no failures', async () => {
    await run(FIELD_PIN_UPSERT_SQL, 42, 'salt$hash', 1);
    const [r] = await sql`SELECT pin_hash, failed_count, locked_until, set_by FROM field_pins WHERE user_id = 42`;
    expect(r).toEqual({ pin_hash: 'salt$hash', failed_count: 0, locked_until: null, set_by: 1 });
  });

  test(`locks on the ${FIELD_PIN_MAX_FAILURES}th wrong PIN, about 15 minutes ahead`, async () => {
    for (let i = 1; i < FIELD_PIN_MAX_FAILURES; i++) {
      const [r] = await run(FIELD_PIN_FAIL_SQL, 42);
      expect(r).toMatchObject({ failed_count: i, locked_until: null });
    }
    const [locked] = await run(FIELD_PIN_FAIL_SQL, 42);
    expect(locked!.failed_count).toBe(FIELD_PIN_MAX_FAILURES);
    const ahead = new Date(locked!.locked_until as string).getTime() - Date.now();
    expect(ahead).toBeGreaterThan(14 * 60_000);
    expect(ahead).toBeLessThan(16 * 60_000);
  });

  test('a lock that has run out starts a fresh count instead of re-locking at once', async () => {
    await sql`UPDATE field_pins SET locked_until = now() - interval '1 minute' WHERE user_id = 42`;
    const [r] = await run(FIELD_PIN_FAIL_SQL, 42);
    expect(r).toMatchObject({ failed_count: 1, locked_until: null });
  });

  test('a correct PIN clears the count; a new PIN lifts a live lock', async () => {
    await run(FIELD_PIN_RESET_SQL, 42);
    expect((await sql`SELECT failed_count FROM field_pins WHERE user_id = 42`)[0]!.failed_count).toBe(0);
    await sql`UPDATE field_pins SET failed_count = 5, locked_until = now() + interval '10 minutes' WHERE user_id = 42`;
    await run(FIELD_PIN_UPSERT_SQL, 42, 'salt$hash2', 2);
    const [r] = await sql`SELECT pin_hash, failed_count, locked_until, set_by FROM field_pins WHERE user_id = 42`;
    expect(r).toEqual({ pin_hash: 'salt$hash2', failed_count: 0, locked_until: null, set_by: 2 });
  });

  test('ending PIN sessions leaves password sessions alone', async () => {
    await sql`INSERT INTO sessions (token, user_id, origin) VALUES ('a', 42, 'field'), ('b', 42, NULL), ('c', 43, 'field')`;
    await run(FIELD_SESSIONS_DELETE_SQL, 42);
    const left = await sql`SELECT token FROM sessions ORDER BY token`;
    expect(left.map((r) => r.token)).toEqual(['b', 'c']);
  });

  test('removing a PIN and deleting the member both drop the row', async () => {
    await run(FIELD_PIN_DELETE_SQL, 42);
    expect(await sql`SELECT 1 FROM field_pins WHERE user_id = 42`).toHaveLength(0);
    await run(FIELD_PIN_UPSERT_SQL, 43, 'salt$x', 1);
    await sql`DELETE FROM users WHERE id = 43`;
    expect(await sql`SELECT 1 FROM field_pins WHERE user_id = 43`).toHaveLength(0);
  });
});
