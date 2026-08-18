// Purchase Return LINE verbs must SURFACE a refused stock movement, the way the
// CREATE path already does — same key (`movementErrors`), same element shape
// (`OUT|IN <returnNumber>: <reason>`), same policy (the write COMMITS; only the
// reporting changes).
//
// The trap this guards: writeMovements NEVER THROWS. It logs and returns
// { ok:false, reason } (scm/lib/inventory-movements.ts), so the try/catch around
// writePrLineDeltaMovement catches nothing and the result has to be READ.
// Discarding it let a line add / qty edit / delete move qty_returned,
// grn_items.returned_qty and the refund rollup with NO compensating inventory
// movement while the operator was answered 201 / 200 / 204.
//
// Driven end-to-end through a bare Hono app whose middleware injects a fake scm
// supabase client + a company context, mounting the EXPORTED handlers rather
// than the router — the supabaseAuth bridge cannot run in this harness. Same
// approach as companyScopeConsignmentPo.test.ts / companyScopeHardening.test.ts.
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import {
  addPurchaseReturnItemHandler,
  patchPurchaseReturnItemHandler,
  deletePurchaseReturnItemHandler,
} from '../src/scm/routes/purchase-returns';

const CO = 1;
const PR_ID = 'pr-1';
const PR_NO = 'PRT-2608-001';
const WH = 'wh-kl';
const REFUSAL = 'movement sink refused';

type Row = Record<string, any>;

/* Permissive fake PostgREST builder — the companyScopeConsignmentPo.test.ts one,
   plus the two things THIS assertion needs:
     • `failInsert`: a table whose INSERT resolves { error }, which is exactly how
       a refused inventory_movements write reaches writeMovements;
     • an id assigned on insert, because the add-line handler only writes the
       delta movement when the inserted row comes back with one (a real DB
       default; without it the fake would silently skip the code under test). */
class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'delete' | 'insert' = 'select';
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(
    private rows: Row[],
    private table: string,
    private failInsert: Set<string>,
    private seq: { n: number },
  ) {}
  select() { return this; }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  ilike() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) {
    this.op = 'insert';
    this.inserted = (Array.isArray(p) ? p : [p]).map((r) => (r.id ? r : { ...r, id: `row-${++this.seq.n}` }));
    return this;
  }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
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
  private refused() { return this.op === 'insert' && this.failInsert.has(this.table); }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() {
    if (this.refused()) return Promise.resolve({ data: null, error: { message: REFUSAL } });
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: null });
  }
  single() {
    if (this.refused()) return Promise.resolve({ data: null, error: { message: REFUSAL } });
    const h = this.run();
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    if (this.refused()) return Promise.resolve({ data: null, error: { message: REFUSAL } }).then(res, rej);
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/** A POSTED, company-1 return with one manual line, drawing on the GRN's warehouse. */
function tablesFor(): Record<string, Row[]> {
  return {
    purchase_returns: [{
      id: PR_ID, company_id: CO, return_number: PR_NO, status: 'POSTED', grn_id: 'grn-1', refund_sen: 5000,
    }],
    purchase_return_items: [{
      id: 'pri-1', company_id: CO, purchase_return_id: PR_ID, grn_item_id: null,
      material_code: 'AKEMI-Q', material_name: 'AKEMI Queen', qty_returned: 5,
      unit_price_sen: 1000, line_refund_sen: 5000, item_group: null, variants: null,
    }],
    grns: [{ id: 'grn-1', company_id: CO, warehouse_id: WH }],
    grn_items: [],
    inventory_movements: [],
    entity_audit_log: [],
    warehouses: [{ id: WH, company_id: CO, code: 'KL', name: 'KL', is_default: true }],
  };
}

function harness(tables: Record<string, Row[]>, failInsert: string[]) {
  const fail = new Set(failInsert);
  const seq = { n: 0 };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, fail, seq),
      rpc: async () => ({ data: true, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester' } as never);
    await next();
  });
  app.post('/purchase-returns/:id/items', addPurchaseReturnItemHandler as never);
  app.patch('/purchase-returns/:id/items/:itemId', patchPurchaseReturnItemHandler as never);
  app.delete('/purchase-returns/:id/items/:itemId', deletePurchaseReturnItemHandler as never);
  return app;
}

const send = (app: Hono, method: string, url: string, body?: Row) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/* The CREATE path's contract, asserted once so the line verbs are compared
   against a written-down shape rather than against each other:
   `movementErrors: string[]`, each `OUT|IN <returnNumber>: <reason>`. */
function expectCreateShape(body: any, dir: 'OUT' | 'IN') {
  expect(Array.isArray(body.movementErrors)).toBe(true);
  expect(body.movementErrors).toHaveLength(1);
  expect(body.movementErrors[0]).toBe(`${dir} ${PR_NO}: ${REFUSAL}`);
}

describe('Purchase Return line verbs — a refused movement reaches the operator', () => {
  test('POST /:id/items — 201 WITH the line and the movement error', async () => {
    const tables = tablesFor();
    const res = await send(harness(tables, ['inventory_movements']), 'POST', `/purchase-returns/${PR_ID}/items`, {
      materialCode: 'AKEMI-K', materialName: 'AKEMI King', qty: 3, unitPriceSen: 2000,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    // The document still comes back — the line COMMITS, best-effort ledger.
    expect(body.item).toBeTruthy();
    expect(tables.purchase_return_items).toHaveLength(2);
    expectCreateShape(body, 'OUT');
  });

  test('PATCH /:id/items/:itemId — 200 WITH the qty change applied and the movement error', async () => {
    const tables = tablesFor();
    const res = await send(harness(tables, ['inventory_movements']), 'PATCH', `/purchase-returns/${PR_ID}/items/pri-1`, { qty: 2 });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    // The edit STANDS: qty moved 5 -> 2 even though the compensating IN failed.
    expect(tables.purchase_return_items[0]!.qty_returned).toBe(2);
    expectCreateShape(body, 'IN');
  });

  test('DELETE /:id/items/:itemId — 200 (not 204) WITH the line gone and the movement error', async () => {
    const tables = tablesFor();
    const res = await send(harness(tables, ['inventory_movements']), 'DELETE', `/purchase-returns/${PR_ID}/items/pri-1`);
    // A 204 cannot carry a body, so it cannot carry this failure.
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(tables.purchase_return_items).toHaveLength(0);
    expectCreateShape(body, 'IN');
  });

  test('a refused movement also leaves a RECOUNT_FAILED row on the return trail', async () => {
    const tables = tablesFor();
    await send(harness(tables, ['inventory_movements']), 'PATCH', `/purchase-returns/${PR_ID}/items/pri-1`, { qty: 2 });
    const rows = tables.entity_audit_log!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entity_type).toBe('PURCHASE_RETURN');
    expect(rows[0]!.action).toBe('RECOUNT_FAILED');
    expect(rows[0]!.entity_doc_no).toBe(PR_NO);
    expect(String(rows[0]!.note)).toContain(REFUSAL);
  });

  test('a movement that LANDS reports nothing — the field is a failure signal, not noise', async () => {
    const tables = tablesFor();
    const res = await send(harness(tables, []), 'PATCH', `/purchase-returns/${PR_ID}/items/pri-1`, { qty: 2 });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.movementErrors).toBeUndefined();
    expect(tables.entity_audit_log).toHaveLength(0);
    expect(tables.inventory_movements).toHaveLength(1);
  });
});
