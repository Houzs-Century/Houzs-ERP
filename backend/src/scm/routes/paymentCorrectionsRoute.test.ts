/* GET /accounting/payment-corrections — the Finance report is a filtered read
 * of the SO audit log, and these cases pin the FILTER, which is the whole
 * design: the payment actions made on the right (`source = 'amend'`), the
 * three payment actions, only this company, only this month — plus, since
 * docs/bugs/0888, the untagged rows a role holding the key TODAY wrote before
 * the rule asked it why, and beside every row who first recorded the payment.
 * A same-day fix by a role without the key carries the default source and
 * must not appear (owner 2026-09-10: 靠权限改的来决定); a header edit in the
 * same month is not a payment action at all.
 *
 * Driven through the REAL handler on a bare app with the fake PostgREST client,
 * the way controlCheckPaymentDrift.test.ts does — the accounting router
 * carries supabaseAuth, which cannot run without Worker bindings. The holders
 * of the key come off the Houzs DB (roles / users / user_companies), stood in
 * for by a three-table fake that answers the SQL permissionHolders writes.
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';
import { paymentCorrections } from './accounting-payment-corrections';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, company_id: 1, so_doc_no: '2990-SO-2609-001', action: 'UPDATE_PAYMENT',
  actor_id: 'u1', actor_name_snapshot: 'Chew', source: 'amend',
  note: 'Sales keyed the wrong figure', status_snapshot: null,
  field_changes: [
    { field: 'amountSen', from: 199_000, to: 199_100 },
    { field: 'ledger', from: 'JE-2609-0031', to: 'JE-2609-0058' },
    { field: 'ledgerReversal', from: null, to: 'JE-2609-0057' },
  ],
  created_at: '2026-09-10T02:15:00Z',
  payment_id: 'pay-1',
  ...over,
});

const sb = fakeSb({
  mfg_so_audit_log: [
    row('in-month'),
    row('deleted', { action: 'DELETE_PAYMENT', so_doc_no: '2990-SO-2609-002', payment_id: 'pay-2', field_changes: [{ field: 'amountSen', from: 50_000, to: null }, { field: 'ledger', from: 'JE-2609-0040', to: null }], created_at: '2026-09-05T08:00:00Z' }),
    /* An add on the right (docs/bugs/0888). */
    row('added', { action: 'ADD_PAYMENT', so_doc_no: '2990-SO-2609-003', payment_id: 'pay-3', note: 'Balance collected on delivery', field_changes: [{ field: 'paidAt', from: null, to: '2026-09-12' }, { field: 'method', from: null, to: 'cash' }, { field: 'amountSen', from: null, to: 150_000 }, { field: 'ledger', from: null, to: 'JE-2609-0070' }], created_at: '2026-09-12T01:00:00Z' }),
    /* An untagged correction from before payments were tagged: its recorder is
       read off the order's own ADD rows. */
    row('untagged', { so_doc_no: '2990-SO-2609-004', payment_id: null, created_at: '2026-09-08T01:00:00Z', field_changes: [{ field: 'amountSen', from: 30_000, to: 30_100 }] }),
    /* The owner's add from BEFORE the rule: default source, by a name whose role
       holds the key today. Listed, marked, no reason. */
    row('before-rule', { action: 'ADD_PAYMENT', so_doc_no: '2990-SO-2609-005', payment_id: 'pay-5', source: 'web', note: null, field_changes: [{ field: 'amountSen', from: null, to: 20_000 }], created_at: '2026-09-14T00:30:00Z' }),
    /* The neighbours that must NOT appear. */
    row('same-day-fix-by-sales', { source: 'web', actor_name_snapshot: 'Rachael' }),
    row('automation-by-holder', { source: 'automation', action: 'ADD_PAYMENT' }),
    row('header-edit', { action: 'UPDATE_HEADER' }),
    row('other-company', { company_id: 2 }),
    row('last-month', { created_at: '2026-08-31T23:59:59Z' }),
    row('next-month', { created_at: '2026-10-01T00:00:00Z' }),
    /* The ADD rows the recorder lookups read — these are not in the month. */
    row('add-of-pay-1', { action: 'ADD_PAYMENT', payment_id: 'pay-1', source: 'web', actor_name_snapshot: 'Rachael', note: null, field_changes: [{ field: 'amountSen', from: null, to: 199_000 }], created_at: '2026-08-29T06:00:00Z' }),
    row('add-of-pay-2-scan', { action: 'ADD_PAYMENT', so_doc_no: '2990-SO-2609-002', payment_id: 'pay-2', source: 'automation', actor_name_snapshot: null, note: 'Auto: payment recorded from scanned receipt (background scan job)', field_changes: [{ field: 'amountSen', from: null, to: 50_000 }], created_at: '2026-08-30T06:00:00Z' }),
    row('add-of-so-004', { action: 'ADD_PAYMENT', so_doc_no: '2990-SO-2609-004', payment_id: null, source: 'web', actor_name_snapshot: 'Zack', note: null, field_changes: [{ field: 'amountSen', from: null, to: 30_000 }], created_at: '2026-08-20T06:00:00Z' }),
  ],
  mfg_sales_order_payments: [
    { id: 'pay-1', company_id: 1, so_doc_no: '2990-SO-2609-001', collected_by: 'staff-r', created_at: '2026-08-29T06:00:00Z' },
    { id: 'pay-2', company_id: 1, so_doc_no: '2990-SO-2609-002', collected_by: 'staff-w', created_at: '2026-08-30T06:00:00Z' },
  ],
  staff: [
    { id: 'staff-r', name: 'Rachael' },
    { id: 'staff-w', name: 'Wei How' },
  ],
  mfg_sales_orders: [
    { doc_no: '2990-SO-2609-001', company_id: 1, debtor_name: 'Wong li way' },
    { doc_no: '2990-SO-2609-002', company_id: 1, debtor_name: 'Lim Siew Mei' },
    { doc_no: '2990-SO-2609-003', company_id: 1, debtor_name: 'Tan Ah Kow' },
    { doc_no: '2990-SO-2609-004', company_id: 1, debtor_name: 'Lee Mei' },
    { doc_no: '2990-SO-2609-005', company_id: 1, debtor_name: 'Ng Boon' },
  ],
});

const CALLER = {
  id: 'u1', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Chew' }, aud: 'authenticated', created_at: '',
} as unknown as User;

/* The Houzs DB, as permissionHolders.ts and the route query it: roles (no
   bind), then users by role, then user_companies by user, then names by id.
   The Finance role grants the key literally; the Owner role carries only the
   wildcard and must not count; Chew's own role carries both. */
type HoldersDb = { roles: Array<{ id: number; permissions: string }>; users: Array<{ id: number; name: string; role_id: number; status: string }>; grants: Array<{ user_id: number; company_id: number }> };
const HOLDERS: HoldersDb = {
  roles: [
    { id: 1, permissions: '["*"]' },
    { id: 7, permissions: '["*", "scm.so_payment.amend"]' },
    { id: 325, permissions: '["scm.so_payment.amend"]' },
    { id: 8, permissions: '["sales.read"]' },
  ],
  users: [
    { id: 1, name: 'HOUZS CENTURY', role_id: 1, status: 'active' },
    { id: 139, name: 'Chew', role_id: 7, status: 'active' },
    { id: 48, name: 'FINANCE', role_id: 325, status: 'active' },
    { id: 19, name: 'Rachael', role_id: 8, status: 'active' },
  ],
  grants: [],
};
const fakeDb = (db: HoldersDb | Error) => ({
  prepare: (sql: string) => {
    const answer = (binds: unknown[]) => {
      if (db instanceof Error) throw db;
      if (/FROM roles/.test(sql)) return db.roles;
      if (/FROM users\s+WHERE status/.test(sql)) return db.users.filter((u) => binds.map(Number).includes(u.role_id)).map((u) => ({ id: u.id }));
      if (/FROM user_companies/.test(sql)) return db.grants.filter((g) => binds.map(Number).includes(g.user_id));
      if (/SELECT name FROM users/.test(sql)) return db.users.filter((u) => binds.map(Number).includes(u.id)).map((u) => ({ name: u.name }));
      throw new Error(`unexpected SQL: ${sql}`);
    };
    return {
      all: async () => ({ results: answer([]) }),
      bind: (...binds: unknown[]) => ({ all: async () => ({ results: answer(binds) }) }),
    };
  },
});

type ReportRow = {
  id: string; kind: string; by: string; customer: string | null; reason: string; beforeRule: boolean;
  recordedBy: string | null; recordedOn: string | null;
  jeNo: string | null; originalJeNo: string | null; contraJeNo: string | null; amountFromSen: number | null; amountToSen: number | null;
};
type Report = {
  month: string;
  rows: ReportRow[];
  summary: { corrections: number; added: number; edited: number; deleted: number; proof: number; netMovedSen: number; addedSen: number; deletedSen: number };
};

async function get(query: string, db: HoldersDb | Error = HOLDERS) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.get('/payment-corrections', paymentCorrections);
  return app.request(`/payment-corrections${query}`, undefined, { DB: fakeDb(db) } as unknown as Env);
}

describe('GET /accounting/payment-corrections', () => {
  it('lists the payment actions made on the right, of this company and month, newest first — and a holder\'s untagged row from before the rule', async () => {
    const res = await get('?month=2026-09');
    expect(res.status).toBe(200);
    const body = await res.json() as Report;
    expect(body.month).toBe('2026-09');
    expect(body.rows.map((r) => r.id)).toEqual(['before-rule', 'added', 'in-month', 'untagged', 'deleted']);
  });

  it('names the customer off the order, and carries reason and both JE numbers', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    expect(body.rows.find((r) => r.id === 'in-month')).toMatchObject({
      kind: 'edited', customer: 'Wong li way', reason: 'Sales keyed the wrong figure', beforeRule: false,
      amountFromSen: 199_000, amountToSen: 199_100, originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
    });
    expect(body.rows.find((r) => r.id === 'deleted')).toMatchObject({ kind: 'deleted', customer: 'Lim Siew Mei', amountFromSen: 50_000, amountToSen: null, jeNo: null });
    expect(body.rows.find((r) => r.id === 'added')).toMatchObject({ kind: 'added', customer: 'Tan Ah Kow', amountToSen: 150_000, reason: 'Balance collected on delivery', jeNo: 'JE-2609-0070' });
  });

  /* Who FIRST recorded the payment (owner 2026-09-14: 我就是要看原本是谁记录这一笔的):
     the tagged edit follows its payment id to Rachael's ADD row; the tagged
     delete's ADD row is the scan job's and names nobody, so the collector on
     the payment row answers; the untagged edit reads its order's one earlier
     add; the add names itself; the before-the-rule add names itself too. */
  it('names who first recorded each payment, by the ADD row, the collector, or the order\'s one earlier add', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    const by = Object.fromEntries(body.rows.map((r) => [r.id, [r.recordedBy, r.recordedOn]]));
    expect(by).toEqual({
      'in-month': ['Rachael', '2026-08-29T06:00:00Z'],
      deleted: ['Wei How', '2026-08-30T06:00:00Z'],
      untagged: ['Zack', '2026-08-20T06:00:00Z'],
      added: ['Chew', '2026-09-12T01:00:00Z'],
      'before-rule': ['Chew', '2026-09-14T00:30:00Z'],
    });
  });

  it('a row from before the rule carries no reason and says so', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    expect(body.rows.find((r) => r.id === 'before-rule')).toMatchObject({ kind: 'added', by: 'Chew', reason: '', beforeRule: true, amountToSen: 20_000 });
  });

  it('the before-the-rule rows follow the roles that hold the key LITERALLY — a wildcard-only role is not a holder', async () => {
    /* Same rows, but the only role naming the key is nobody's: Chew's row is
       on the wildcard alone, so his untagged add is no longer listed. */
    const body = await (await get('?month=2026-09', {
      ...HOLDERS, roles: [{ id: 1, permissions: '["*"]' }, { id: 7, permissions: '["*"]' }, { id: 325, permissions: '["scm.so_payment.amend"]' }, { id: 8, permissions: '["sales.read"]' }],
    })).json() as Report;
    expect(body.rows.map((r) => r.id)).toEqual(['added', 'in-month', 'untagged', 'deleted']);
  });

  it('adds the month up', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    expect(body.summary).toEqual({
      corrections: 5, added: 2, edited: 2, deleted: 1, proof: 0,
      netMovedSen: 20_000 + 150_000 + 100 + 100 - 50_000, addedSen: 170_000, deletedSen: 50_000,
    });
  });

  it('an empty month is an empty report', async () => {
    const body = await (await get('?month=2026-07')).json() as Report;
    expect(body.rows).toEqual([]);
    expect(body.summary.corrections).toBe(0);
  });

  it('refuses a month it cannot read rather than guessing one', async () => {
    expect((await get('')).status).toBe(400);
    expect((await get('?month=Sept')).status).toBe(400);
  });

  /* A month with the before-the-rule rows silently missing would be a
     different document from the one asked for. */
  it('refuses the report when the holders of the key cannot be read', async () => {
    const res = await get('?month=2026-09', new Error('D1 is away'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'load_failed', reason: 'holders: D1 is away' });
  });
});
