/* A 3PL company is linked to the supplier it bills as (owner 2026-11-11:
   「这里的 3pl supplier 其实是要 link with 我的 other supplier 的」), on the real
   handlers over fake PostgREST:
     • the list carries each carrier's supplier (code + name), null where none;
     • a carrier is created linked, and its link is changed and removed;
     • a supplier of another company is refused (400 supplier_not_found);
     • a supplier another carrier of this company holds is refused, naming that
       carrier (409 supplier_linked_elsewhere);
     • a failed supplier read is a 500, never an empty link. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { threeplCompanies } from '../src/scm/routes/threepl-companies';

const CO = 1;
const SUP_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SUP_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SUP_OTHER_CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CAR_A = '11111111-1111-4111-8111-111111111111';
const CAR_B = '22222222-2222-4222-8222-222222222222';

function harness(missing: Record<string, string[]> = {}) {
  const sb = fakeSb({
    suppliers: [
      { id: SUP_A, company_id: CO, code: '400-X001', name: 'CARRIER A SDN BHD' },
      { id: SUP_B, company_id: CO, code: '400-X002', name: 'CARRIER B SDN BHD' },
      { id: SUP_OTHER_CO, company_id: 2, code: '400-X009', name: 'OTHER CO SUPPLIER' },
    ],
    threepl_companies: [
      { id: CAR_A, company_id: CO, code: '3PL-001', name: 'CARRIER A', is_active: true, supplier_id: SUP_A },
      { id: CAR_B, company_id: CO, code: '3PL-002', name: 'CARRIER B', is_active: true, supplier_id: null },
      { id: '33333333-3333-4333-8333-333333333333', company_id: 2, code: '3PL-001', name: 'OTHER CO CARRIER', is_active: true, supplier_id: SUP_OTHER_CO },
    ],
  }, missing);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { id: 7, permissions_set: new Set<string>() } as never);
    await next();
  });
  app.route('/threepl-companies', threeplCompanies as unknown as Hono);
  const req = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, {});
  return { req, tables: (sb as unknown as { tables: Record<string, Row[]> }).tables };
}

type Supplier = { id: string; code: string; name: string } | null;
type Company = { id: string; name: string; supplier: Supplier };
const linkOf = (tables: Record<string, Row[]>, id: string) => tables.threepl_companies.find((r) => r.id === id)?.supplier_id ?? null;

describe('the 3PL company list', () => {
  test('carries each carrier\'s supplier, and null where none is linked', async () => {
    const { req } = harness();
    const res = await req('/threepl-companies', 'GET');
    expect(res.status).toBe(200);
    const { companies } = await res.json() as { companies: Company[] };
    expect(companies.map((c) => [c.name, c.supplier])).toEqual([
      ['CARRIER A', { id: SUP_A, code: '400-X001', name: 'CARRIER A SDN BHD' }],
      ['CARRIER B', null],
    ]);
  });

  test('a supplier read that fails is a 500, not a carrier with no supplier', async () => {
    const { req } = harness({ suppliers: ['code'] });
    const res = await req('/threepl-companies', 'GET');
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toBe('fetch_failed');
  });
});

describe('linking a 3PL company to a supplier', () => {
  test('a new company is created linked to its supplier', async () => {
    const { req, tables } = harness();
    const res = await req('/threepl-companies', 'POST', { name: 'CARRIER C', supplierId: SUP_B });
    expect(res.status).toBe(201);
    const { company } = await res.json() as { company: Company };
    expect(company.supplier).toEqual({ id: SUP_B, code: '400-X002', name: 'CARRIER B SDN BHD' });
    expect(linkOf(tables, company.id)).toBe(SUP_B);

    const plain = await req('/threepl-companies', 'POST', { name: 'CARRIER D', supplierId: null });
    expect(plain.status).toBe(201);
    expect((await plain.json() as { company: Company }).company.supplier).toBeNull();
  });

  test('a link is set, kept by an edit that does not name it, and removed', async () => {
    const { req, tables } = harness();
    const linked = await req(`/threepl-companies/${CAR_B}`, 'PATCH', { supplierId: SUP_B });
    expect(linked.status).toBe(200);
    expect((await linked.json() as { company: Company }).company.supplier).toEqual({ id: SUP_B, code: '400-X002', name: 'CARRIER B SDN BHD' });
    expect(linkOf(tables, CAR_B)).toBe(SUP_B);

    /* An edit that does not name the supplier leaves it, and still reports it. */
    const renamed = await req(`/threepl-companies/${CAR_B}`, 'PATCH', { contactName: 'CONTACT A' });
    expect(renamed.status).toBe(200);
    expect((await renamed.json() as { company: Company }).company.supplier?.id).toBe(SUP_B);
    expect(linkOf(tables, CAR_B)).toBe(SUP_B);

    const unlinked = await req(`/threepl-companies/${CAR_B}`, 'PATCH', { supplierId: null });
    expect(unlinked.status).toBe(200);
    expect((await unlinked.json() as { company: Company }).company.supplier).toBeNull();
    expect(linkOf(tables, CAR_B)).toBeNull();
  });

  test('a supplier of another company is refused, on create and on edit', async () => {
    const { req, tables } = harness();
    const created = await req('/threepl-companies', 'POST', { name: 'CARRIER E', supplierId: SUP_OTHER_CO });
    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({ error: 'supplier_not_found' });
    expect(tables.threepl_companies.some((r) => r.name === 'CARRIER E')).toBe(false);

    const edited = await req(`/threepl-companies/${CAR_B}`, 'PATCH', { supplierId: SUP_OTHER_CO });
    expect(edited.status).toBe(400);
    expect(await edited.json()).toMatchObject({ error: 'supplier_not_found' });
    expect(linkOf(tables, CAR_B)).toBeNull();

    expect((await req(`/threepl-companies/${CAR_B}`, 'PATCH', { supplierId: 'not-a-supplier' })).status).toBe(400);
  });

  test('a supplier another carrier holds is refused, naming that carrier', async () => {
    const { req, tables } = harness();
    const edited = await req(`/threepl-companies/${CAR_B}`, 'PATCH', { supplierId: SUP_A });
    expect(edited.status).toBe(409);
    const body = await edited.json() as { error: string; reason: string };
    expect(body.error).toBe('supplier_linked_elsewhere');
    expect(body.reason).toContain('CARRIER A');
    expect(body.reason.length).toBeLessThan(200);
    expect(linkOf(tables, CAR_B)).toBeNull();

    const created = await req('/threepl-companies', 'POST', { name: 'CARRIER F', supplierId: SUP_A });
    expect(created.status).toBe(409);
    expect(tables.threepl_companies.some((r) => r.name === 'CARRIER F')).toBe(false);

    /* The carrier that holds it may save it again. */
    expect((await req(`/threepl-companies/${CAR_A}`, 'PATCH', { supplierId: SUP_A })).status).toBe(200);
  });
});
