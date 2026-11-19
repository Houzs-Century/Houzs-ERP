/* A master address needs a postcode (owner 2026-11-19: 主档 Postcode 改必填):
   supplier, warehouse, 3PL company and project venue in Malaysia or Singapore.
   A foreign supplier is skipped; a save that leaves the postcode alone on an old
   row without one is not blocked, but clearing it is refused. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createSupplierHandler, patchSupplierHandler } from '../src/scm/routes/suppliers';
import { masterNeedsPostcode, masterPostcodeError, MASTER_POSTCODE_MESSAGE } from '../src/scm/shared/master-postcode-rule';

const CO = 2;
const FINANCE = { id: 7, name: 'Carrie Ong', position_name: 'Finance Executive', position_policy: { cohort: 'full', can_move_money: true }, permissions_set: new Set<string>() };

function harness(rows: Row[]) {
  const sb = fakeSb({ suppliers: rows.map((r) => ({ ...r })), supplier_material_bindings: [] });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, FINANCE as never);
    await next();
  });
  app.post('/suppliers', createSupplierHandler as never);
  app.patch('/suppliers/:id', patchSupplierHandler as never);
  return { app };
}
const send = (app: Hono, method: 'POST' | 'PATCH', url: string, body: Row) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the rule', () => {
  test('Malaysia, Singapore and a blank country need one; a foreign country does not', () => {
    for (const c of [null, '', 'Malaysia', 'MY', 'singapore', 'SG']) expect(masterNeedsPostcode(c)).toBe(true);
    for (const c of ['China', 'Indonesia', 'Thailand']) expect(masterNeedsPostcode(c)).toBe(false);
    expect(masterPostcodeError('Malaysia', '  ')).toBe(MASTER_POSTCODE_MESSAGE);
    expect(masterPostcodeError('Malaysia', '47000')).toBeNull();
    expect(masterPostcodeError('China', null)).toBeNull();
  });
});

describe('supplier', () => {
  test('a new Malaysian supplier without a postcode is refused; a foreign one is saved', async () => {
    const { app } = harness([]);
    const refused = await send(app, 'POST', '/suppliers', { code: '400-K002', name: 'Kilang Dua', country: 'Malaysia' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'postcode_required' });
    const foreign = await send(app, 'POST', '/suppliers', { code: '400-F001', name: 'Foshan Sofa', country: 'China' });
    expect(foreign.status).toBe(201);
    const ok = await send(app, 'POST', '/suppliers', { code: '400-K003', name: 'Kilang Tiga', country: 'Malaysia', postcode: '47000' });
    expect(ok.status).toBe(201);
  });

  test('an old supplier without a postcode can still save other fields, but clearing a postcode is refused', async () => {
    const { app } = harness([
      { id: 's1', code: '400-K001', name: 'Kilang', company_id: CO, status: 'ACTIVE', country: 'Malaysia', postcode: null },
      { id: 's2', code: '400-K004', name: 'Kilang Empat', company_id: CO, status: 'ACTIVE', country: 'Malaysia', postcode: '43000' },
    ]);
    expect((await send(app, 'PATCH', '/suppliers/s1', { name: 'Kilang Baru' })).status).toBe(200);
    const cleared = await send(app, 'PATCH', '/suppliers/s2', { postcode: '' });
    expect(cleared.status).toBe(400);
    expect(await cleared.json()).toMatchObject({ error: 'postcode_required' });
  });
});
