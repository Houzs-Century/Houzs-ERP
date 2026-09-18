// The product-group ↔ account registry (GL redesign item 1). What is pinned:
//   • the permission gate answers 403 here too (前后端各检查一次);
//   • a group is BORN BOUND — creating one without all four accounts, or with
//     an account this company's chart does not carry (or carries switched
//     off), is refused with the slot and code NAMED;
//   • creation goes through the ONE registry function (the enum must learn the
//     label in the same breath), and the rpc call is asserted, not assumed;
//   • deactivating hides a group from new products without touching bindings.

import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import {
  itemGroupsList, itemGroupCreate, itemGroupBind, itemGroupPatch,
} from '../src/scm/routes/accounting-item-groups';

const GL_PERM = 'scm.payment_voucher.post';

const CHART: Row[] = [
  { company_id: 2, account_code: '601-0003', account_name: 'PURCHASE OF SOFA', account_type: 'EXPENSE', is_active: true },
  { company_id: 2, account_code: '501-0000', account_name: 'SALES OF FURNITURE & FITTINGS', account_type: 'INCOME', is_active: true },
  { company_id: 2, account_code: '510-0000', account_name: 'RETURN INWARDS', account_type: 'INCOME', is_active: true },
  { company_id: 2, account_code: '612-0000', account_name: 'PURCHASES RETURN', account_type: 'EXPENSE', is_active: true },
  { company_id: 2, account_code: '602-0000', account_name: 'PURCHASES OF BEDLINES', account_type: 'EXPENSE', is_active: false },
];

const GROUPS: Row[] = [
  { code: 'SOFA', name: 'Sofa', is_active: true },
  { code: 'BEDLINES', name: 'Bedlines', is_active: true },
];

const GOOD_ACCOUNTS = {
  purchase: '601-0003', sales: '501-0000', salesReturn: '510-0000', purchaseReturn: '612-0000',
};

function harness(tables: Record<string, Row[]> = {}, perms: readonly string[] = [GL_PERM]) {
  const sb = fakeSb({
    accounts: CHART.map((r) => ({ ...r })),
    acc_item_groups: GROUPS.map((r) => ({ ...r })),
    acc_item_group_accounts: [],
    ...tables,
  });
  /* The registry function lives in Postgres; the fake mirrors its one visible
     effect (the group row appears / revives). The enum side has no DML shape,
     which is exactly why the ROUTE must be seen calling the rpc. */
  sb.rpcHandlers.acc_register_item_group = (args) => {
    const code = String(args.p_code);
    const cur = sb.tables.acc_item_groups.find((g) => g.code === code);
    if (cur) { cur.name = String(args.p_name); cur.is_active = true; }
    else sb.tables.acc_item_groups.push({ code, name: String(args.p_name), is_active: true });
    return null;
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, 2 as never);
    c.set('houzsUser' as never, { name: 'Tester', permissions_set: perms } as never);
    c.set('allowedCompanyIds' as never, [1, 2] as never);
    c.set('companies' as never, [
      { id: 1, code: 'HOUZS' }, { id: 2, code: '2990' },
    ] as never);
    await next();
  });
  app.get('/accounting/item-groups', itemGroupsList as never);
  app.post('/accounting/item-groups', itemGroupCreate as never);
  app.put('/accounting/item-groups/:code/accounts', itemGroupBind as never);
  app.patch('/accounting/item-groups/:code', itemGroupPatch as never);
  return { app, sb };
}

const post = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (app: Hono, path: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('permissions', () => {
  test('no GL permission — every route answers 403', async () => {
    const { app } = harness({}, []);
    expect((await app.request('/accounting/item-groups')).status).toBe(403);
    expect((await post(app, '/accounting/item-groups', {})).status).toBe(403);
    expect((await put(app, '/accounting/item-groups/SOFA/accounts', {})).status).toBe(403);
    expect((await patch(app, '/accounting/item-groups/SOFA', {})).status).toBe(403);
  });
});

describe('GET /accounting/item-groups', () => {
  test('lists every group with its per-company bindings (absence = unbound)', async () => {
    const { app } = harness({
      acc_item_group_accounts: [{
        company_id: 2, group_code: 'SOFA',
        purchase_account: '601-0003', sales_account: '501-0000',
        sales_return_account: '510-0000', purchase_return_account: '612-0000',
      }],
    });
    const res = await app.request('/accounting/item-groups');
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: Array<{ code: string; bindings: Record<string, unknown> }> };
    const sofa = body.groups.find((g) => g.code === 'SOFA')!;
    expect(sofa.bindings['2']).toMatchObject({ purchase: '601-0003', sales: '501-0000' });
    const bedlines = body.groups.find((g) => g.code === 'BEDLINES')!;
    expect(bedlines.bindings).toEqual({});
  });
});

describe('POST /accounting/item-groups — born bound, or not born', () => {
  test('a missing slot is refused with the slot named, and no group appears', async () => {
    const { app, sb } = harness();
    const res = await post(app, '/accounting/item-groups', {
      code: 'CURTAIN', name: 'Curtain', companyId: 2,
      accounts: { ...GOOD_ACCOUNTS, salesReturn: '' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('Sales Return');
    expect(sb.rpcCalls).toHaveLength(0);
    expect(sb.tables.acc_item_groups.some((g) => g.code === 'CURTAIN')).toBe(false);
  });

  test('an account the chart holds switched OFF is refused by code', async () => {
    const { app, sb } = harness();
    const res = await post(app, '/accounting/item-groups', {
      code: 'CURTAIN', name: 'Curtain', companyId: 2,
      accounts: { ...GOOD_ACCOUNTS, purchase: '602-0000' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('602-0000');
    expect(sb.rpcCalls).toHaveLength(0);
  });

  test('an account missing from the chart entirely is refused by code', async () => {
    const { app } = harness();
    const res = await post(app, '/accounting/item-groups', {
      code: 'CURTAIN', name: 'Curtain', companyId: 2,
      accounts: { ...GOOD_ACCOUNTS, sales: '599-9999' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain('599-9999');
  });

  test('a bad code shape never reaches the registry', async () => {
    const { app, sb } = harness();
    const res = await post(app, '/accounting/item-groups', {
      code: 'so fa!', name: 'X', companyId: 2, accounts: GOOD_ACCOUNTS,
    });
    expect(res.status).toBe(400);
    expect(sb.rpcCalls).toHaveLength(0);
  });

  test('a valid create registers through the rpc AND binds this company', async () => {
    const { app, sb } = harness();
    const res = await post(app, '/accounting/item-groups', {
      code: 'curtain', name: 'Curtain', companyId: 2, accounts: GOOD_ACCOUNTS,
    });
    expect(res.status).toBe(200);
    // Lower-case input is normalised; the enum learns the label via the rpc.
    expect(sb.rpcCalls).toEqual([{ fn: 'acc_register_item_group', args: { p_code: 'CURTAIN', p_name: 'Curtain' } }]);
    expect(sb.tables.acc_item_groups.some((g) => g.code === 'CURTAIN')).toBe(true);
    expect(sb.tables.acc_item_group_accounts).toHaveLength(1);
    expect(sb.tables.acc_item_group_accounts[0]).toMatchObject({
      company_id: 2, group_code: 'CURTAIN', purchase_account: '601-0003',
    });
  });
});

describe('PUT /accounting/item-groups/:code/accounts', () => {
  test('binds an existing group for one company; an unknown group is 404', async () => {
    const { app, sb } = harness();
    const ok = await put(app, '/accounting/item-groups/BEDLINES/accounts', { companyId: 2, accounts: GOOD_ACCOUNTS });
    expect(ok.status).toBe(200);
    expect(sb.tables.acc_item_group_accounts[0]).toMatchObject({ group_code: 'BEDLINES', company_id: 2 });

    const missing = await put(app, '/accounting/item-groups/NOPE/accounts', { companyId: 2, accounts: GOOD_ACCOUNTS });
    expect(missing.status).toBe(404);
  });

  test('a company outside the grants is refused', async () => {
    const { app } = harness();
    const res = await put(app, '/accounting/item-groups/SOFA/accounts', { companyId: 9, accounts: GOOD_ACCOUNTS });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /accounting/item-groups/:code', () => {
  test('renames and de-lists; bindings survive de-listing', async () => {
    const { app, sb } = harness({
      acc_item_group_accounts: [{
        company_id: 2, group_code: 'SOFA',
        purchase_account: '601-0003', sales_account: '501-0000',
        sales_return_account: '510-0000', purchase_return_account: '612-0000',
      }],
    });
    const res = await patch(app, '/accounting/item-groups/SOFA', { name: 'Sofa & Lounge', isActive: false });
    expect(res.status).toBe(200);
    const g = sb.tables.acc_item_groups.find((r) => r.code === 'SOFA')!;
    expect(g).toMatchObject({ name: 'Sofa & Lounge', is_active: false });
    expect(sb.tables.acc_item_group_accounts).toHaveLength(1);

    expect((await patch(app, '/accounting/item-groups/NOPE', { name: 'X' })).status).toBe(404);
  });
});
