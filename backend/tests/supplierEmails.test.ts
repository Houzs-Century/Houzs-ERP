/* A supplier's Email, Email 2 and Email 3 (owner 2026-11-09: "supplier email
   needs email 2 and 3"). Pinned on the real handlers over fake PostgREST:
     • create and save take all three, trimmed, blank = cleared;
     • a value that is not one valid address is refused, naming the field, and
       nothing is written;
     • an old free-text email sent back UNCHANGED does not block saving the
       supplier's other fields;
     • the detail read returns Email 2 / Email 3. */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { createSupplierHandler, getSupplierHandler, patchSupplierHandler, supplierEmailWrites } from '../src/scm/routes/suppliers';

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
  app.get('/suppliers/:id', getSupplierHandler as never);
  app.post('/suppliers', createSupplierHandler as never);
  app.patch('/suppliers/:id', patchSupplierHandler as never);
  return { app, sb };
}
const send = (app: Hono, method: 'POST' | 'PATCH', url: string, body: Row) =>
  app.request(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const base = (over: Row = {}): Row => ({ id: 's1', code: '400-K001', name: 'Kilang', company_id: CO, status: 'ACTIVE', email: 'a@k.com', email2: null, email3: null, ...over });

describe('supplier Email 2 / Email 3 — save', () => {
  test('a save stores Email 2 and Email 3 trimmed; blank clears', async () => {
    const { app } = harness([base({ email3: 'old@k.com' })]);
    const res = await send(app, 'PATCH', '/suppliers/s1', { email: 'a@k.com', email2: '  b@k.com ', email3: '' });
    expect(res.status).toBe(200);
    const { supplier } = await res.json() as { supplier: Row };
    expect(supplier).toMatchObject({ email: 'a@k.com', email2: 'b@k.com', email3: null });
  });

  test('an invalid Email 3 is refused, naming the field, and nothing is written', async () => {
    const { app } = harness([base()]);
    const res = await send(app, 'PATCH', '/suppliers/s1', { name: 'Kilang Baru', email2: 'b@k.com', email3: 'b@k.com, c@k.com' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('invalid_email');
    expect(body.message).toContain('Email 3');
    const after = await (await app.request('/suppliers/s1')).json() as { supplier: Row };
    expect(after.supplier).toMatchObject({ name: 'Kilang', email2: null, email3: null });
  });

  test('an old free-text Email sent back unchanged does not block the save', async () => {
    const { app } = harness([base({ email: 'a@k.com / b@k.com' })]);
    const res = await send(app, 'PATCH', '/suppliers/s1', { name: 'Kilang Baru', email: 'a@k.com / b@k.com', email2: 'c@k.com' });
    expect(res.status).toBe(200);
    const { supplier } = await res.json() as { supplier: Row };
    expect(supplier).toMatchObject({ name: 'Kilang Baru', email: 'a@k.com / b@k.com', email2: 'c@k.com' });
  });

  test('changing the main Email to something invalid is refused', async () => {
    const { app } = harness([base()]);
    const res = await send(app, 'PATCH', '/suppliers/s1', { email: 'a@k' });
    expect(res.status).toBe(400);
  });

  test('create takes all three and refuses a bad one', async () => {
    const { app } = harness([]);
    const bad = await send(app, 'POST', '/suppliers', { code: '400-N1', name: 'New', email: 'n@k.com', email2: 'nope' });
    expect(bad.status).toBe(400);
    const ok = await send(app, 'POST', '/suppliers', { code: '400-N1', name: 'New', email: ' n@k.com', email2: 'm@k.com', email3: '  ' });
    expect(ok.status).toBe(201);
    const { supplier } = await ok.json() as { supplier: Row };
    expect(supplier).toMatchObject({ email: 'n@k.com', email2: 'm@k.com', email3: null });
  });

  test('the detail read returns Email 2 and Email 3', async () => {
    const { app } = harness([base({ email2: 'b@k.com', email3: 'c@k.com' })]);
    const { supplier } = await (await app.request('/suppliers/s1')).json() as { supplier: Row };
    expect(supplier).toMatchObject({ email: 'a@k.com', email2: 'b@k.com', email3: 'c@k.com' });
  });
});

describe('supplierEmailWrites', () => {
  test('only the fields sent are written', () => {
    expect(supplierEmailWrites({ name: 'x' }, null)).toEqual({ ok: true, writes: {} });
    expect(supplierEmailWrites({ email2: null }, { email2: 'b@k.com' })).toEqual({ ok: true, writes: { email2: null } });
  });
});
