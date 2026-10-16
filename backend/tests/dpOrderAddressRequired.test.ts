// Owner decision 2026-10-05 (Weisiang): "delivery job shouldn't able to save
// with no address". Route-level: a DP order create, or an edit that blanks the
// address, is refused before anything is written. An edit that leaves the
// address alone still goes through, so an old job that already has none can
// have its date or remark fixed.
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { dpOrders } from '../src/scm/routes/dp-orders';

type Call = { table: string; op: string; payload?: unknown };

function fakeSupabase(current: Record<string, unknown> | null) {
  const calls: Call[] = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: unknown;
    const q = {
      select: () => q,
      insert: (p: unknown) => { op = 'insert'; payload = p; return q; },
      update: (p: unknown) => { op = 'update'; payload = p; return q; },
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

function app(current: Record<string, unknown> | null = null) {
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

const send = (a: Hono, method: string, path: string, body: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});

const writes = (calls: Call[]) => calls.filter((x) => x.op !== 'select');

describe('POST /dp-orders — a delivery job needs an address', () => {
  test('a manual job with no address is refused and nothing is inserted', async () => {
    const { a, calls } = app();
    const res = await send(a, 'POST', '/dp-orders', { jobType: 'SETUP', overrides: { party_name: 'Hall A' } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('address_required');
    expect(writes(calls)).toEqual([]);
  });

  test('whitespace and a city alone do not count as an address', async () => {
    const { a, calls } = app();
    const res = await send(a, 'POST', '/dp-orders', {
      jobType: 'DELIVERY', overrides: { address1: '   ', city: 'Puchong', state: 'Selangor' },
    });
    expect(res.status).toBe(400);
    expect(writes(calls)).toEqual([]);
  });

  test('a job with an address line is created', async () => {
    const { a, calls } = app();
    const res = await send(a, 'POST', '/dp-orders', { jobType: 'LORRY_SERVICE', overrides: { address2: 'Lot 5, Jalan Kilang' } });
    expect(res.status).toBe(201);
    expect(writes(calls)).toHaveLength(1);
  });
});

describe('PATCH /dp-orders/:id — blanking the address is refused', () => {
  test('clearing the only address line is refused and nothing is updated', async () => {
    const { a, calls } = app({ address1: '12 Jalan Kenari', address2: null, address3: null, address4: null });
    const res = await send(a, 'PATCH', '/dp-orders/dp-1', { address1: ' ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('address_required');
    expect(writes(calls)).toEqual([]);
  });

  test('clearing line 1 while line 2 still holds the address is allowed', async () => {
    const { a, calls } = app({ address1: 'Unit 3', address2: '12 Jalan Kenari', address3: null, address4: null });
    const res = await send(a, 'PATCH', '/dp-orders/dp-1', { address1: null });
    expect(res.status).toBe(200);
    expect(writes(calls)).toHaveLength(1);
  });

  test('an edit that does not touch the address is not blocked, even on an old job with none', async () => {
    const { a, calls } = app({ address1: null, address2: null, address3: null, address4: null });
    const res = await send(a, 'PATCH', '/dp-orders/dp-1', { remark: 'call first' });
    expect(res.status).toBe(200);
    expect(writes(calls)).toHaveLength(1);
  });
});
