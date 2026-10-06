/**
 * POST /maintenance-config/sofa-compartments/rename drives the real handler.
 * The old route called rename_sofa_compartment(from, to) with no company, so a
 * HOUZS rename rewrote 2990 too, and ran it with no preview. The SQL side is
 * proven in tests-pg/renameSofaCompartmentScoped.pg.test.ts; this file proves
 * the route always sends the ACTIVE company and previews unless apply === true.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { renameSofaCompartmentHandler } from '../src/scm/routes/maintenance-config';

type Call = { fn: string; args: Record<string, unknown> };

function makeApp(opts: { companyId: number | undefined; perms: string[]; rpc: (args: Record<string, unknown>) => { data: unknown; error: unknown } }) {
  const calls: Call[] = [];
  const app = new Hono();
  app.use('*', async (c: any, next: any) => {
    c.set('houzsUser', { id: 9, permissions_set: new Set(opts.perms) });
    if (opts.companyId != null) c.set('companyId', opts.companyId);
    c.set('supabase', {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        return opts.rpc(args);
      },
    });
    await next();
  });
  app.post('/rename', renameSofaCompartmentHandler as any);
  const post = (body: unknown) => app.request('/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, {} as any);
  return { calls, post };
}

const ok = (applied: boolean) => () => ({ data: { applied, refused: null, inUse: {}, inUseTotal: 0, changes: {} }, error: null });

describe('compartment rename route', () => {
  test('sends the active company and previews by default', async () => {
    const { calls, post } = makeApp({ companyId: 2, perms: ['*'], rpc: ok(false) });
    const res = await post({ from: 'Consle', to: 'CNSL' });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ fn: 'rename_sofa_compartment', args: { p_company_id: 2, p_from: 'Consle', p_to: 'CNSL', p_apply: false } }]);
    expect(((await res.json()) as any).applied).toBe(false);
  });

  test('only apply === true writes; a truthy string is still a preview', async () => {
    const { calls, post } = makeApp({ companyId: 1, perms: ['*'], rpc: ok(true) });
    await post({ from: 'Consle', to: 'CNSL', apply: 'true' });
    await post({ from: 'Consle', to: 'CNSL', apply: true });
    expect(calls.map((c) => c.args.p_apply)).toEqual([false, true]);
  });

  test('no resolved company refuses before the database is called', async () => {
    const { calls, post } = makeApp({ companyId: undefined, perms: ['*'], rpc: ok(true) });
    const res = await post({ from: 'Consle', to: 'CNSL', apply: true });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test('without the config-write permission nothing is called', async () => {
    const { calls, post } = makeApp({ companyId: 1, perms: [], rpc: ok(true) });
    const res = await post({ from: 'Consle', to: 'CNSL', apply: true });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test('a code still in use comes back as 409 in_use with the counts', async () => {
    const { post } = makeApp({
      companyId: 1, perms: ['*'],
      rpc: () => ({ data: { applied: false, refused: 'in_use', inUse: { 'mfg_products.code': 14 }, inUseTotal: 14 }, error: null }),
    });
    const res = await post({ from: 'Console', to: 'ConsoleF', apply: true });
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toBe('in_use');
    expect(body.result.inUse['mfg_products.code']).toBe(14);
    expect(body.reason.length).toBeLessThan(200);
  });

  test('a code with a space is a 400 with a short reason', async () => {
    const { post } = makeApp({ companyId: 1, perms: ['*'], rpc: () => ({ data: null, error: { message: 'invalid_code' } }) });
    const res = await post({ from: 'Console', to: 'Console Fabric' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('invalid_code');
  });
});
