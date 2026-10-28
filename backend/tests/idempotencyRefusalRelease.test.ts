/* What a claim COLLISION means, exercised end to end: real Hono, the real
   middleware, the real route helper. Only the database is a stand-in, and it
   throws on any statement it does not recognise so a middleware query that
   changes shape cannot quietly stop being tested.
 *
 * Three properties are pinned here, and they were bought in this order:
 *
 * 1. A RETRY AFTER A SUCCESSFUL WRITE STILL REPLAYS. Everything else in this
 *    file is only allowed to exist because this stays true.
 *
 * 2. `idempotency_key_reused` DOES NOT MEAN "NOTHING WAS WRITTEN". The
 *    middleware answers it on a hash mismatch, so it is also what a caller gets
 *    after a COMMITTED 201 — `completed_status` says so. A first attempt at
 *    this bug had the CLIENT rotate its key on that code and tell the operator
 *    "nothing was saved, press Save again", which turns a retype into a second
 *    document, a second stock IN and a second AutoCount enqueue.
 *
 * 3. A CHANGED PAYLOAD WHILE THE FIRST REQUEST IS STILL RUNNING is
 *    `idempotency_in_flight`, not `key_reused`. Until 2026-08-18 the hash was
 *    checked before the status, so in_flight was reachable only for an
 *    IDENTICAL payload — the one case that was already safe — and no caller
 *    could tell "still running" from "already finished".
 *
 * And the release path itself: the `Idempotency-Outcome: no-write` header a
 * route sets through refuseWithoutWriting has to survive Hono's c.json() into
 * the Response the middleware reads off `c.res`. That step is the whole fix and
 * nothing asserted it before. */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { idempotency } from '../src/middleware/idempotency';
import { refuseWithoutWriting } from '../src/scm/lib/no-write-refusal';
import { refuseZeroCostReceipt } from '../src/scm/lib/zero-cost-receipt-guard';
import type { Env } from '../src/types';

type ClaimRow = {
  key: string;
  scope: string;
  user_id: number;
  tenant_scope: string;
  request_hash: string;
  status_code: number | null;
  response_body: string | null;
};

/* Faithful to the five statements middleware/idempotency.ts actually issues,
   and hostile to every other one: a silent no-op on an unrecognised query is
   how a suite reports a pass over nothing. */
function claimStore() {
  const rows: ClaimRow[] = [];
  const owner = (userId: number, tenant: string, key: string, scope: string) =>
    rows.find(
      (r) => r.user_id === userId && r.tenant_scope === tenant && r.key === key && r.scope === scope,
    );
  const binding = {
    prepare(sql: string) {
      const norm = sql.replace(/\s+/g, ' ').trim();
      return {
        bind(...args: unknown[]) {
          const reject = () => new Error(`claimStore has no handler for: ${norm}`);
          return {
            async first() {
              if (norm.startsWith('SELECT status_code, response_body, request_hash FROM idempotency_keys')) {
                const [userId, tenant, key, scope] = args as [number, string, string, string];
                const row = owner(userId, tenant, key, scope);
                return row
                  ? {
                      status_code: row.status_code,
                      response_body: row.response_body,
                      request_hash: row.request_hash,
                    }
                  : null;
              }
              throw reject();
            },
            async run() {
              if (norm.startsWith('INSERT INTO app_settings')) return { success: true };
              if (norm.startsWith('INSERT INTO idempotency_keys')) {
                const [key, scope, userId, tenant, hash] = args as [string, string, number, string, string];
                if (rows.some((r) => r.key === key && r.scope === scope)) {
                  const clash = new Error('duplicate key value violates unique constraint');
                  (clash as Error & { code?: string }).code = '23505';
                  throw clash;
                }
                rows.push({
                  key,
                  scope,
                  user_id: userId,
                  tenant_scope: tenant,
                  request_hash: hash,
                  status_code: null,
                  response_body: null,
                });
                return { success: true };
              }
              if (norm.startsWith('DELETE FROM idempotency_keys')) {
                const [userId, tenant, key, scope, hash] = args as [number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) rows.splice(rows.indexOf(row), 1);
                return { success: true };
              }
              if (norm.startsWith('UPDATE idempotency_keys')) {
                const [status, body, userId, tenant, key, scope, hash] = args as
                  [number, string, number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) {
                  row.status_code = status;
                  row.response_body = body;
                }
                return { success: true };
              }
              throw reject();
            },
          };
        },
      };
    },
  };
  return { rows, env: { DB: binding } as unknown as Env };
}

function appWith(handler: Parameters<Hono['post']>[1]) {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', async (c, next) => {
    c.set('userId', 7);
    c.set('companyId', 1);
    await next();
  });
  app.use('*', idempotency);
  app.post('/write', handler);
  return app;
}

const KEY = 'one-mount-one-intent';

function send(app: Hono<{ Bindings: Env }>, env: Env, payload: unknown) {
  return app.request(
    'https://test.local/write',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
      body: JSON.stringify(payload),
    },
    env,
  );
}

describe('an idempotency claim collision', () => {
  it('REPLAYS a committed write for the identical payload instead of running it twice', async () => {
    const store = claimStore();
    let documents = 0;
    const app = appWith((c) => c.json({ grn: ++documents }, 201));

    const first = await send(app, store.env, { qty: 3 });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ grn: 1 });

    const retry = await send(app, store.env, { qty: 3 });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('Idempotent-Replay')).toBe('true');
    expect(await retry.json()).toEqual({ grn: 1 });
    expect(documents).toBe(1);
  });

  it('answers a CHANGED payload after a committed 201 with the status that was committed', async () => {
    const store = claimStore();
    let documents = 0;
    const app = appWith((c) => c.json({ grn: ++documents }, 201));

    expect((await send(app, store.env, { qty: 3 })).status).toBe(201);

    const changed = await send(app, store.env, { qty: 4 });
    expect(changed.status).toBe(409);
    const refusal = (await changed.json()) as { error: string; completed_status: number; message: string };
    expect(refusal).toMatchObject({ error: 'idempotency_key_reused', completed_status: 201 });
    /* The two facts a client MUST NOT be allowed to confuse: the handler did
       not run for THIS request, and a document from the earlier one exists. */
    expect(documents).toBe(1);
    expect(store.rows).toHaveLength(1);
    /* And the wording never invites a resubmit, because a resubmit under a
       fresh key is exactly how the second document gets booked. */
    expect(refusal.message).toMatch(/refresh and check/i);
    expect(refusal.message).not.toMatch(/submit (it )?again\.|press save again/i);
  });

  it('answers a CHANGED payload sent while the first is still running with in_flight', async () => {
    const store = claimStore();
    let releaseHandler: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => { releaseHandler = resolve; });
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });

    const app = appWith(async (c) => {
      signalStarted();
      await finished;
      return c.json({ grn: 1 }, 201);
    });

    const inflight = send(app, store.env, { qty: 3 });
    await started;

    const changed = await send(app, store.env, { qty: 4 });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: 'idempotency_in_flight' });

    releaseHandler();
    expect((await inflight).status).toBe(201);
  });
});

describe('a refusal that proves it wrote nothing', () => {
  it('releases the claim through Hono, so the corrected payload just works', async () => {
    const store = claimStore();
    let documents = 0;
    const app = appWith(async (c) => {
      const body = (await c.req.json()) as { unitPrice?: number };
      if (!body.unitPrice) return refuseWithoutWriting(c, { error: 'zero_cost_receipt' }, 409);
      return c.json({ grn: ++documents }, 201);
    });

    const refused = await send(app, store.env, { qty: 3 });
    expect(refused.status).toBe(409);
    // The load-bearing step: c.header() -> c.json() -> the Response the
    // middleware reads. If this ever stops being true the release is silent.
    expect(refused.headers.get('Idempotency-Outcome')).toBe('no-write');
    expect(store.rows).toEqual([]);

    const corrected = await send(app, store.env, { qty: 3, unitPrice: 4500 });
    expect(corrected.status).toBe(201);
    expect(documents).toBe(1);
  });

  it('keeps the claim when the route answers with a plain c.json refusal', async () => {
    const store = claimStore();
    const app = appWith((c) => c.json({ error: 'qty_exceeds_remaining' }, 409));

    const refused = await send(app, store.env, { qty: 3 });
    expect(refused.status).toBe(409);
    expect(refused.headers.get('Idempotency-Outcome')).toBeNull();
    expect(store.rows).toHaveLength(1);

    const corrected = await send(app, store.env, { qty: 1 });
    expect(corrected.status).toBe(409);
    expect(await corrected.json()).toMatchObject({ error: 'idempotency_key_reused' });
  });

  it('keeps the claim when the zero-cost helper is told a bucket already committed', async () => {
    const store = claimStore();
    const app = appWith((c) =>
      refuseZeroCostReceipt(c, { error: 'zero_cost_receipt' }, { nothingWritten: false }),
    );

    const refused = await send(app, store.env, { qty: 3 });
    expect(refused.status).toBe(409);
    expect(refused.headers.get('Idempotency-Outcome')).toBeNull();
    expect(store.rows).toHaveLength(1);
  });

  it('releases it when the zero-cost helper is told the document was rolled back', async () => {
    const store = claimStore();
    const app = appWith((c) =>
      refuseZeroCostReceipt(c, { error: 'zero_cost_receipt' }, { nothingWritten: true }),
    );

    const refused = await send(app, store.env, { qty: 3 });
    expect(refused.headers.get('Idempotency-Outcome')).toBe('no-write');
    expect(store.rows).toEqual([]);
  });
});
