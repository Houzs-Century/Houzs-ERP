// Owner 2026-11-17: a DP job from HOOKKA MANUFACTURING showed Postcode and State
// as a dash — the supplier master writes "47000 SUNGAI BULOH" inside the address
// with the postcode / state columns empty. The postcode is now taken from the
// address (only when my_localities knows it, never when two known ones compete),
// it is compulsory for the job types that are routed by region, and a scheduled
// job's address can still be corrected (its trip stop follows).
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import {
  postcodeCandidates, fillPostcodeFields, localitiesForPostcodes, fillDpRowsPostcode, type LocalityParts,
} from '../src/scm/lib/postcode-from-address';
import { dpOrders, dpEditRefusal, POSTCODE_REQUIRED_JOB_TYPES } from '../src/scm/routes/dp-orders';

const HOOKKA_ADDRESS = '2775F JALAN INDUSTRI 12,, KAMPUNG BARU SUNGAI BULOH,, 47000 SUNGAI BULOH.';
const LOCALITIES = [
  { postcode: '47000', city: 'Sungai Buloh', state: 'Selangor' },
  { postcode: '50450', city: 'Kuala Lumpur', state: 'Kuala Lumpur' },
  // One postcode, two cities: the state is still certain, the city is not.
  { postcode: '81100', city: 'Johor Bahru', state: 'Johor' },
  { postcode: '81100', city: 'Skudai', state: 'Johor' },
];

type Call = { table: string; op: string; payload?: Record<string, unknown>; filters: Array<[string, string, unknown]> };

/* A PostgREST-shaped fake: selects on `tables[name]` honour eq / in, writes echo
   their payload, and every builder is awaitable the way supabase-js is. */
function fakeSupabase(tables: Record<string, Array<Record<string, unknown>>>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, op: 'select', filters: [] };
    const rows = () => (tables[table] ?? []).filter((r) => call.filters.every(([op, col, v]) =>
      op === 'eq' ? r[col] === v : op === 'in' ? (v as unknown[]).includes(r[col]) : op === 'neq' ? r[col] !== v : true));
    const result = (single: boolean) => {
      calls.push(call);
      if (call.op === 'select') {
        const data = rows();
        return { data: single ? data[0] ?? null : data, error: null };
      }
      const hit = rows()[0];
      return { data: hit ? { ...hit, ...call.payload } : null, error: null };
    };
    const q = {
      select: () => q,
      insert: (p: Record<string, unknown>) => { call.op = 'insert'; call.payload = p; return { ...q, maybeSingle: async () => { calls.push(call); return { data: { id: 'dp-new', ...p }, error: null }; } }; },
      update: (p: Record<string, unknown>) => { call.op = 'update'; call.payload = p; return q; },
      eq: (col: string, v: unknown) => { call.filters.push(['eq', col, v]); return q; },
      neq: (col: string, v: unknown) => { call.filters.push(['neq', col, v]); return q; },
      in: (col: string, v: unknown[]) => { call.filters.push(['in', col, v]); return q; },
      is: () => q, order: () => q, limit: () => q, range: () => q,
      maybeSingle: async () => result(true),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(result(false)).then(ok, bad),
    };
    return q;
  };
  return { sb: { from }, calls };
}

function app(tables: Record<string, Array<Record<string, unknown>>>, db?: Record<string, unknown> | null) {
  const fake = fakeSupabase({ my_localities: LOCALITIES, ...tables });
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake.sb as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  a.route('/dp-orders', dpOrders as unknown as Hono);
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => db ?? null }) }) } };
  return { a, calls: fake.calls, env };
}

const send = (x: ReturnType<typeof app>, method: string, path: string, body: unknown) =>
  x.a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, x.env);

const known = new Map<string, LocalityParts>([['47000', { city: 'Sungai Buloh', state: 'Selangor' }], ['50450', { city: 'Kuala Lumpur', state: 'Kuala Lumpur' }]]);

describe('the postcode written in an address', () => {
  test('the HOOKKA address yields 47000 and nothing else', () => {
    expect(postcodeCandidates(HOOKKA_ADDRESS)).toEqual(['47000']);
  });

  test('fills postcode, state and city from the known postcode', () => {
    expect(fillPostcodeFields({ lines: [HOOKKA_ADDRESS], city: null, postcode: null, state: null }, known))
      .toEqual({ postcode: '47000', state: 'Selangor', city: 'Sungai Buloh' });
  });

  test('a stored value is never overwritten', () => {
    expect(fillPostcodeFields({ lines: [HOOKKA_ADDRESS], city: 'Kepong', postcode: '', state: 'Kuala Lumpur' }, known))
      .toEqual({ postcode: '47000', state: 'Kuala Lumpur', city: 'Kepong' });
  });

  test('a number my_localities does not know is not a postcode', () => {
    expect(fillPostcodeFields({ lines: ['12345 Jalan Lama'], city: null, postcode: null, state: null }, known))
      .toEqual({ postcode: null, state: null, city: null });
  });

  test('two known postcodes in one address are ambiguous: nothing is filled', () => {
    expect(fillPostcodeFields({ lines: ['Lot 5, 47000 Sungai Buloh', 'c/o 50450 KL'], city: null, postcode: null, state: null }, known))
      .toEqual({ postcode: null, state: null, city: null });
  });

  test('a postcode with no state gets its state', () => {
    expect(fillPostcodeFields({ lines: [], city: null, postcode: '50450', state: null }, known))
      .toEqual({ postcode: '50450', state: 'Kuala Lumpur', city: 'Kuala Lumpur' });
  });

  test('a postcode spanning two cities keeps the state and leaves the city', async () => {
    const { sb } = fakeSupabase({ my_localities: LOCALITIES });
    const map = await localitiesForPostcodes(sb, ['81100', '47000']);
    expect(map.get('81100')).toEqual({ city: null, state: 'Johor' });
    expect(map.get('47000')).toEqual({ city: 'Sungai Buloh', state: 'Selangor' });
  });

  test('read-time fill shows an old row its postcode without writing', async () => {
    const { sb, calls } = fakeSupabase({ my_localities: LOCALITIES });
    const rows: Array<Record<string, unknown>> = [{ id: 'dp-1', address1: HOOKKA_ADDRESS, city: null, postcode: null, state: null }];
    await fillDpRowsPostcode(sb, rows);
    expect(rows[0]).toMatchObject({ postcode: '47000', state: 'Selangor', city: 'Sungai Buloh' });
    expect(calls.filter((x) => x.op !== 'select')).toEqual([]);
  });
});

describe('POST /dp-orders — postcode detected and required', () => {
  const SUPPLIER = { id: '11111111-1111-1111-1111-111111111111', name: 'HOOKKA MANUFACTURING SDN BHD', address: HOOKKA_ADDRESS, postcode: null, state: null, city: null };

  test('a HOOKKA supplier pickup is saved with 47000 / Selangor without typing', async () => {
    const x = app({ suppliers: [SUPPLIER] });
    const res = await send(x, 'POST', '/dp-orders', { jobType: 'SUPPLIER_PICKUP', supplierId: SUPPLIER.id });
    expect(res.status).toBe(201);
    const insert = x.calls.find((c) => c.op === 'insert')!.payload!;
    expect(insert).toMatchObject({ postcode: '47000', state: 'Selangor', city: 'Sungai Buloh' });
  });

  test('a delivery with no postcode anywhere is refused', async () => {
    const x = app({});
    const res = await send(x, 'POST', '/dp-orders', { jobType: 'DELIVERY', overrides: { address1: 'No 3, Jalan Mawar' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('postcode_required');
    expect(x.calls.filter((c) => c.op === 'insert')).toEqual([]);
  });

  test('lorry service, setup and dismantle do not need a postcode', async () => {
    expect([...POSTCODE_REQUIRED_JOB_TYPES].sort()).toEqual(['DELIVERY', 'INSPECTION', 'PICKUP', 'SERVICE', 'SUPPLIER_PICKUP', 'TRANSFER']);
    for (const jobType of ['LORRY_SERVICE', 'SETUP', 'DISMANTLE']) {
      const x = app({});
      const res = await send(x, 'POST', '/dp-orders', { jobType, overrides: { address1: 'Lot 5, Jalan Kilang' } });
      expect(res.status).toBe(201);
    }
  });

  test('a service case takes the postcode and state of its sales order', async () => {
    const x = app(
      { mfg_sales_orders: [{ doc_no: 'SO-1001', postcode: '50450', customer_state: 'Kuala Lumpur', city: 'Kuala Lumpur' }] },
      { customer_name: 'Tan', phone: '0123', addr1: '8 Jalan Ampang', addr2: null, addr3: null, addr4: null, location: 'KL', doc_no: 'SO-1001' },
    );
    const res = await send(x, 'POST', '/dp-orders', { jobType: 'SERVICE', assrCaseId: 7 });
    expect(res.status).toBe(201);
    expect(x.calls.find((c) => c.op === 'insert')!.payload).toMatchObject({ postcode: '50450', state: 'Kuala Lumpur', city: 'Kuala Lumpur' });
  });
});

describe('PATCH /dp-orders/:id — what can change at which status', () => {
  test('the rule, pure', () => {
    expect(dpEditRefusal('CANCELLED', ['remark'])).toMatch(/cancelled/);
    expect(dpEditRefusal('PENDING_SCHEDULE', ['requested_date', 'address1'])).toBeNull();
    expect(dpEditRefusal('SCHEDULED', ['address1', 'postcode', 'state', 'contact_phone', 'remark'])).toBeNull();
    expect(dpEditRefusal('SCHEDULED', ['requested_date'])).toMatch(/keeps its date/);
  });

  const scheduled = {
    id: 'dp-9', company_id: 1, status: 'SCHEDULED', job_type: 'SUPPLIER_PICKUP', trip_stop_id: 'stop-3',
    party_name: 'HOOKKA MANUFACTURING SDN BHD', address1: 'Old street', address2: null, address3: null, address4: null,
    city: null, postcode: null, state: null,
  };

  test('a scheduled job takes an address fix, detects the postcode, and its trip stop follows', async () => {
    const x = app({ dp_orders: [scheduled], trip_stops: [{ id: 'stop-3', company_id: 1 }] });
    const res = await send(x, 'PATCH', '/dp-orders/dp-9', { address1: HOOKKA_ADDRESS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dpOrder: Record<string, unknown>; tripStop: { updated: boolean } };
    expect(body.dpOrder).toMatchObject({ postcode: '47000', state: 'Selangor' });
    expect(body.tripStop.updated).toBe(true);
    const stopWrite = x.calls.find((c) => c.table === 'trip_stops' && c.op === 'update')!;
    expect(String(stopWrite.payload!.address)).toContain('47000');
    // Company predicate on the stop write, not just its id.
    expect(stopWrite.filters).toContainEqual(['eq', 'company_id', 1]);
  });

  test('a scheduled job keeps its date', async () => {
    const x = app({ dp_orders: [scheduled] });
    const res = await send(x, 'PATCH', '/dp-orders/dp-9', { requestedDate: '2026-12-01' });
    expect(res.status).toBe(409);
    expect(x.calls.filter((c) => c.op === 'update')).toEqual([]);
  });

  test('a cancelled job cannot be edited', async () => {
    const x = app({ dp_orders: [{ ...scheduled, status: 'CANCELLED' }] });
    const res = await send(x, 'PATCH', '/dp-orders/dp-9', { remark: 'x' });
    expect(res.status).toBe(409);
  });

  test('an address edit that leaves no postcode is refused; a remark-only edit is not', async () => {
    const x = app({ dp_orders: [scheduled] });
    const res = await send(x, 'PATCH', '/dp-orders/dp-9', { address1: 'No 3, Jalan Mawar' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('postcode_required');
    const ok = await send(x, 'PATCH', '/dp-orders/dp-9', { remark: 'call first' });
    expect(ok.status).toBe(200);
  });
});
