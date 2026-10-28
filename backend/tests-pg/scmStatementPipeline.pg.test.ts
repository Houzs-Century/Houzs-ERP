import net from 'node:net';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { pgTransactionSupabase, settleScmStatements } from '../src/scm/lib/pg-supabase-transaction';

/* HC-0167: an approve-so timed out at 30 s. Each statement of an SCM command
 * used to wait for four answers in a row (SAVEPOINT, describe, execute,
 * RELEASE), about 34 ms each from SIN. The shim now sends the SAVEPOINT with
 * the statement and the RELEASE with the next one. This proves, against real
 * Postgres and the real postgres.js with production's options, that
 *   - the statements still commit together, in order, and read their own writes;
 *   - a failing statement still rolls the whole command back;
 *   - the round trips really are fewer: through a proxy that adds a fixed
 *     delay, ten statements finish well under three round trips each.
 *
 * Runs against CI's postgres:16 service container; SKIPPED without
 * TEST_DATABASE_URL. */

const url = process.env.TEST_DATABASE_URL ?? '';
const describePg = url ? describe : describe.skip;

const HOP_MS = 20; // each direction, so one round trip is 40 ms
const STATEMENTS = 10;

let admin: Sql;
let proxy: net.Server;
let viaProxy: Sql;

/** Forwards bytes both ways, each chunk HOP_MS late. Equal delays keep order. */
function startDelayProxy(target: URL): Promise<net.Server> {
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    const relay = (from: net.Socket, to: net.Socket) =>
      from.on('data', (chunk) => setTimeout(() => { if (!to.destroyed) to.write(chunk); }, HOP_MS));
    relay(client, upstream);
    relay(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); };
    for (const s of [client, upstream]) { s.on('error', close); s.on('close', close); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The options backend/src/db/pg.ts gives production. */
const PROD_OPTIONS = { max: 1, prepare: false, fetch_types: false } as const;

const probeRows = async () =>
  admin`SELECT id, n FROM scm.pipe_probe ORDER BY id` as unknown as Promise<Array<{ id: string; n: number }>>;

describePg('SCM command statements are pipelined, not reordered', () => {
  beforeAll(async () => {
    admin = postgres(url, { max: 1 });
    await admin`CREATE SCHEMA IF NOT EXISTS scm`;
    await admin`DROP TABLE IF EXISTS scm.pipe_probe`;
    await admin`CREATE TABLE scm.pipe_probe (id text PRIMARY KEY, n integer NOT NULL)`;
    proxy = await startDelayProxy(new URL(url));
    const target = new URL(url);
    target.hostname = '127.0.0.1';
    target.port = String((proxy.address() as net.AddressInfo).port);
    viaProxy = postgres(target.toString(), PROD_OPTIONS);
  });

  afterAll(async () => {
    await viaProxy?.end();
    await admin?.unsafe('DROP TABLE IF EXISTS scm.pipe_probe');
    await admin?.end();
    proxy?.close();
  });

  beforeEach(async () => {
    await admin`TRUNCATE scm.pipe_probe`;
  });

  test('statements commit together, in order, and read their own writes', async () => {
    const seen = await viaProxy.begin(async (tx) => {
      const sb = pgTransactionSupabase(tx);
      await sb.from('pipe_probe').insert({ id: 'a', n: 1 });
      await sb.from('pipe_probe').update({ n: 2 }).eq('id', 'a');
      const { data } = await sb.from('pipe_probe').select('n').eq('id', 'a').maybeSingle();
      await sb.from('pipe_probe').insert({ id: 'b', n: 3 });
      await settleScmStatements(tx);
      return data as { n: number } | null;
    });
    expect(seen?.n).toBe(2);
    expect(await probeRows()).toEqual([{ id: 'a', n: 2 }, { id: 'b', n: 3 }]);
  });

  test('a failing statement still rolls the whole command back', async () => {
    await expect(viaProxy.begin(async (tx) => {
      const sb = pgTransactionSupabase(tx);
      await sb.from('pipe_probe').insert({ id: 'a', n: 1 });
      await sb.from('pipe_probe').insert({ id: 'a', n: 9 });
      await settleScmStatements(tx);
    })).rejects.toThrow(/duplicate key/);
    expect(await probeRows()).toEqual([]);
  });

  test(`${STATEMENTS} statements take well under three round trips each`, async () => {
    const roundTrip = HOP_MS * 2;
    const t0 = Date.now();
    await viaProxy.begin(async (tx) => {
      const sb = pgTransactionSupabase(tx);
      for (let i = 0; i < STATEMENTS; i++) await sb.from('pipe_probe').insert({ id: `r${i}`, n: i });
      await settleScmStatements(tx);
    });
    const elapsed = Date.now() - t0;
    expect((await probeRows()).length).toBe(STATEMENTS);
    /* Awaited one by one it was 4 per statement (+ BEGIN, COMMIT): 42 x 40 ms.
       Pipelined it is 2 per statement: about 22 x 40 ms. */
    expect(elapsed).toBeLessThan((STATEMENTS * 3 + 2) * roundTrip);
  });
});
