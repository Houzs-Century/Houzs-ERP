// Owner 2026-11-17: three same-lorry SUPPLIER_PICKUP DP orders rode ONE run
// (same lorry + day = one scm.trips row). The board's inline Driver cell wrote
// the RUN's crew, so changing one job's driver flipped all three. The fix: a
// crew edit on a DP that SHARES its run peels THAT job onto its own run, then
// sets the seat there — the shared run (and its other jobs) is never re-crewed.
// A job alone on its run is still edited in place.
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

// The caller is ops/dispatch (unscoped) — the ownership guard passes without a
// fleet-row lookup, so the test exercises the peel, not the row scope.
vi.mock('../src/scm/lib/deliveryScope', async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  resolveDeliveryScope: async () => ({ mode: 'all' }),
}));

import { dpOrders } from '../src/scm/routes/dp-orders';

type Filter = { m: string; col: string; val: unknown };
type Call = { table: string; op: string; columns: string | null; filters: Filter[]; payload?: Record<string, unknown> };

/* A fake PostgREST client that records every awaited query and answers from the
   fixtures a test supplies. The builder is thenable (array reads await it
   directly) and also offers maybeSingle/single (row reads). */
function fakeSupabase(opts: {
  dp: Record<string, unknown>;
  siblingStops: Array<{ id: string }>;      // OTHER stops on the current run
  foundTripId: string | null;               // trips find-by-lorry hit (resolveScheduleTrip)
}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const st = { table, op: 'select', columns: null as string | null, filters: [] as Filter[], payload: undefined as Record<string, unknown> | undefined };
    const resolve = (single: boolean) => {
      calls.push({ table: st.table, op: st.op, columns: st.columns, filters: st.filters, payload: st.payload });
      if (st.op !== 'select') return { data: single ? { id: 'x', ...(st.payload ?? {}) } : null, error: null };
      if (st.table === 'dp_orders') return { data: single ? opts.dp : [opts.dp], error: null };
      if (st.table === 'trip_stops') {
        const cols = st.columns ?? '';
        if (cols.includes('stop_no')) return { data: [], error: null };          // new run: empty → stop_no 1
        return { data: opts.siblingStops, error: null };                          // 'id' → sibling count
      }
      if (st.table === 'trips') {
        if ((st.columns ?? '').includes('lorry_id')) return { data: single ? { lorry_id: null } : [], error: null };
        return { data: opts.foundTripId ? [{ id: opts.foundTripId }] : [], error: null }; // find-by-lorry
      }
      return { data: single ? null : [], error: null };
    };
    const q = {
      select: (cols?: string) => { st.columns = cols ?? null; return q; },
      insert: (p: Record<string, unknown>) => { st.op = 'insert'; st.payload = p; return q; },
      update: (p: Record<string, unknown>) => { st.op = 'update'; st.payload = p; return q; },
      eq: (col: string, val: unknown) => { st.filters.push({ m: 'eq', col, val }); return q; },
      neq: (col: string, val: unknown) => { st.filters.push({ m: 'neq', col, val }); return q; },
      in: (col: string, val: unknown) => { st.filters.push({ m: 'in', col, val }); return q; },
      limit: () => q, order: () => q,
      maybeSingle: async () => resolve(true),
      single: async () => resolve(true),
      then: (onF: (v: { data: unknown; error: null }) => unknown) => Promise.resolve(resolve(false)).then(onF),
    };
    return q;
  };
  return { sb: { from }, calls };
}

function app(fake: ReturnType<typeof fakeSupabase>) {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake.sb as never);
    c.set('companyId' as never, 1 as never);
    c.set('user' as never, { id: 'u-1' } as never);
    c.set('houzsUser' as never, { id: 1 } as never);
    await next();
  });
  a.route('/dp-orders', dpOrders as unknown as Hono);
  return a;
}

const post = (a: Hono, id: string, body: unknown) =>
  a.request(`/dp-orders/${id}/crew`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});

const DP = {
  id: 'dp-1', requested_date: '2026-11-18', trip_id: 'trip-shared', trip_stop_id: 'stop-own',
  dp_no: 'DP-261118-VRM01', status: 'SCHEDULED', job_type: 'SUPPLIER_PICKUP', party_name: 'HOOKKA',
  address1: 'A', address2: null, address3: null, address4: null, city: 'KL', postcode: '50000', state: 'KUALA LUMPUR',
};

const tripsUpdates = (calls: Call[]) => calls.filter((x) => x.table === 'trips' && x.op === 'update');
const idOf = (c: Call) => c.filters.find((f) => f.m === 'eq' && f.col === 'id')?.val;

describe('POST /dp-orders/:id/crew — peel a shared run', () => {
  test('a crew edit on a SHARED run moves only this job; the shared run is never re-crewed', async () => {
    const fake = fakeSupabase({ dp: { ...DP }, siblingStops: [{ id: 'stop-sibling' }], foundTripId: 'trip-B' });
    const res = await post(app(fake), 'dp-1', { lorryId: '22222222-2222-2222-2222-222222222222' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { trip_id: string }).trip_id).toBe('trip-B');

    // The stop was moved onto the peeled run, and the order re-pointed to it.
    const stopMove = fake.calls.find((x) => x.table === 'trip_stops' && x.op === 'update');
    expect(stopMove?.payload?.trip_id).toBe('trip-B');
    expect(idOf(stopMove!)).toBe('stop-own');
    const dpMove = fake.calls.find((x) => x.table === 'dp_orders' && x.op === 'update');
    expect(dpMove?.payload?.trip_id).toBe('trip-B');

    // The crew write landed on the PEELED run only — the shared run is untouched.
    const crewWrites = tripsUpdates(fake.calls);
    expect(crewWrites.length).toBe(1);
    expect(idOf(crewWrites[0]!)).toBe('trip-B');
    expect(crewWrites.some((c) => idOf(c) === 'trip-shared')).toBe(false);
  });

  test('a crew edit on a run this job has to itself is applied IN PLACE (no peel)', async () => {
    const fake = fakeSupabase({ dp: { ...DP }, siblingStops: [], foundTripId: null });
    const res = await post(app(fake), 'dp-1', { driverId: '33333333-3333-3333-3333-333333333333' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { trip_id: string }).trip_id).toBe('trip-shared');

    // No stop was moved, and the driver was written straight onto the existing run.
    expect(fake.calls.some((x) => x.table === 'trip_stops' && x.op === 'update')).toBe(false);
    const crewWrites = tripsUpdates(fake.calls);
    expect(crewWrites.length).toBe(1);
    expect(idOf(crewWrites[0]!)).toBe('trip-shared');
    expect(crewWrites[0]!.payload?.driver_id).toBe('33333333-3333-3333-3333-333333333333');
  });
});
