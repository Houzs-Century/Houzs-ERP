// Owner 2026-11-02 (方案1): a TRANSFER DP order records its ORIGIN ("from where")
// as well as the destination. The origin resolves from our warehouse or a 3PL the
// same way the destination does, lands in the from_* columns, and fromOverrides
// win over the auto-fill. The origin is optional and does NOT satisfy the
// destination's address-required rule.
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { dpOrders } from '../src/scm/routes/dp-orders';

type Call = { table: string; op: string; payload?: Record<string, unknown> };

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

const insertOf = (calls: Call[]) => calls.find((x) => x.op === 'insert')?.payload as Record<string, unknown>;

const UUID_A = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE = { code: 'KL', name: 'KL Warehouse', location: 'Lot 12, Jalan Balakong', city: 'Seri Kembangan', postcode: '43300', state: 'Selangor' };
const THREEPL = { code: '3PL-003', name: 'MSJ TRANSPORT SDN BHD', contact_name: 'Rahman', contact_phone: '0127778888', office_phone: null, address: 'No 3, Jalan Perdagangan, Johor Bahru' };
// A transfer needs a DESTINATION address; supply it by override so the origin is
// the only thing resolved from the (shared) fake master row.
const DEST = { address1: 'Dest street, KL' };

describe('POST /dp-orders — a TRANSFER records its origin (from)', () => {
  test('origin picked as our warehouse fills the from_* columns', async () => {
    const { a, calls } = app(WAREHOUSE);
    const res = await send(a, { jobType: 'TRANSFER', fromWarehouseId: UUID_A, overrides: DEST });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.address1).toBe('Dest street, KL');        // destination untouched
    expect(insert.from_name).toBe('KL Warehouse');
    expect(insert.from_address1).toBe('Lot 12, Jalan Balakong');
    expect(insert.from_city).toBe('Seri Kembangan');
    expect(insert.from_warehouse_id).toBe(UUID_A);
    expect(insert.from_threepl_company_id).toBeNull();
  });

  test('origin picked as an outsourced 3PL fills the from_* columns', async () => {
    const { a, calls } = app(THREEPL);
    const res = await send(a, { jobType: 'TRANSFER', fromThreeplCompanyId: UUID_A, overrides: DEST });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.from_name).toBe('MSJ TRANSPORT SDN BHD');
    expect(insert.from_address1).toBe('No 3, Jalan Perdagangan, Johor Bahru');
    expect(insert.from_threepl_company_id).toBe(UUID_A);
    expect(insert.from_warehouse_id).toBeNull();
  });

  test('fromOverrides win over the auto-filled origin', async () => {
    const { a, calls } = app(WAREHOUSE);
    const res = await send(a, {
      jobType: 'TRANSFER', fromWarehouseId: UUID_A, overrides: DEST,
      fromOverrides: { party_name: 'Typed Origin', address1: 'Typed Origin Street' },
    });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.from_name).toBe('Typed Origin');
    expect(insert.from_address1).toBe('Typed Origin Street');
  });

  test('a non-TRANSFER job never carries an origin', async () => {
    const { a, calls } = app(null);
    const res = await send(a, { jobType: 'SETUP', overrides: { address1: 'Hall A, KLCC' } });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.from_name).toBeNull();
    expect(insert.from_address1).toBeNull();
    expect(insert.from_warehouse_id).toBeNull();
  });
});

const SAVEDLOC = {
  name: 'Sunway Loading Bay', contact_name: 'Mr Lee', contact_phone: '0123334444',
  address1: 'Lot B1, Jalan PJS 11/15', address2: 'Bandar Sunway', city: 'Petaling Jaya', postcode: '47500', state: 'Selangor',
};

describe('POST /dp-orders — a TRANSFER can pick a saved location (方案2)', () => {
  test('destination from a saved location fills the party + records the ref', async () => {
    const { a, calls } = app(SAVEDLOC);
    const res = await send(a, { jobType: 'TRANSFER', savedLocationId: UUID_A });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.saved_location_id).toBe(UUID_A);
    expect(insert.party_name).toBe('Sunway Loading Bay');
    expect(insert.address1).toBe('Lot B1, Jalan PJS 11/15');
    expect(insert.city).toBe('Petaling Jaya');
  });

  test('origin from a saved location fills the from_* columns + records the ref', async () => {
    const { a, calls } = app(SAVEDLOC);
    const res = await send(a, { jobType: 'TRANSFER', fromSavedLocationId: UUID_A, overrides: DEST });
    expect(res.status).toBe(201);
    const insert = insertOf(calls);
    expect(insert.address1).toBe('Dest street, KL');          // destination from override
    expect(insert.from_saved_location_id).toBe(UUID_A);
    expect(insert.from_name).toBe('Sunway Loading Bay');
    expect(insert.from_address1).toBe('Lot B1, Jalan PJS 11/15');
    expect(insert.from_city).toBe('Petaling Jaya');
  });
});
