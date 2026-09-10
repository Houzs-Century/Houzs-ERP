/* GET /accounting/payment-corrections — the Finance report is a filtered read
 * of the SO audit log, and these cases pin the FILTER, which is the whole
 * design: only corrections made on the amend right (`source = 'amend'`), only
 * the two payment actions, only this company, only this month. A same-day fix
 * by the person who keyed the payment carries the default source and must not
 * appear (owner 2026-09-10: 靠权限改的来决定); a header edit in the same month
 * is not a payment correction at all.
 *
 * Driven through the REAL handler on a bare app with the fake PostgREST client,
 * the way controlCheckPaymentDrift.test.ts does — the accounting router
 * carries supabaseAuth, which cannot run without Worker bindings.
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
  ...over,
});

const sb = fakeSb({
  mfg_so_audit_log: [
    row('in-month'),
    row('deleted', { action: 'DELETE_PAYMENT', so_doc_no: '2990-SO-2609-002', field_changes: [{ field: 'amountSen', from: 50_000, to: null }, { field: 'ledger', from: 'JE-2609-0040', to: null }], created_at: '2026-09-05T08:00:00Z' }),
    /* The neighbours that must NOT appear. */
    row('same-day-fix', { source: 'web' }),
    row('header-edit', { action: 'UPDATE_HEADER' }),
    row('other-company', { company_id: 2 }),
    row('last-month', { created_at: '2026-08-31T23:59:59Z' }),
    row('next-month', { created_at: '2026-10-01T00:00:00Z' }),
  ],
  mfg_sales_orders: [
    { doc_no: '2990-SO-2609-001', company_id: 1, debtor_name: 'Wong li way' },
    { doc_no: '2990-SO-2609-002', company_id: 1, debtor_name: 'Lim Siew Mei' },
  ],
});

const CALLER = {
  id: 'u1', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Chew' }, aud: 'authenticated', created_at: '',
} as unknown as User;

type Report = {
  month: string;
  rows: Array<{ id: string; kind: string; customer: string | null; reason: string; jeNo: string | null; originalJeNo: string | null; contraJeNo: string | null; amountFromSen: number | null; amountToSen: number | null }>;
  summary: { corrections: number; edited: number; deleted: number; netMovedSen: number; deletedSen: number };
};

async function get(query: string) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 1);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.get('/payment-corrections', paymentCorrections);
  return app.request(`/payment-corrections${query}`);
}

describe('GET /accounting/payment-corrections', () => {
  it('lists only the amend-sourced payment corrections of this company and month, newest first', async () => {
    const res = await get('?month=2026-09');
    expect(res.status).toBe(200);
    const body = await res.json() as Report;
    expect(body.month).toBe('2026-09');
    expect(body.rows.map((r) => r.id)).toEqual(['in-month', 'deleted']);
  });

  it('names the customer off the order, and carries reason and both JE numbers', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    expect(body.rows[0]).toMatchObject({
      kind: 'edited', customer: 'Wong li way', reason: 'Sales keyed the wrong figure',
      amountFromSen: 199_000, amountToSen: 199_100, originalJeNo: 'JE-2609-0031', contraJeNo: 'JE-2609-0057', jeNo: 'JE-2609-0058',
    });
    expect(body.rows[1]).toMatchObject({ kind: 'deleted', customer: 'Lim Siew Mei', amountFromSen: 50_000, amountToSen: null, jeNo: null });
  });

  it('adds the month up', async () => {
    const body = await (await get('?month=2026-09')).json() as Report;
    expect(body.summary).toEqual({ corrections: 2, edited: 1, deleted: 1, netMovedSen: 100 - 50_000, deletedSen: 50_000 });
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
});
