/* The account-roles window (GET /roles, PUT /roles/BANK_DEFAULT) and the
 * money-account guard on the PV "Paid From".
 *
 * WHY. The owner maintains his own default bank per company (默认银行我可以自己
 * maintenance), and a voucher pays FROM money (paid from 应该只能选cash 和银行) —
 * both arrived 2026-08-30 with the PV/AP-Payment split. The guard is
 * server-side because a picker filter alone leaves the API able to credit an
 * expense account, which "pays" without any money leaving.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

const CO = 1;
const sb = fakeSb({
  accounts: [
    { account_code: '330-0000', account_name: 'Bank — Maybank', account_type: 'ASSET', acc_money: true, is_active: true, company_id: CO },
    { account_code: '331-0000', account_name: 'Bank — HLB', account_type: 'ASSET', acc_money: true, is_active: true, company_id: CO },
    { account_code: '900-A002', account_name: 'Advertisement', account_type: 'EXPENSE', acc_money: false, is_active: true, company_id: CO },
    { account_code: '332-0000', account_name: 'Bank — closed', account_type: 'ASSET', acc_money: true, is_active: false, company_id: CO },
    /* The OTHER company's bank — must be invisible to company 1's PUT. */
    { account_code: '360-0000', account_name: '2990 Bank', account_type: 'ASSET', acc_money: true, is_active: true, company_id: 2 },
  ],
  acc_account_roles: [],
});

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));

const CALLER = {
  id: '7', email: 'acct@houzs.test', app_metadata: {},
  user_metadata: { name: 'Acct' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { accountRolesGet, accountRolesPutBankDefault, accounting } = await import('./accounting');

function app() {
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', CO);
    c.set('supabase', sb as never);
    c.set('houzsUser' as never, { id: 9, name: 'Acct', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.get('/roles', accountRolesGet as never);
  a.put('/roles/BANK_DEFAULT', accountRolesPutBankDefault as never);
  a.route('/', accounting);
  return a;
}

const put = (code: string) => app().request('/roles/BANK_DEFAULT', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ accountCode: code }),
});

describe('the roles window', () => {
  it('answers with the resolved roles, defaults standing in where nothing is set', async () => {
    const res = await app().request('/roles');
    expect(res.status).toBe(200);
    const body = await res.json() as { roles: Record<string, string>; overridden: Record<string, string> };
    expect(body.roles.BANK_DEFAULT).toBe('330-0000');   // DEFAULT_ROLE_CODES fallback
    expect(body.roles.AP).toBe('400-0000');
    expect(body.overridden.BANK_DEFAULT).toBeUndefined();
  });

  it('repoints BANK_DEFAULT to another money account, and the read shows it', async () => {
    expect((await put('331-0000')).status).toBe(200);
    const body = await (await app().request('/roles')).json() as { roles: Record<string, string>; overridden: Record<string, string> };
    expect(body.roles.BANK_DEFAULT).toBe('331-0000');
    expect(body.overridden.BANK_DEFAULT).toBe('331-0000');
  });

  it('refuses an expense account, an inactive bank, and another company\'s bank — each by name', async () => {
    const expense = await put('900-A002');
    expect(expense.status).toBe(409);
    expect(((await expense.json()) as { error: string }).error).toBe('not_a_money_account');

    const inactive = await put('332-0000');
    expect(inactive.status).toBe(409);
    expect(((await inactive.json()) as { error: string }).error).toBe('account_inactive');

    const theirs = await put('360-0000');
    expect(theirs.status).toBe(404);
    expect(((await theirs.json()) as { error: string }).error).toBe('no_such_account');

    /* And nothing above moved the role. */
    const body = await (await app().request('/roles')).json() as { roles: Record<string, string> };
    expect(body.roles.BANK_DEFAULT).toBe('331-0000');
  });

  it('GET /accounts now carries acc_money, so pickers can offer only money', async () => {
    const res = await app().request('/accounts');
    const body = await res.json() as { accounts: Array<{ account_code: string; acc_money: boolean | null }> };
    const bank = body.accounts.find((a) => a.account_code === '330-0000');
    const expense = body.accounts.find((a) => a.account_code === '900-A002');
    expect(bank?.acc_money).toBe(true);
    expect(expense?.acc_money).toBe(false);
  });
});
