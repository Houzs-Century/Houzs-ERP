// Company scoping on the TMS (trips) by-id WRITE paths.
//
// WHY THESE EXIST. trips is a CROSS-COMPANY module: GET / widens to the
// caller's ALLOWED companies (`scopeToAllowedCompanies` -> `.in('company_id',
// allowed)`) so one dispatcher can work a shared queue. Every by-id WRITE,
// however, filtered on the uuid alone. The list you can see was bounded and the
// write was not, which is the whole leak in one sentence.
//
// It is worth being explicit about what was NOT protecting these paths, because
// the code reads as though something was:
//   · `if (error.code === '42501') ... 403` in PATCH /:id looks like a database
//     permission check. 42501 is RLS. Migration 0061 enabled RLS on every scm.*
//     table with NO policies, and the SCM client is the SERVICE-ROLE client
//     (db/supabase.ts getSupabaseService) — service_role bypasses RLS by
//     Postgres convention and by 0061's own stated intent. That branch cannot
//     fire on this path.
//   · the crew scope (resolveDeliveryScope / scopeMatchesAssignment) on
//     PATCH /:id/status bounds a Driver to their OWN trips, but every
//     ops/dispatcher/management caller resolves to `all` — no company in it.
//
// ASSERTED IN BOTH DIRECTIONS, as the sibling company-scope suites are: a scope
// sweep's real failure mode is not "the leak stayed open", it is "a company can
// no longer touch its own rows" — an outage nobody reports, because you cannot
// report data you cannot see. So each refusal is paired with the same-company
// call still working, each refusal also asserts the victim row is UNCHANGED (a
// 404 that still mutated passes a status-only assertion), and the UNRESOLVED
// allow-list is asserted to DEGRADE rather than block, because failing closed
// there would blank a single-company install on a cold isolate.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  patchTripHandler,
  patchTripStatusHandler,
  deleteTripHandler,
  deleteTripStopHandler,
  optimizeTripRouteHandler,
} from '../src/scm/routes/trips';

const CO_A = 1; // HOUZS
const CO_B = 2; // 2990

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — same shape as companyScopeHardening's, so
   the two suites stay comparable. Unknown tables read empty rather than throwing,
   because these handlers reach well past the statement under test (reverse-sync
   reconcile, crew-scope probes) and the assertions are about the company
   predicate, not the rest. */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private table: string, private log: string[]) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) {
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    // Logged so a test can prove the predicate was APPLIED, not merely that the
    // result happened to be empty for some other reason.
    this.log.push(`${this.table}.${this.op}:in:${col}`);
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
  like() { return this; }
  is() { return this; }
  or() { return this; }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() {
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/** `allowed` undefined models the UNRESOLVED state (pre-migration / cold isolate). */
function harness(tables: Record<string, Row[]>, allowed: number[] | undefined, active = allowed?.[0]) {
  const log: string[] = [];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('allowedCompanyIds' as never, allowed as never);
    c.set('companyId' as never, active as never);
    c.set('user' as never, { id: 'u1' } as never);
    // Wildcard permissions -> resolveDeliveryScope returns SCOPE_ALL, so the
    // per-assignee crew scope cannot be what makes a test pass. The only guard
    // left in play is the company predicate, which is the point.
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/trips/:id', patchTripHandler as never);
  app.patch('/trips/:id/status', patchTripStatusHandler as never);
  app.delete('/trips/:id/stops/:stopId', deleteTripStopHandler as never);
  app.delete('/trips/:id', deleteTripHandler as never);
  app.post('/trips/:id/optimize-route', optimizeTripRouteHandler as never);
  return { app, log };
}

const trips = (): Row[] => [
  { id: 't-a', trip_no: 'TRIP-A-1', company_id: CO_A, status: 'PLANNED', trip_date: '2026-08-13', notes: 'A' },
  { id: 't-b', trip_no: 'TRIP-B-1', company_id: CO_B, status: 'PLANNED', trip_date: '2026-08-13', notes: 'B' },
];

const patch = (app: Hono, url: string, body: Row) =>
  app.request(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, {} as never);

describe('PATCH /trips/:id — header edit', () => {
  test("A cannot edit B's trip, and B's trip is left untouched", async () => {
    const t = { trips: trips() };
    const h = harness(t, [CO_A]);
    const res = await patch(h.app, '/trips/t-b', { notes: 'hijacked' });
    expect(res.status).toBe(404);
    expect(t.trips.find((r) => r.id === 't-b')!.notes).toBe('B');
    // Prove the refusal came from the company predicate being applied.
    expect(h.log).toContain('trips.update:in:company_id');
  });

  test('A CAN still edit its own trip', async () => {
    const t = { trips: trips() };
    const res = await patch(harness(t, [CO_A]).app, '/trips/t-a', { notes: 'edited' });
    expect(res.status).toBe(200);
    expect(t.trips.find((r) => r.id === 't-a')!.notes).toBe('edited');
  });

  test('a both-company caller keeps the SHARED queue — A may edit B', async () => {
    // The point of scopeToAllowedCompanies over scopeToCompany: TMS is one
    // cross-company queue, so isolating to the ACTIVE company would be a
    // regression, not a fix.
    const t = { trips: trips() };
    const res = await patch(harness(t, [CO_A, CO_B], CO_A).app, '/trips/t-b', { notes: 'shared queue' });
    expect(res.status).toBe(200);
    expect(t.trips.find((r) => r.id === 't-b')!.notes).toBe('shared queue');
  });

  test('an UNRESOLVED allow-list degrades — it must not blank a single-company install', async () => {
    const t = { trips: trips() };
    const res = await patch(harness(t, undefined).app, '/trips/t-a', { notes: 'cold isolate' });
    expect(res.status).toBe(200);
    expect(t.trips.find((r) => r.id === 't-a')!.notes).toBe('cold isolate');
  });

  test('RESTRICTED-TO-NOTHING ([]) matches no trip', async () => {
    const t = { trips: trips() };
    const res = await patch(harness(t, [], undefined).app, '/trips/t-a', { notes: 'nope' });
    expect(res.status).toBe(404);
    expect(t.trips.find((r) => r.id === 't-a')!.notes).toBe('A');
  });
});

describe('PATCH /trips/:id/status — step advance', () => {
  test("A cannot advance B's trip, and B stays PLANNED", async () => {
    const t = { trips: trips() };
    const res = await patch(harness(t, [CO_A]).app, '/trips/t-b/status', { status: 'IN_PROGRESS' });
    expect(res.status).toBe(404);
    expect(t.trips.find((r) => r.id === 't-b')!.status).toBe('PLANNED');
    expect(t.trips.find((r) => r.id === 't-b')!.clock_in_at).toBeUndefined();
  });

  test('A CAN still advance its own trip', async () => {
    const t = { trips: trips() };
    const res = await patch(harness(t, [CO_A]).app, '/trips/t-a/status', { status: 'IN_PROGRESS' });
    expect(res.status).toBe(200);
    expect(t.trips.find((r) => r.id === 't-a')!.status).toBe('IN_PROGRESS');
  });
});

describe('DELETE /trips/:id — cancel and hard delete', () => {
  test("A cannot cancel B's trip", async () => {
    const t = { trips: trips(), trip_stops: [] as Row[] };
    const res = await harness(t, [CO_A]).app.request('/trips/t-b', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(404);
    expect(t.trips.find((r) => r.id === 't-b')!.status).toBe('PLANNED');
  });

  test("A cannot HARD-delete B's trip — the row survives", async () => {
    /* The dangerous half: trip_stops CASCADEs off trips (mig 0053), so an
       unbounded hard delete took another company's stops with it. */
    const t = {
      trips: trips(),
      trip_stops: [{ id: 's-b', trip_id: 't-b', company_id: CO_B, stop_no: 1, stop_type: 'DELIVERY' }],
    };
    const res = await harness(t, [CO_A]).app.request('/trips/t-b?hard=true', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(404);
    expect(t.trips.some((r) => r.id === 't-b')).toBe(true);
  });

  test('A CAN still cancel its own trip', async () => {
    const t = { trips: trips(), trip_stops: [] as Row[] };
    const res = await harness(t, [CO_A]).app.request('/trips/t-a', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(200);
    expect(t.trips.find((r) => r.id === 't-a')!.status).toBe('CANCELLED');
  });

  test('A CAN still hard-delete its own trip', async () => {
    const t = { trips: trips(), trip_stops: [] as Row[] };
    const res = await harness(t, [CO_A]).app.request('/trips/t-a?hard=true', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(200);
    expect(t.trips.some((r) => r.id === 't-a')).toBe(false);
  });
});

describe('DELETE /trips/:id/stops/:stopId — one stop', () => {
  const stops = (): Row[] => [
    { id: 's-a', trip_id: 't-a', company_id: CO_A, stop_no: 1, stop_type: 'DELIVERY', do_id: null, so_id: null },
    { id: 's-b', trip_id: 't-b', company_id: CO_B, stop_no: 1, stop_type: 'DELIVERY', do_id: null, so_id: null },
  ];

  test("A cannot delete B's stop, and the stop survives", async () => {
    /* The stop is bounded on its OWN company_id (NOT NULL since mig 0083), not
       merely inherited through .eq('trip_id') — trip_id is caller-supplied. */
    const t = { trips: trips(), trip_stops: stops() };
    const res = await harness(t, [CO_A]).app.request('/trips/t-b/stops/s-b', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(404);
    expect(t.trip_stops.some((r) => r.id === 's-b')).toBe(true);
  });

  test('A CAN still delete its own stop', async () => {
    const t = { trips: trips(), trip_stops: stops() };
    const res = await harness(t, [CO_A]).app.request('/trips/t-a/stops/s-a', { method: 'DELETE' }, {} as never);
    expect(res.status).toBe(200);
    expect(t.trip_stops.some((r) => r.id === 's-a')).toBe(false);
  });
});

describe('POST /trips/:id/optimize-route', () => {
  test("A cannot renumber B's stops — and Google is never called for it", async () => {
    const t = {
      trips: trips(),
      trip_stops: [{ id: 's-b', trip_id: 't-b', company_id: CO_B, stop_no: 7, address: 'somewhere' }],
    };
    const res = await harness(t, [CO_A]).app.request('/trips/t-b/optimize-route?apply=true', { method: 'POST' }, {} as never);
    expect(res.status).toBe(404);
    expect(t.trip_stops.find((r) => r.id === 's-b')!.stop_no).toBe(7);
  });

  test('A reaches the optimiser for its own trip (unconfigured without a key)', async () => {
    const t = {
      trips: trips(),
      trip_stops: [{ id: 's-a', trip_id: 't-a', company_id: CO_A, stop_no: 1, address: 'somewhere' }],
    };
    const res = await harness(t, [CO_A]).app.request('/trips/t-a/optimize-route', { method: 'POST' }, {} as never);
    expect(res.status).toBe(200);
    expect((await res.json() as Row).configured).toBe(false);
  });
});
