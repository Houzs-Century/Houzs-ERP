// Stock take phase 1 (owner-approved 2026-08-08) — the ACCOUNTABILITY gates:
//   • the assignees are a RECORD of who counted (owner 2026-10-06) — anyone
//     with stock-take access may post; a take may name several assignees;
//   • variances beyond the threshold (shared/stock-take-threshold.ts) need the
//     supervise permission, refusal reverts the POSTED flip — same posture as
//     the R3 cost_required path;
//   • movements stamp the REAL caller's staff uuid, not the pinned system row
//     (the "Performed by: Unknown user" fix);
//   • counted cells record counted_by / counted_at from the same real uuid;
//   • BLIND takes strip system_qty / variance server-side while OPEN for
//     non-supervisors, and reveal after posting;
//   • create requires an assignee; the NONZERO scope keeps only buckets whose
//     system qty is actually non-zero.
//
// Driven end-to-end through a bare Hono app with a fake PostgREST client,
// mounting the EXPORTED handlers — the supabaseAuth bridge cannot run here.
// Same approach (and FakeQuery shape) as tests/companyScopeHardening.test.ts.
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  addStockTakeLineHandler,
  createStockTakeHandler,
  getStockTakeDetailHandler,
  patchStockTakeHeaderHandler,
  patchStockTakeLinesHandler,
  postStockTakeHandler,
} from '../src/scm/routes/stock-takes';
import { readStockTakeSheetHandler } from '../src/scm/routes/stock-take-sheet-read';

const CO = 1;
/* The caller's REAL staff row (mig-0066 bridge) and a second person's. */
const CALLER_HOUZS_ID = 9;
const CALLER_STAFF = 'staff-caller';
const OTHER_STAFF = 'staff-other';

type Row = Record<string, any>;

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
  like() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(p: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(p) ? p : [p]; return this; }
  eq(col: string, val: unknown) {
    this.log.push(`${this.table}.${this.op}:eq:${col}`);
    this.preds.push((r) => String(r[col]) === String(val));
    return this;
  }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  gte() { return this; }
  lte() { return this; }
  not() { return this; }
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

function harness(tables: Record<string, Row[]>, opts?: { perms?: string[] }) {
  const log: string[] = [];
  /* Every harness carries the caller's bridge row unless a test overrode the
     staff table — resolveCallerStaffId is what the gates and the stamping read. */
  tables.staff ??= [
    { id: CALLER_STAFF, user_id: CALLER_HOUZS_ID, name: 'Counter' },
    { id: OTHER_STAFF, user_id: 10, name: 'Someone Else' },
  ];
  /* The count warehouse, in THIS company. Added 2026-08-18 with
     assertWarehouseInCompany (scm/lib/ref-in-company.ts): create now proves the
     body's warehouseId belongs to the active company before it snapshots
     anything, so a fixture with no warehouses table answers 404 — which is the
     new guard working, not a regression. Modelling it here keeps the accountability
     tests about accountability. */
  tables.warehouses ??= [{ id: 'w1', company_id: CO, code: 'MAIN', name: 'Main' }];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), t, log),
      rpc: async () => ({ data: true, error: null }), // audit pre-flight: writable
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('companyCode' as never, 'HOUZS' as never);
    c.set('user' as never, { id: 'system-staff-uuid' } as never);
    c.set('houzsUser' as never, {
      id: CALLER_HOUZS_ID, name: 'Counter',
      permissions_set: new Set(opts?.perms ?? []),
    } as never);
    await next();
  });
  app.post('/stock-takes', createStockTakeHandler as never);
  app.get('/stock-takes/:id', getStockTakeDetailHandler as never);
  app.patch('/stock-takes/:id/post', postStockTakeHandler as never);
  app.patch('/stock-takes/:id/lines', patchStockTakeLinesHandler as never);
  app.patch('/stock-takes/:id', patchStockTakeHeaderHandler as never);
  app.post('/stock-takes/:id/lines', addStockTakeLineHandler as never);
  app.post('/stock-takes/:id/read-sheet', readStockTakeSheetHandler as never);
  return { app, log };
}

const jsonReq = (app: Hono, url: string, method: string, body?: Row) =>
  app.request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? '{}' : JSON.stringify(body),
  });

/* An OPEN take assigned to CALLER_STAFF with one counted line of variance
   `counted − live`. Live on-hand 10, priced open lot RM10 so a positive
   variance always has a cost basis (the R3 422 is not what is under test). */
const takeFixture = (over?: Partial<Row>): Record<string, Row[]> => ({
  stock_takes: [{
    id: 'st-1', take_no: 'STK-2608-001', company_id: CO, status: 'OPEN',
    warehouse_id: 'w1', scope_type: 'ALL', scope_value: null,
    assignee_staff_id: CALLER_STAFF, blind: false, ...over,
  }],
  stock_take_lines: [{
    id: 'ln-1', stock_take_id: 'st-1', item_code: 'CODY', product_name: 'Cody sofa',
    variant_key: '', system_qty: 10, counted_qty: 12, variance: 2, notes: null,
  }],
  inventory_balances: [{
    company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: '', qty: 10,
  }],
  inventory_lots: [{
    company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: '',
    unit_cost_sen: 1000, qty_remaining: 10, source_doc_type: 'GRN', received_at: '2026-08-01T00:00:00Z',
  }],
  inventory_movements: [],
});

describe('post gate — assignees are a record, not a gate', () => {
  test('the assignee may post, and the movement stamps THEIR staff uuid (Unknown-user fix)', async () => {
    const t = takeFixture();
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    expect(t.inventory_movements).toHaveLength(1);
    // The heart of the fix: NOT the pinned system row.
    expect(t.inventory_movements[0].performed_by).toBe(CALLER_STAFF);
    expect(t.inventory_movements[0].performed_by).not.toBe('system-staff-uuid');
  });

  test('a non-assignee may post (owner 2026-10-06: assignee is only a record)', async () => {
    const t = takeFixture({ assignee_staff_id: OTHER_STAFF, assignee_staff_ids: [OTHER_STAFF] });
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    expect(t.inventory_movements[0].performed_by).toBe(CALLER_STAFF);
  });

  test('a supervisor who is NOT the assignee may post', async () => {
    const t = takeFixture({ assignee_staff_id: OTHER_STAFF });
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/post', 'PATCH',
    );
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
  });

  test('the "*" wildcard passes (normal semantics — Owner / IT Admin)', async () => {
    const t = takeFixture({ assignee_staff_id: OTHER_STAFF });
    const res = await jsonReq(harness(t, { perms: ['*'] }).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
  });

  test('a LEGACY take without an assignee keeps the old behaviour (any area caller)', async () => {
    const t = takeFixture({ assignee_staff_id: null });
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
  });
});

describe('post gate — variance threshold', () => {
  test('an over-threshold qty variance refuses for the assignee, reverts the flip, writes nothing', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 20; // variance +10 > default 5
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(403);
    const body = await res.json() as Row;
    expect(body.error).toBe('variance_supervisor_required');
    expect(body.itemCodes).toEqual(['CODY']);
    expect(body.postReverted).toBe(true);
    // The refusal SAYS a supervisor is needed, and survives the client filter.
    expect(String(body.message)).toContain('supervisor');
    expect(String(body.message).length).toBeLessThan(200);
    // Reverted, still editable, nothing written.
    expect(t.stock_takes[0].status).toBe('OPEN');
    expect(t.stock_takes[0].posted_at ?? null).toBeNull();
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('a small variance on an EXPENSIVE SKU breaches on value (2 x RM300 > RM500)', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 8; // variance −2, within qty limit
    t.inventory_lots[0].unit_cost_sen = 30_000; // RM300/unit
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe('variance_supervisor_required');
    expect(t.stock_takes[0].status).toBe('OPEN');
  });

  test('an under-threshold variance posts normally for the assignee', async () => {
    const t = takeFixture(); // variance +2, RM10 cost — under both limits
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].qty).toBe(2);
  });

  test('a supervisor may post an over-threshold variance', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 20; // variance +10
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/post', 'PATCH',
    );
    expect(res.status).toBe(200);
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].qty).toBe(10);
  });
});

describe('blind counts — server-side stripping', () => {
  test('a blind OPEN take hides system_qty and variance from a non-supervisor', async () => {
    const t = takeFixture({ blind: true });
    const res = await harness(t).app.request('/stock-takes/st-1');
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.viewer).toEqual({ isAssignee: true, canSupervise: false, blindActive: true });
    expect(body.lines[0].system_qty).toBeNull();
    expect(body.lines[0].variance).toBeNull();
    expect(body.lines[0].counted_qty).toBe(12); // their own entry stays visible
  });

  test('a supervisor sees the real figures on the same blind OPEN take', async () => {
    const t = takeFixture({ blind: true });
    const res = await harness(t, { perms: ['scm.stock_take.supervise'] }).app.request('/stock-takes/st-1');
    const body = await res.json() as Row;
    expect(body.viewer.blindActive).toBe(false);
    expect(body.viewer.canSupervise).toBe(true);
    expect(body.lines[0].system_qty).toBe(10);
  });

  test('after POSTING, a blind take reveals to everyone', async () => {
    const t = takeFixture({ blind: true, status: 'POSTED' });
    const res = await harness(t).app.request('/stock-takes/st-1');
    const body = await res.json() as Row;
    expect(body.viewer.blindActive).toBe(false);
    expect(body.lines[0].system_qty).toBe(10);
  });

  test('a non-blind take is untouched and viewer flags are honest', async () => {
    const t = takeFixture({ assignee_staff_id: OTHER_STAFF });
    const res = await harness(t).app.request('/stock-takes/st-1');
    const body = await res.json() as Row;
    expect(body.viewer).toEqual({ isAssignee: false, canSupervise: false, blindActive: false });
    expect(body.lines[0].system_qty).toBe(10);
  });
});

describe('create — assignee required, NONZERO scope', () => {
  const createTables = (): Record<string, Row[]> => ({
    v_inventory_all_skus: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'CODY', product_name: 'Cody sofa', category: 'SOFA' },
      { company_id: CO, warehouse_id: 'w1', item_code: 'EMPTY', product_name: 'Ghost SKU', category: 'SOFA' },
      { company_id: CO, warehouse_id: 'w1', item_code: 'ZEROED', product_name: 'Consumed SKU', category: 'SOFA' },
    ],
    inventory_balances: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: 'fabriccode=bf-16', product_name: 'Cody sofa', qty: 3 },
      { company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: 'fabriccode=bf-17', product_name: 'Cody sofa', qty: 0 },
      { company_id: CO, warehouse_id: 'w1', item_code: 'ZEROED', variant_key: '', product_name: 'Consumed SKU', qty: 0 },
    ],
    stock_takes: [],
    stock_take_lines: [],
  });

  test('refuses without an assignee', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'ALL',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Row).error).toBe('assignee_required');
    expect(t.stock_takes).toHaveLength(0);
  });

  test('refuses an assignee uuid that is not a staff row', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'ALL', assigneeStaffId: 'not-a-staff-row',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Row).error).toBe('invalid_assignee');
  });

  test('ALL scope keeps zero buckets and synthetic never-moved lines (unchanged)', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'ALL', assigneeStaffId: OTHER_STAFF,
    });
    expect(res.status).toBe(201);
    // CODY×2 buckets + EMPTY synthetic @0 + ZEROED @0.
    expect(t.stock_take_lines).toHaveLength(4);
    const head = t.stock_takes[0];
    expect(head.assignee_staff_id).toBe(OTHER_STAFF);
    expect(head.blind).toBe(false);
  });

  test('NONZERO scope keeps only buckets whose system qty is not 0', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'NONZERO', assigneeStaffId: OTHER_STAFF, blind: true,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Row).lineCount).toBe(1);
    expect(t.stock_take_lines).toHaveLength(1);
    expect(t.stock_take_lines[0].item_code).toBe('CODY');
    expect(t.stock_take_lines[0].system_qty).toBe(3);
    expect(t.stock_takes[0].blind).toBe(true);
    expect(t.stock_takes[0].scope_type).toBe('NONZERO');
  });
});

describe('counted cells record WHO and WHEN', () => {
  test('entering a count stamps counted_by/counted_at; clearing it clears both', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = null;
    const { app } = harness(t);

    const res = await jsonReq(app, '/stock-takes/st-1/lines', 'PATCH', {
      lines: [{ id: 'ln-1', countedQty: 7 }],
    });
    expect(res.status).toBe(200);
    expect(t.stock_take_lines[0].counted_qty).toBe(7);
    expect(t.stock_take_lines[0].counted_by).toBe(CALLER_STAFF);
    expect(typeof t.stock_take_lines[0].counted_at).toBe('string');

    const cleared = await jsonReq(app, '/stock-takes/st-1/lines', 'PATCH', {
      lines: [{ id: 'ln-1', countedQty: null }],
    });
    expect(cleared.status).toBe(200);
    expect(t.stock_take_lines[0].counted_qty).toBeNull();
    expect(t.stock_take_lines[0].counted_by).toBeNull();
    expect(t.stock_take_lines[0].counted_at).toBeNull();
  });
});

describe('round 1 (owner 2026-10-06)', () => {
  const createTables = (): Record<string, Row[]> => ({
    v_inventory_all_skus: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'MATT-A', product_name: 'Mattress A', category: 'MATTRESS' },
      { company_id: CO, warehouse_id: 'w1', item_code: 'MATT-B', product_name: 'Mattress B', category: 'MATTRESS' },
    ],
    inventory_balances: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'MATT-A', variant_key: '', product_name: 'Mattress A', qty: 4 },
      { company_id: CO, warehouse_id: 'w1', item_code: 'MATT-B', variant_key: '', product_name: 'Mattress B', qty: 0 },
    ],
    stock_takes: [],
    stock_take_lines: [],
  });

  test('create takes several assignees; the first also fills the single column', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'ALL', assigneeStaffIds: [OTHER_STAFF, CALLER_STAFF, OTHER_STAFF],
    });
    expect(res.status).toBe(201);
    expect(t.stock_takes[0].assignee_staff_ids).toEqual([OTHER_STAFF, CALLER_STAFF]);
    expect(t.stock_takes[0].assignee_staff_id).toBe(OTHER_STAFF);
  });

  test('"only SKUs with stock" combines with a Category scope', async () => {
    const t = createTables();
    const res = await jsonReq(harness(t).app, '/stock-takes', 'POST', {
      warehouseId: 'w1', scopeType: 'CATEGORY', scopeValue: 'MATTRESS', nonzeroOnly: true,
      assigneeStaffIds: [CALLER_STAFF],
    });
    expect(res.status).toBe(201);
    expect(t.stock_take_lines.map((l) => l.item_code)).toEqual(['MATT-A']);
    expect(t.stock_takes[0].nonzero_only).toBe(true);
    expect(t.stock_takes[0].scope_type).toBe('CATEGORY');
  });

  test('an OPEN take\'s assignees and notes can be edited; a POSTED one cannot', async () => {
    const t = takeFixture();
    const { app } = harness(t);
    const res = await jsonReq(app, '/stock-takes/st-1', 'PATCH', { assigneeStaffIds: [CALLER_STAFF, OTHER_STAFF], notes: ' Row A ' });
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].assignee_staff_ids).toEqual([CALLER_STAFF, OTHER_STAFF]);
    expect(t.stock_takes[0].notes).toBe('Row A');
    expect((await jsonReq(app, '/stock-takes/st-1', 'PATCH', { assigneeStaffIds: [] })).status).toBe(400);
    t.stock_takes[0].status = 'POSTED';
    expect((await jsonReq(app, '/stock-takes/st-1', 'PATCH', { notes: 'x' })).status).toBe(409);
  });

  test('Add line: a found SKU lands counted, with live system qty; a duplicate is refused', async () => {
    const t = takeFixture();
    t.mfg_products = [{ code: 'PILLOW', name: 'Pillow', category: 'ACCESSORY', company_id: CO }];
    const { app } = harness(t);
    const res = await jsonReq(app, '/stock-takes/st-1/lines', 'POST', { itemCode: 'PILLOW', countedQty: 3 });
    expect(res.status).toBe(201);
    const added = t.stock_take_lines.find((l) => l.item_code === 'PILLOW')!;
    expect(added.counted_qty).toBe(3);
    expect(added.system_qty).toBe(0);
    expect(added.added_on_count).toBe(true);
    expect(added.counted_by).toBe(CALLER_STAFF);
    const again = await jsonReq(app, '/stock-takes/st-1/lines', 'POST', { itemCode: 'PILLOW', countedQty: 1 });
    expect(again.status).toBe(409);
    expect(((await again.json()) as Row).error).toBe('line_exists');
  });

  test('Add line: a sofa needs a variant; another company\'s SKU is unknown', async () => {
    const t = takeFixture();
    t.mfg_products = [
      { code: 'SOFA-1', name: 'Sofa', category: 'SOFA', company_id: CO },
      { code: 'THEIRS', name: 'Other co', category: 'ACCESSORY', company_id: 2 },
    ];
    const { app } = harness(t);
    const sofa = await jsonReq(app, '/stock-takes/st-1/lines', 'POST', { itemCode: 'SOFA-1', countedQty: 1 });
    expect(((await sofa.json()) as Row).error).toBe('variant_required');
    const theirs = await jsonReq(app, '/stock-takes/st-1/lines', 'POST', { itemCode: 'THEIRS', countedQty: 1 });
    expect(theirs.status).toBe(404);
  });

  test('detail carries the RM estimate per line; a blind OPEN take withholds it', async () => {
    const open = takeFixture();
    const body = await (await harness(open).app.request('/stock-takes/st-1')).json() as Row;
    expect(body.lines[0].est_unit_cost_sen).toBe(1000);
    const blind = takeFixture({ blind: true });
    const hidden = await (await harness(blind).app.request('/stock-takes/st-1')).json() as Row;
    expect(hidden.lines[0].est_unit_cost_sen).toBeNull();
  });
});

describe('round 2 — racks and the paper sheet (owner 2026-10-06)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const withRacks = (t: Record<string, Row[]>) => {
    t.warehouse_racks = [
      { id: 'r1', rack: 'Rack L5.1', warehouse_id: 'w1', company_id: CO, reserved: false },
      { id: 'r-other', rack: 'Rack L5.1', warehouse_id: 'w2', company_id: CO, reserved: false },
    ];
    t.warehouse_rack_items = [{ id: 'old-1', rack_id: 'r1x', item_code: 'CODY', qty: 10, company_id: CO }];
    t.warehouse_rack_movements = [];
    return t;
  };

  test('a line can name a rack of the take\'s warehouse, never another warehouse\'s', async () => {
    const t = withRacks(takeFixture());
    const { app } = harness(t);
    const ok = await jsonReq(app, '/stock-takes/st-1/lines', 'PATCH', { lines: [{ id: 'ln-1', rackId: 'r1' }] });
    expect(ok.status).toBe(200);
    expect(t.stock_take_lines[0].rack_id).toBe('r1');
    const bad = await jsonReq(app, '/stock-takes/st-1/lines', 'PATCH', { lines: [{ id: 'ln-1', rackId: 'r-other' }] });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Row).error).toBe('rack_not_in_warehouse');
    expect(t.stock_take_lines[0].rack_id).toBe('r1');
  });

  test('posting moves the counted goods onto the written rack and logs it', async () => {
    const t = withRacks(takeFixture());
    t.warehouse_racks.push({ id: 'r1x', rack: 'Rack L1.1', warehouse_id: 'w1', company_id: CO, reserved: false });
    t.stock_take_lines[0].rack_id = 'r1';
    t.stock_take_lines[0].company_id = CO;
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).racksMoved).toBe(1);
    expect(t.warehouse_rack_items).toEqual([expect.objectContaining({ rack_id: 'r1', item_code: 'CODY', qty: 12, source_doc_no: 'STK-2608-001' })]);
    expect(t.warehouse_rack_movements.map((m) => `${m.movement_type}:${m.rack_label}:${m.quantity}`))
      .toEqual(['STOCK_OUT:Rack L1.1:10', 'STOCK_IN:Rack L5.1:12']);
  });

  test('reading a sheet proposes counts and racks, writes nothing, and refuses another take\'s page', async () => {
    const t = withRacks(takeFixture());
    t.stock_take_lines[0].counted_qty = null;
    t.stock_take_lines[0].company_id = CO;
    const model = (takeNo: string) => ({
      ok: true, status: 200,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ takeNo, rows: [{ no: 1, itemCode: 'CODY', counted: 9, rack: 'l5.1' }] }) }] }),
      clone() { return this; }, text: async () => '',
    });
    vi.stubGlobal('fetch', vi.fn(async () => model('STK-2608-001')));
    const { app } = harness(t);
    const body = JSON.stringify({ files: [{ name: 'p1.jpg', mime: 'image/jpeg', dataBase64: 'AAAA' }] });
    const req = () => app.request('/stock-takes/st-1/read-sheet', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, { ANTHROPIC_API_KEY: 'k' });
    const res = await req();
    expect(res.status).toBe(200);
    const out = await res.json() as Row;
    expect(out.takeNoMatches).toBe(true);
    expect(out.proposals).toEqual([expect.objectContaining({ lineId: 'ln-1', counted: 9, rackId: 'r1' })]);
    expect(t.stock_take_lines[0].counted_qty).toBeNull(); // nothing written

    vi.stubGlobal('fetch', vi.fn(async () => model('STK-2608-999')));
    const other = await (await req()).json() as Row;
    expect(other.takeNoMatches).toBe(false);
    expect(other.proposals).toEqual([]);
  });
});
