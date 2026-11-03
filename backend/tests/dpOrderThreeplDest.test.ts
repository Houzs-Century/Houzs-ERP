// Owner 2026-11-02 ("方案 B"): a TRANSFER DP order can go to an OUTSOURCED
// warehouse — a 3PL company that is not in scm.warehouses. Route-level: a create
// carrying threeplCompanyId fills its party/address from scm.threepl_companies
// and records the carrier on threepl_company_id, with party_type still WAREHOUSE.
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { dpOrders } from '../src/scm/routes/dp-orders';

type Call = { table: string; op: string; payload?: Record<string, unknown> };

/* Every select returns `current` (the 3PL master row the resolver reads); every
   write echoes its payload back as the saved row. The address-required test uses
   the same shape — kept local so the two files do not share a helper. */
function fakeSupabase(current: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: Record<string, unknown> | undefined;
    const q = {
      select: () => q,
      insert: (p: Record<string, unknown>) => { op = 'insert'; payload = p; return q; },
      update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return q; },
      eq: () => q, neq: () => q, in: () => q,
      maybeSingle: async () => {
        calls.push({ table, op, payload });
        if (op === 'select') return { data: current, error: null };
        return { data: { id: 'dp-1', ...(payload as object) }, error: null };
      },
    };
    return q;
  };
  return { sb: { from }, calls };
}

function app(current: Record<string, unknown> | null) {
  const fake = fakeSupabase(current);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake.sb as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  a.route('/dp-orders', dpOrders as unknown as Hono);
  return { a, calls: fake.calls };
}

const send = (a: Hono, body: unknown) =>
  a.request('/dp-orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});

const THREEPL = '11111111-1111-1111-1111-111111111111';

describe('POST /dp-orders — TRANSFER to an outsourced (3PL) warehouse', () => {
  test('fills the party/address from the 3PL master and records the carrier', async () => {
    const { a, calls } = app({
      code: '3PL-003', name: 'MSJ TRANSPORT SDN BHD',
      contact_name: 'Encik Rahman', contact_phone: '0127778888', office_phone: '075551234',
      address: 'No 3, Jalan Perdagangan, Johor Bahru',
    });
    const res = await send(a, { jobType: 'TRANSFER', threeplCompanyId: THREEPL });
    expect(res.status).toBe(201);

    const insert = calls.find((x) => x.op === 'insert')?.payload as Record<string, unknown>;
    expect(insert).toBeTruthy();
    expect(insert.threepl_company_id).toBe(THREEPL);
    expect(insert.warehouse_id).toBeNull();
    expect(insert.party_type).toBe('WAREHOUSE');
    expect(insert.party_name).toBe('MSJ TRANSPORT SDN BHD');
    expect(insert.address1).toBe('No 3, Jalan Perdagangan, Johor Bahru');
  });

  test('a 3PL destination with no address on file is refused — nothing is inserted', async () => {
    const { a, calls } = app({
      code: '3PL-009', name: 'NO ADDRESS CARRIER',
      contact_name: null, contact_phone: null, office_phone: null, address: null,
    });
    const res = await send(a, { jobType: 'TRANSFER', threeplCompanyId: THREEPL });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('address_required');
    expect(calls.filter((x) => x.op === 'insert')).toEqual([]);
  });
});
