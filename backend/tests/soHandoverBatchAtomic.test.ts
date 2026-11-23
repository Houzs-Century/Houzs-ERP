/* A SALES ORDER HANDOVER BATCH MOVES WHOLE OR NOT AT ALL.
 *
 * POST /so-handover/apply looped over the orders with one update each and no transaction, so a write that failed on
 * the third order left the first two moved (with their audit rows and AutoCount queue entries) and the rest not. It
 * now runs in runScmPgCommand: a failed write answers 500 and rolls every order back, and the AutoCount queue entries
 * are queued only after the commit. Ported from Conts ERP #1137 (D17).
 */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { fakeSb } from '../src/scm/lib/fake-postgrest';
import { fakeDeferScmAfterCommit, fakeRunScmPgCommand } from './lib/fake-scm-command';

const enqueued: string[] = [];
vi.mock('../src/scm/lib/pg-supabase-transaction', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  runScmPgCommand: fakeRunScmPgCommand,
  deferScmAfterCommit: fakeDeferScmAfterCommit,
}));
vi.mock('../src/scm/middleware/auth', () => ({ supabaseAuth: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../src/scm/lib/houzs-perms', async (orig) => ({ ...(await orig<Record<string, unknown>>()), hasHouzsPerm: () => true }));
vi.mock('../src/scm/lib/migrated-so-readonly', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  migratedSoReadonlyState: async () => ({ locked: false }),
}));
vi.mock('../src/scm/lib/so-agent', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readStaffAgentName: async () => 'NEW REP',
}));
vi.mock('../src/scm/lib/autocount-outbox', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  enqueueEdit: async (_sb: unknown, o: { docNo: string }) => { enqueued.push(o.docNo); return true; },
}));

const { soHandover } = await import('../src/scm/routes/so-handover');

const REP_A = '11111111-1111-4111-8111-111111111111';
const REP_B = '22222222-2222-4222-8222-222222222222';
const world = () => fakeSb({
  mfg_sales_orders: [
    { doc_no: 'SO-1', company_id: 1, salesperson_id: REP_A, agent: 'OLD REP', status: 'CONFIRMED', linked_ac_docno: null },
    { doc_no: 'SO-2', company_id: 1, salesperson_id: REP_A, agent: 'OLD REP', status: 'CONFIRMED', linked_ac_docno: null },
  ],
  mfg_so_audit_log: [], staff: [],
});

const run = (sb: unknown) => {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u1', user_metadata: { name: 'Ops' } } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Ops', permissions: ['*'] } as never);
    await next();
  });
  app.route('/', soHandover);
  return app.request('/apply', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fromStaffId: REP_A, toStaffId: REP_B, docNos: ['SO-1', 'SO-2'] }),
  });
};

describe('SO handover batch', () => {
  test('moves every named order and queues AutoCount after the commit', async () => {
    enqueued.length = 0;
    const sb = world();
    const res = await run(sb);
    expect(res.status).toBe(200);
    expect(sb.tables.mfg_sales_orders.map((o) => o.salesperson_id)).toEqual([REP_B, REP_B]);
    expect(enqueued).toEqual(['SO-1', 'SO-2']);
  });

  test('a write that fails on the second order leaves the first unmoved too, and queues nothing', async () => {
    enqueued.length = 0;
    const sb = world();
    const rows = sb.tables.mfg_sales_orders;
    rows[1] = new Proxy(rows[1]!, {
      set(target, prop, value) {
        if (prop === 'salesperson_id') throw new Error('connection reset');
        return Reflect.set(target, prop, value);
      },
    });
    const res = await run(sb);
    expect(res.ok).toBe(false);
    expect(sb.tables.mfg_sales_orders.map((o) => o.salesperson_id)).toEqual([REP_A, REP_A]);
    expect(enqueued).toEqual([]);
  });
});
