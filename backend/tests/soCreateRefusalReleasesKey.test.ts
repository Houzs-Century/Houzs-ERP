/* A refused Sales Order create can be corrected and saved under the same key.
 *
 * PRODUCTION, 2026-11-02 (phone New Sales Order). Save draft was refused for a
 * date rule; the operator cleared the dates and pressed Save again and got
 * `idempotency_key_reused` — "An earlier submission ... already finished". The
 * form sends ONE Idempotency-Key per mount, the middleware froze the refusal
 * against it, and the only way out was leaving the screen and re-keying the
 * order. createSalesOrderCore now marks every refusal above its first write as
 * no-write, so POST / releases the claim (lib/no-write-refusal.ts has the
 * contract; tests/purchaseInvoiceCreateRefusalDeadEnd.test.ts is the sibling).
 *
 * The REAL router behind the REAL middleware; Postgres and D1 are stand-ins. */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { idempotency } from '../src/middleware/idempotency';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';
import { mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders';
import type { Env } from '../src/types';

type ClaimRow = {
  key: string; scope: string; user_id: number; tenant_scope: string;
  request_hash: string; status_code: number | null; response_body: string | null;
};

/* The five statements middleware/idempotency.ts issues, and nothing else. */
function claimStore() {
  const rows: ClaimRow[] = [];
  const owner = (userId: number, tenant: string, key: string, scope: string) =>
    rows.find((r) => r.user_id === userId && r.tenant_scope === tenant && r.key === key && r.scope === scope);
  const DB = {
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
                return row ? { status_code: row.status_code, response_body: row.response_body, request_hash: row.request_hash } : null;
              }
              throw reject();
            },
            async run() {
              if (norm.startsWith('INSERT INTO app_settings')) return { success: true };
              if (norm.startsWith('INSERT INTO idempotency_keys')) {
                const [key, scope, userId, tenant, hash] = args as [string, string, number, string, string];
                rows.push({ key, scope, user_id: userId, tenant_scope: tenant, request_hash: hash, status_code: null, response_body: null });
                return { success: true };
              }
              if (norm.startsWith('DELETE FROM idempotency_keys')) {
                const [userId, tenant, key, scope, hash] = args as [number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) rows.splice(rows.indexOf(row), 1);
                return { success: true };
              }
              if (norm.startsWith('UPDATE idempotency_keys')) {
                const [status, bodyText, userId, tenant, key, scope, hash] = args as
                  [number, string, number, string, string, string, string];
                const row = owner(userId, tenant, key, scope);
                if (row && row.request_hash === hash) { row.status_code = status; row.response_body = bodyText; }
                return { success: true };
              }
              throw reject();
            },
          };
        },
      };
    },
  };
  return { rows, env: { DB } as unknown as Env };
}

function harness() {
  const tables: Record<string, Row[]> = {
    mfg_sales_orders: [], mfg_sales_order_items: [], mfg_sales_order_payments: [],
    mfg_so_audit_log: [], entity_audit_log: [], mfg_products: [], staff: [],
    companies: [{ id: 1, code: 'HOUZS' }],
  };
  const sb = fakeSb(tables);
  const a = new Hono<{ Bindings: Env }>();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('userId' as never, 9 as never);
    c.set('companyId' as never, 1 as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID, user_metadata: { name: 'Sales A' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Sales A', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.use('*', idempotency);
  a.route('/', mfgSalesOrders as never);
  return { a, tables };
}

/** One screen mount = one key, for every retry of that one Save. */
const KEY = 'one-mount-one-order';
const save = (a: Hono<{ Bindings: Env }>, env: Env, payload: unknown) =>
  a.request('https://test.local/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': KEY },
    body: JSON.stringify(payload),
  }, env);

describe('a refused Sales Order create can be corrected and saved', () => {
  it('the corrected Save under the same key is created, not idempotency_key_reused', async () => {
    const store = claimStore();
    const { a, tables } = harness();
    const draft = { debtorName: 'Ah Meng', phone: '0123456789', asDraft: true, items: [] };

    // A Delivery Date with no Processing Date: refused before anything is written.
    const first = await save(a, store.env, { ...draft, customerDeliveryDate: '2026-12-01' });
    expect(first.status).toBe(400);
    expect(tables.mfg_sales_orders).toHaveLength(0);
    expect(store.rows).toHaveLength(0);

    // The operator clears the date and presses Save again on the same screen.
    const corrected = await save(a, store.env, draft);
    expect(((await corrected.json()) as { error?: string }).error).toBeUndefined();
    expect(corrected.status).toBe(201);
    expect(tables.mfg_sales_orders).toHaveLength(1);
  });
});
