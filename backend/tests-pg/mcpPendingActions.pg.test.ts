import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { splitSqlStatements } from '../scripts/lib/split-sql.mjs';
import { d1Compat } from '../src/db/d1-compat';
import { actionsEnabled, claimPendingAction, confirmedLastDay, createPendingAction, finishPendingAction, setActionsEnabled } from '../src/services/mcp-store';
import type { Env } from '../src/types';
import { assertDisposableTestDatabase } from './lib/doc-no-fixture';

/* The AI Connector's confirm-first actions on real Postgres: the migration, the
 * "Allow AI actions" switch (default OFF) and the pending-action lifecycle —
 * single use, same token and person only, dead after expiry, and two confirms
 * racing on two connections get ONE claim. SKIPPED without TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;
const SCHEMA = 'mcp_pending_actions_pg';
const migrationsDir = fileURLToPath(new URL('../src/db/migrations-pg/', import.meta.url));

/* Located by suffix (renumbered at merge); public.* pointed at the throwaway schema. */
async function applyMigration(sql: Sql): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('_mcp_pending_actions.sql'));
  if (files.length !== 1) throw new Error(`expected one *_mcp_pending_actions.sql, found ${files.join(', ')}`);
  const body = (await readFile(join(migrationsDir, files[0]!), 'utf8')).replace(/public\./g, `${SCHEMA}.`);
  const stmts = splitSqlStatements(body) as string[];
  await sql.begin(async (tx) => { for (const s of stmts) await tx.unsafe(s); });
}

let admin: Sql;
const clients: Sql[] = [];
function db(): Env['DB'] {
  const c = postgres(url, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: SCHEMA } });
  clients.push(c);
  return d1Compat(() => c) as unknown as Env['DB'];
}

describePg('AI Connector pending actions on Postgres', () => {
  beforeAll(async () => {
    assertDisposableTestDatabase(url);
    admin = postgres(url, { max: 1, onnotice: () => {}, connection: { search_path: SCHEMA } });
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await applyMigration(admin);
    await admin.unsafe(`CREATE TABLE app_settings (key text PRIMARY KEY, value text NOT NULL, updated_at text)`);
  });

  afterAll(async () => {
    if (admin) await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await Promise.all([admin, ...clients].filter(Boolean).map((c) => c.end()));
  });

  beforeEach(async () => {
    await admin.unsafe(`DELETE FROM mcp_pending_actions`);
    await admin.unsafe(`DELETE FROM app_settings`);
  });

  test('the migration applies a second time cleanly', async () => {
    await expect(applyMigration(admin)).resolves.toBeUndefined();
  });

  test('the switch is OFF until an admin turns it on, and turns off again', async () => {
    const d = db();
    expect(await actionsEnabled(d)).toBe(false);
    await setActionsEnabled(d, true);
    expect(await actionsEnabled(d)).toBe(true);
    await setActionsEnabled(d, false);
    expect(await actionsEnabled(d)).toBe(false);
  });

  test('a pending action is claimed once, only by its own token and person', async () => {
    const d = db();
    const id = await createPendingAction(d, { tokenId: 'tok_a', userId: 7, kind: 'email', payload: { company: null, body: { subject: 'Hi' } }, summary: 'email to x', ttlMs: 600_000 });
    expect(await claimPendingAction(d, id, 'tok_b', 7, 'confirmed')).toBeNull();
    expect(await claimPendingAction(d, id, 'tok_a', 8, 'confirmed')).toBeNull();
    const got = await claimPendingAction(d, id, 'tok_a', 7, 'confirmed');
    expect(got).toEqual({ id, kind: 'email', payload: { company: null, body: { subject: 'Hi' } }, summary: 'email to x' });
    expect(await claimPendingAction(d, id, 'tok_a', 7, 'confirmed')).toBeNull();
    await finishPendingAction(d, id, 'done', 'HTTP 201');
    expect(await confirmedLastDay(d, 7)).toBe(1);
  });

  test('an expired action cannot be claimed, and a cancel does not count toward the daily cap', async () => {
    const d = db();
    const old = await createPendingAction(d, { tokenId: 'tok_a', userId: 9, kind: 'meeting', payload: {}, summary: 'm', ttlMs: -1000 });
    expect(await claimPendingAction(d, old, 'tok_a', 9, 'confirmed')).toBeNull();
    const id = await createPendingAction(d, { tokenId: 'tok_a', userId: 9, kind: 'meeting', payload: {}, summary: 'm', ttlMs: 600_000 });
    expect(await claimPendingAction(d, id, 'tok_a', 9, 'cancelled')).not.toBeNull();
    expect(await confirmedLastDay(d, 9)).toBe(0);
  });

  test('two confirms racing on two connections: exactly one wins', async () => {
    const id = await createPendingAction(db(), { tokenId: 'tok_a', userId: 7, kind: 'email', payload: {}, summary: 's', ttlMs: 600_000 });
    const [a, b] = await Promise.all([claimPendingAction(db(), id, 'tok_a', 7, 'confirmed'), claimPendingAction(db(), id, 'tok_a', 7, 'confirmed')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
