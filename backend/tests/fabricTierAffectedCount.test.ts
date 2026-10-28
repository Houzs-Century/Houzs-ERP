// PATCH /fabric-tracking/:id/tier — the "N products affected" hint is a COUNT
// SERVED AS A FACT, so a count that could not be read must not be served as 0.
//
// WHY THIS EXISTS. This site was first filed on this branch as OUT OF CLASS,
// under the reasoning that the adjacent `count ?? 0` ledger (warehouse rack
// deletion, the rack-status writers, product-models' isFirst) is about a wrong
// DECISION rather than a wrong displayed number. That reasoning does not fit
// here: `affectedProducts` decides nothing on the server — it is returned to the
// client and printed as a sentence ("3 sofa products ... now reflect the new
// tier"). A failed count printed as 0 is the same lie the six SCM list endpoints
// were telling with their filter pills, which is exactly this branch's class.
//
// It cannot answer with a 500: the tier UPDATE has already committed by the time
// the count runs, so refusing the request would tell the operator their change
// did not land. `affectedProducts: null` is the honest answer — the write
// succeeded, the hint is unknown — and the frontend says so instead of showing
// nothing (frontend/src/vendor/scm/lib/fabric-queries.ts).
//
// Bare-Hono harness, same shape as tripsCompanyScope.test.ts: a fake supabase
// whose mfg_products count read can be made to FAIL on demand.
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { patchFabricTierHandler } from '../src/scm/routes/fabric-tracking';

const CO_A = 1;

type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' = 'select';
  private patch: Row = {};
  private wantsCount = false;
  constructor(
    private rows: Row[],
    private table: string,
    private failCountOn: string | null,
  ) {}
  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (opts?.count) this.wantsCount = true;
    return this;
  }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() { return Promise.resolve({ data: this.run()[0] ?? null, error: null }); }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    // A FAILED PostgREST count answers with a null count AND an error — the two
    // together are what `count ?? 0` collapsed into "zero products affected".
    if (this.wantsCount && this.table === this.failCountOn) {
      return Promise.resolve({ data: null, count: null, error: { message: 'boom' } }).then(res, rej);
    }
    const hit = this.run();
    return Promise.resolve(
      this.wantsCount ? { data: null, count: hit.length, error: null } : { data: hit, error: null },
    ).then(res, rej);
  }
}

function harness(tables: Record<string, Row[]>, failCountOn: string | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, failCountOn),
    } as never);
    c.set('allowedCompanyIds' as never, [CO_A] as never);
    c.set('companyId' as never, CO_A as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/fabric-tracking/:id/tier', patchFabricTierHandler as never);
  return app;
}

const tables = (): Record<string, Row[]> => ({
  fabric_trackings: [{ id: 'f-1', company_id: CO_A, fabric_code: 'AVANI 01', sofa_price_tier: 'PRICE_1' }],
  mfg_products: [
    { id: 'p-1', company_id: CO_A, fabric_color: 'AVANI 01', category: 'SOFA' },
    { id: 'p-2', company_id: CO_A, fabric_color: 'AVANI 01', category: 'ACCESSORY' },
    { id: 'p-3', company_id: CO_A, fabric_color: 'OTHER', category: 'SOFA' },
  ],
});

const patchTier = (app: Hono) =>
  app.request(
    '/fabric-tracking/f-1/tier',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'sofaPriceTier', tier: 'PRICE_2' }),
    },
    {} as never,
  );

describe('PATCH /fabric-tracking/:id/tier — the affected-products hint', () => {
  test('a successful count is served as the number it read', async () => {
    const t = tables();
    const res = await patchTier(harness(t, null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affectedProducts: 2, fabricCode: 'AVANI 01' });
    // The write itself still landed.
    expect(t.fabric_trackings[0].sofa_price_tier).toBe('PRICE_2');
  });

  test('a count that FAILED is never served as 0 — it is served as unknown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = tables();
    const res = await patchTier(harness(t, 'mfg_products'));
    // ok stays TRUE: the tier update committed before the count ran, so a 500
    // here would report a write failure that did not happen.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, affectedProducts: null, fabricCode: 'AVANI 01' });
    expect(t.fabric_trackings[0].sofa_price_tier).toBe('PRICE_2');
    // A failure nobody can see is the bug next door; it is logged.
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  test('a genuinely zero count is still 0 — an empty read is an answer', async () => {
    const t = tables();
    t.mfg_products = [];
    const res = await patchTier(harness(t, null));
    expect(await res.json()).toEqual({ ok: true, affectedProducts: 0, fabricCode: 'AVANI 01' });
  });
});
