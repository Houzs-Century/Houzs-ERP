/* The printable case copies print the service case's address in the SO's shape. */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const detail = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../services/assr', () => ({ getAssrDetail: async () => detail.current }));
vi.mock('../services/assrVisibility', () => ({
  assrCaseRowInScope: async () => true,
  assrCallerIsScoped: async () => false,
  stripCreditorFields: () => {},
}));
vi.mock('../services/assrSupplierReturns', () => ({
  earlierSupplierReturns: () => [],
  ensureFirstSupplierReturn: async () => {},
  listSupplierReturns: async () => [],
}));
vi.mock('../scm/lib/companyScope', () => ({ allowedCompanyIds: () => undefined }));
const addr = vi.hoisted(() => ({ current: { postcode: null, city: null, state: null } as Record<string, string | null> }));
vi.mock('../services/assrCaseAddress', () => ({ getCaseAddress: async () => addr.current }));

import assrPrint from './assr_print';

const stmt = { bind: () => stmt, all: async () => ({ results: [] }), first: async () => null };
const ENV = { DB: { prepare: () => stmt }, POD_BUCKET: { get: async () => null } };

function caseWith(over: Record<string, unknown>) {
  return {
    case: {
      id: 7, company_id: 1, assr_no: 'ASSR-2610-001', stage: 'pending_review',
      customer_name: 'Test Customer', doc_no: 'HC-SO-013900', po_no: null, order_pos: [],
      ...over,
    },
    items: [], attachments: [], activity: [], logistics: null, supplier_returns: [],
  };
}

async function print(variant: 'office' | 'supplier' | 'customer', query = '') {
  const app = new Hono<{ Variables: { user: { id: number; permissions: string[] } } }>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 1, permissions: ['service_cases.read'] });
    await next();
  });
  app.route('/', assrPrint as unknown as Hono<{ Variables: { user: { id: number; permissions: string[] } } }>);
  const res = await app.request(`/7?variant=${variant}${query}`, {}, ENV);
  expect(res.status).toBe(200);
  return res.text();
}

describe('ASSR print — the address in the SO format (owner 2026-11-17)', () => {
  it('prints lines, postcode + city, state on the office and customer copies', async () => {
    detail.current = caseWith({ addr1: '1-G-9 Halaman Teratai', addr2: 'Lebuh Nipah 2', addr3: null, addr4: null, location: null });
    addr.current = { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' };
    const want = 'Address</div><div class="vc span3">1-G-9 Halaman Teratai, Lebuh Nipah 2, 11900 Bayan Lepas, Pulau Pinang<';
    expect(await print('office')).toContain(want);
    expect(await print('customer')).toContain(want);
  });

  it('an old case whose lines hold the postcode does not print it twice', async () => {
    detail.current = caseWith({ addr1: '1-G-9 Halaman Teratai', addr2: 'lebuh nipah 2', addr3: '11900 Bayan Lepas', addr4: null });
    addr.current = { postcode: '11900', city: 'Bayan Lepas', state: 'Pulau Pinang' };
    expect(await print('office')).toContain('>1-G-9 Halaman Teratai, lebuh nipah 2, 11900 Bayan Lepas, Pulau Pinang<');
  });

  it("the supplier copy's Delivery Area falls back to the case State, then line 4", async () => {
    detail.current = caseWith({ addr1: 'x', addr4: 'Johor', location: null });
    addr.current = { postcode: null, city: null, state: 'Pulau Pinang' };
    expect(await print('supplier')).toContain('Delivery Area</div><div class="vc">Pulau Pinang<');
    addr.current = { postcode: null, city: null, state: null };
    expect(await print('supplier')).toContain('Delivery Area</div><div class="vc">Johor<');
  });
});
