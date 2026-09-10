/* POST / DELETE /settlement/payouts/:id/days/:settledOn/charge — the bank
 * deducted a charge from one day of an advice, booked where Finance says.
 *
 * The RULE is pinned in acc/payout-charge.test.ts. What is pinned here is the
 * ROUTE: it needs the reconcile permission like every other payout handler,
 * it refuses a malformed day, it answers each of the module's refusals as a
 * sentence with the right status, and the list re-reads the charge so the day
 * comes back agreeing with where the money went. Driven through the real
 * handlers on a bare app with the fake PostgREST client.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const CHART: Row[] = [
  { account_code: '326-0010', account_name: 'PBB transit', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '900-T009', account_name: 'Terminal charges', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '905-0000', account_name: 'Stationery', account_type: 'EXPENSE', parent_code: null, is_active: true, company_id: 2 },
  { account_code: '310-0010', account_name: 'HLB', account_type: 'ASSET', parent_code: null, is_active: true, company_id: 2 },
];

const world = () => fakeSb({
  accounts: CHART,
  acc_account_roles: [],
  acc_acquirers: [{ company_id: 2, code: 'PBB', display_name: 'PBB', transit_account_code: '326-0010', fee_account_code: '900-T009', bank_account_code: '310-0010', is_active: true }],
  acc_settlement_batches: [{ id: 6, company_id: 2, acquirer_code: 'PBB', file_name: '2990HOMESB_CSV_20260606.csv', period_from: '2026-06-06', period_to: '2026-06-06', net_sen: 334_818, stated_net_sen: 334_818 }],
  acc_settlement_rows: [],
  acc_settlement_payouts: [{ id: 3, company_id: 2, acquirer_code: 'PBB', file_name: '2990HOMESB_IBG_20260608.pdf', advice_date: '2026-06-08', net_sen: 302_418 }],
  acc_settlement_payout_batches: [{ id: 11, payout_id: 3, company_id: 2, settled_on: '2026-06-06', net_sen: 302_418, batch_id: 6, charge_sen: 0, charge_account_code: null }],
  journal_entries: [],
  journal_entry_lines: [],
}, {}, [], ['acc_settlement_payout_batches', 'acc_settlement_batches', 'acc_settlement_payouts']);

const CALLER = {
  id: 'u1', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Chew' }, aud: 'authenticated', created_at: '',
} as unknown as User;

let allowed = true;
vi.mock('../lib/houzs-perms', () => ({ hasHouzsPerm: () => allowed }));

const { payoutCharge, payoutChargeUndo, payoutList } = await import('./accounting-payouts');

const appOn = (sb: ReturnType<typeof world>) => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', 2);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.post('/settlement/payouts/:id/days/:settledOn/charge', payoutCharge);
  app.delete('/settlement/payouts/:id/days/:settledOn/charge', payoutChargeUndo);
  app.get('/settlement/payouts', payoutList);
  return app;
};

const charge = (app: Hono<{ Bindings: Env; Variables: Variables }>, body: Record<string, unknown>, day = '2026-06-06') =>
  app.request(`/settlement/payouts/3/days/${day}/charge`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('booking a bank charge against an advice day', () => {
  it('books it, and the list then shows the day agreeing with where the money went', async () => {
    allowed = true;
    const sb = world();
    const app = appOn(sb);
    const res = await charge(app, { accountCode: '900-T009', note: 'PBB card-terminal application fee' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'charged', chargeSen: 32_400, accountCode: '900-T009' });

    const list = await (await app.request('/settlement/payouts')).json() as {
      payouts: Array<{ status: { readyToReceive: boolean; days: Array<Record<string, unknown>> } }>;
      chargeAccounts: Array<{ accountCode: string }>;
      feeAccountByAcquirer: Record<string, string | null>;
    };
    expect(list.payouts[0].status.days[0]).toMatchObject({ state: 'AGREES', differenceSen: 0, chargeSen: 32_400, chargeAccountCode: '900-T009', chargeNote: 'PBB card-terminal application fee' });
    expect(list.payouts[0].status.readyToReceive).toBe(true);
    /* And what the dialog needs: the accounts it may offer, and the default. */
    expect(list.chargeAccounts.map((a) => a.accountCode)).toEqual(['900-T009', '905-0000']);
    expect(list.feeAccountByAcquirer).toEqual({ PBB: '900-T009' });
  });

  it('answers the module\'s refusals as sentences, with 409', async () => {
    allowed = true;
    const app = appOn(world());
    const noNote = await charge(app, { accountCode: '900-T009', note: '' });
    expect(noNote.status).toBe(409);
    expect(await noNote.json()).toMatchObject({ error: 'note_required' });
    const badAccount = await charge(app, { accountCode: '310-0010', note: 'fee' });
    expect(badAccount.status).toBe(409);
    expect((await badAccount.json() as { message: string }).message).toMatch(/310-0010 is ASSET/);
    const tooMuch = await charge(app, { accountCode: '900-T009', note: 'fee', amountSen: 99_999 });
    expect(await tooMuch.json()).toMatchObject({ error: 'over_difference' });
  });

  it('404s a day the advice does not name, and 400s a malformed one', async () => {
    allowed = true;
    const app = appOn(world());
    expect((await charge(app, { accountCode: '900-T009', note: 'fee' }, '2026-06-09')).status).toBe(404);
    expect((await charge(app, { accountCode: '900-T009', note: 'fee' }, 'June')).status).toBe(400);
  });

  it('needs the reconcile permission, like every other payout handler', async () => {
    allowed = false;
    const app = appOn(world());
    expect((await charge(app, { accountCode: '900-T009', note: 'fee' })).status).toBe(403);
    expect((await app.request('/settlement/payouts/3/days/2026-06-06/charge', { method: 'DELETE' })).status).toBe(403);
  });

  it('undoes through the engine and the day differs again', async () => {
    allowed = true;
    const sb = world();
    const app = appOn(sb);
    await charge(app, { accountCode: '900-T009', note: 'fee' });
    const res = await app.request('/settlement/payouts/3/days/2026-06-06/charge', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(sb.tables.journal_entries.filter((j: Row) => j.source_type === 'SETTLECHARGE' && !j.reversed)).toHaveLength(0);
    const list = await (await app.request('/settlement/payouts')).json() as { payouts: Array<{ status: { days: Array<Record<string, unknown>> } }> };
    expect(list.payouts[0].status.days[0]).toMatchObject({ state: 'DIFFERS', differenceSen: 32_400, chargeSen: 0 });
    /* Nothing to undo twice. */
    expect((await app.request('/settlement/payouts/3/days/2026-06-06/charge', { method: 'DELETE' })).status).toBe(409);
  });
});
