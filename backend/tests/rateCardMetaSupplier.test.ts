/* Carriers & Rates carrier list (owner 2026-11-11: 「3pl supplier 其实是要 link
   with 我的 other supplier」): GET /delivery-rate-cards/meta names, for each 3PL
   company, the supplier it bills as (code and name from the company's own
   supplier master), or null when none is linked. On the real handler over fake
   PostgREST; every name here is made up. */
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { fakeSb, type Row } from '../src/scm/lib/fake-postgrest';
import { deliveryRateCards } from '../src/scm/routes/delivery-rate-cards';

const CO = 1;
function harness(tables: Record<string, Row[]>) {
  const sb = fakeSb({ lorries: [], ...tables });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('houzsUser' as never, { id: 7, permissions_set: new Set<string>() } as never);
    await next();
  });
  app.route('/delivery-rate-cards', deliveryRateCards as unknown as Hono);
  return (path: string) => app.request(path, { method: 'GET' }, {});
}

describe('GET /delivery-rate-cards/meta', () => {
  test('gives each 3PL company the supplier it bills as, or null', async () => {
    const get = harness({
      threepl_companies: [
        { id: 'car-a', company_id: CO, name: 'ALPHA LOGISTICS', is_active: true, supplier_id: 'sup-a' },
        { id: 'car-b', company_id: CO, name: 'BETA HAULAGE', is_active: true, supplier_id: null },
        /* Linked to another company's supplier: not this company's to show. */
        { id: 'car-c', company_id: CO, name: 'GAMMA FREIGHT', is_active: true, supplier_id: 'sup-z' },
        { id: 'car-d', company_id: CO, name: 'DELTA OLD', is_active: false, supplier_id: 'sup-a' },
      ],
      suppliers: [
        { id: 'sup-a', company_id: CO, code: '400-A001', name: 'ALPHA LOGISTICS SDN BHD' },
        { id: 'sup-z', company_id: 2, code: '400-Z009', name: 'ZETA SUPPLIES' },
      ],
    });
    const res = await get('/delivery-rate-cards/meta');
    expect(res.status).toBe(200);
    const body = await res.json() as { companies: unknown[] };
    expect(body.companies).toEqual([
      { id: 'car-a', name: 'ALPHA LOGISTICS', supplier: { code: '400-A001', name: 'ALPHA LOGISTICS SDN BHD' } },
      { id: 'car-b', name: 'BETA HAULAGE', supplier: null },
      { id: 'car-c', name: 'GAMMA FREIGHT', supplier: null },
    ]);
  });
});
