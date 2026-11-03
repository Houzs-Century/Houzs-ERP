// Owner 2026-11-02 (方案2): the saved "common locations" address book. Route-level
// rules: a location needs an address (create and an edit that blanks it are
// refused), create stamps the active company, and a duplicate name is a 409.
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../src/scm/middleware/auth', () => ({
  supabaseAuth: async (_c: unknown, next: () => Promise<void>) => { await next(); },
}));

import { savedLocations } from '../src/scm/routes/saved-locations';

type Call = { table: string; op: string; payload?: Record<string, unknown> };

/* current = the row a select returns (the PATCH address-check read); writes echo
   their payload back as the saved row, with a dup-name error when `dup` is set. */
function fakeSupabase(current: Record<string, unknown> | null, dup = false) {
  const calls: Call[] = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: Record<string, unknown> | undefined;
    const q = {
      select: () => q,
      insert: (p: Record<string, unknown>) => { op = 'insert'; payload = p; return q; },
      update: (p: Record<string, unknown>) => { op = 'update'; payload = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: () => q, neq: () => q, in: () => q, order: () => q, range: () => q,
      not: () => q,
      single: async () => {
        calls.push({ table, op, payload });
        if (dup) return { data: null, error: { code: '23505', message: 'saved_locations_name_uq' } };
        return { data: { id: 'loc-1', ...(payload as object) }, error: null };
      },
      maybeSingle: async () => {
        calls.push({ table, op, payload });
        if (op === 'select') return { data: current, error: null };
        if (dup) return { data: null, error: { code: '23505', message: 'saved_locations_name_uq' } };
        return { data: { id: 'loc-1', ...(payload as object) }, error: null };
      },
    };
    return q;
  };
  return { sb: { from }, calls };
}

function app(current: Record<string, unknown> | null = null, dup = false) {
  const fake = fakeSupabase(current, dup);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, fake.sb as never);
    c.set('companyId' as never, 1 as never);
    await next();
  });
  a.route('/saved-locations', savedLocations as unknown as Hono);
  return { a, calls: fake.calls };
}

const send = (a: Hono, method: string, path: string, body: unknown) =>
  a.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {});

const writes = (calls: Call[]) => calls.filter((x) => x.op === 'insert' || x.op === 'update' || x.op === 'delete');

describe('POST /saved-locations — a location needs an address', () => {
  test('no address line is refused, nothing inserted', async () => {
    const { a, calls } = app();
    const res = await send(a, 'POST', '/saved-locations', { name: 'Nowhere', city: 'PJ', state: 'Selangor' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('address_required');
    expect(writes(calls)).toEqual([]);
  });

  test('with an address line it is created and stamps the company', async () => {
    const { a, calls } = app();
    const res = await send(a, 'POST', '/saved-locations', {
      name: 'Sunway Loading Bay', address1: 'Lot B1, Jalan PJS 11/15', city: 'Petaling Jaya', state: 'Selangor',
    });
    expect(res.status).toBe(201);
    const insert = calls.find((x) => x.op === 'insert')?.payload as Record<string, unknown>;
    expect(insert.company_id).toBe(1);
    expect(insert.name).toBe('Sunway Loading Bay');
    expect(insert.address1).toBe('Lot B1, Jalan PJS 11/15');
  });

  test('a duplicate name is a 409', async () => {
    const { a } = app(null, true);
    const res = await send(a, 'POST', '/saved-locations', { name: 'Dup', address1: 'X' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('duplicate_name');
  });
});

describe('PATCH /saved-locations/:id — cannot blank the address', () => {
  test('clearing the only address line is refused', async () => {
    const { a, calls } = app({ address1: '12 Jalan Kenari', address2: null });
    const res = await send(a, 'PATCH', '/saved-locations/loc-1', { address1: ' ' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('address_required');
    expect(writes(calls)).toEqual([]);
  });

  test('an edit that leaves the address alone goes through', async () => {
    const { a, calls } = app({ address1: '12 Jalan Kenari', address2: null });
    const res = await send(a, 'PATCH', '/saved-locations/loc-1', { contactName: 'New PIC' });
    expect(res.status).toBe(200);
    expect(writes(calls)).toHaveLength(1);
  });
});
