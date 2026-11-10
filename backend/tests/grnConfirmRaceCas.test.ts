// Two simultaneous confirms of one DRAFT GRN must book its stock once.
//
// Before 2026-11-10 postGrnAndRollup CAS-ed on a status it re-read itself. When
// confirm B loaded the GRN as DRAFT and confirm A posted it before B reached the
// chokepoint, B's fresh read saw POSTED, its CAS POSTED -> POSTED matched, and B
// went on to write the stock IN a second time. The CAS now uses the status the
// caller saw. Sister fix: Conts-ERP #787 (`expectedStatus`).
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { postGrnHandler } from '../src/scm/routes/grns';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private rows: Row[], private onRun: () => void) {}
  select() { return this; }
  order() { return this; } limit() { return this; } range() { return this; } ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } is() { return this; } or() { return this; }
  private run(): Row[] {
    this.onRun();
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null }); }
  single() { const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } }); }
  then(res: (v: any) => any, rej?: (e: any) => any) { return Promise.resolve({ data: this.run(), error: null }).then(res, rej); }
}

function harness(otherConfirmWinsMidRequest: boolean) {
  const tables: Record<string, Row[]> = {
    grns: [{ id: 'g-1', grn_number: 'GRN-1', company_id: CO, status: 'DRAFT', warehouse_id: 'w1', total_sen: 0 }],
    grn_items: [],
  };
  let grnReads = 0;
  // The other confirm commits after this one loaded the GRN: on this request's
  // second statement against grns (the chokepoint's header read).
  const onRun = (t: string) => () => {
    if (t === 'grns' && ++grnReads === 2 && otherConfirmWinsMidRequest) {
      Object.assign(tables.grns![0]!, { status: 'POSTED', posted_at: '2026-11-10T00:00:00Z' });
    }
  };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), onRun(t)),
      schema(_s: string) { return this; },
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  app.patch('/grns/:id/post', postGrnHandler as never);
  return { app, tables };
}

/* No database behind these stubs, so the post runs its two-step path
   (GRN_POST_MODE). The CAS is the same line in both paths. */
const confirm = (app: Hono) =>
  app.request('/grns/g-1/post', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }, { GRN_POST_MODE: 'two-step' });

describe('GRN confirm — CAS on the status the caller saw', () => {
  test('the second of two simultaneous confirms is refused and posts nothing', async () => {
    const { app } = harness(true);
    const res = await confirm(app);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; reason?: string };
    expect(body.error).toBe('cannot_confirm');
    expect(body.reason).toBe('already_posting');
  });

  test('a lone confirm still posts', async () => {
    const { app, tables } = harness(false);
    const res = await confirm(app);
    expect(res.status).toBe(200);
    expect(tables.grns![0]!.status).toBe('POSTED');
  });
});
