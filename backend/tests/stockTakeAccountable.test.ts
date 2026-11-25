// Stock take phase 1 (owner-approved 2026-08-08) — the ACCOUNTABILITY gates:
//   • the assignees are a RECORD of who counted (owner 2026-10-06) — anyone
//     with stock-take access may post; a take may name several assignees;
//   • variances beyond the threshold (shared/stock-take-threshold.ts) need a
//     supervisor: owner 2026-11-20, a non-supervisor's over-limit post now
//     SUBMITS (OPEN -> PENDING_APPROVAL, nothing moved) and a supervisor
//     /approve books it or /reject returns it, rather than a hard refusal;
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
  approveStockTakeHandler,
  createStockTakeHandler,
  deleteStockTakeLineHandler,
  getStockTakeDetailHandler,
  patchStockTakeHeaderHandler,
  patchStockTakeLinesHandler,
  postStockTakeHandler,
  rejectStockTakeHandler,
  reopenStockTakeHandler,
  pendingApprovalCountHandler,
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
  private countMode = false;
  constructor(private rows: Row[], private table: string, private log: string[]) {}
  select(_cols?: unknown, opts?: { count?: string; head?: boolean }) { if (opts?.head) this.countMode = true; return this; }
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
    const hit = this.run();
    const payload = this.countMode ? { data: null, count: hit.length, error: null } : { data: hit, error: null };
    return Promise.resolve(payload).then(res, rej);
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
  app.get('/stock-takes/pending-count', pendingApprovalCountHandler as never);
  app.get('/stock-takes/:id', getStockTakeDetailHandler as never);
  app.patch('/stock-takes/:id/post', postStockTakeHandler as never);
  app.patch('/stock-takes/:id/approve', approveStockTakeHandler as never);
  app.patch('/stock-takes/:id/reject', rejectStockTakeHandler as never);
  app.patch('/stock-takes/:id/reopen', reopenStockTakeHandler as never);
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

describe('post gate — variance threshold now SUBMITS for approval (owner 2026-11-20)', () => {
  test('an over-threshold qty variance by a non-supervisor is SENT FOR APPROVAL, not refused; nothing moves', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 20; // variance +10 > default 5
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    const body = await res.json() as Row;
    expect(body.pendingApproval).toBe(true);
    expect(body.itemCodes).toEqual(['CODY']);
    // The message names a supervisor and survives the client filter (< 200 chars).
    expect(String(body.message)).toContain('supervisor');
    expect(String(body.message).length).toBeLessThan(200);
    // Flipped to PENDING_APPROVAL, submitter stamped, nothing written.
    expect(t.stock_takes[0].status).toBe('PENDING_APPROVAL');
    expect(t.stock_takes[0].submitted_by).toBe(CALLER_STAFF);
    expect(typeof t.stock_takes[0].submitted_at).toBe('string');
    expect(t.stock_takes[0].posted_at ?? null).toBeNull();
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('a small variance on an EXPENSIVE SKU also goes to approval (2 x RM300 > RM500)', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 8; // variance −2, within qty limit
    t.inventory_lots[0].unit_cost_sen = 30_000; // RM300/unit
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).pendingApproval).toBe(true);
    expect(t.stock_takes[0].status).toBe('PENDING_APPROVAL');
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('an under-threshold variance posts straight through for the assignee', async () => {
    const t = takeFixture(); // variance +2, RM10 cost — under both limits
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).pendingApproval ?? false).toBe(false);
    expect(t.stock_takes[0].status).toBe('POSTED');
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].qty).toBe(2);
  });

  test('a supervisor still posts an over-threshold variance straight through', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 20; // variance +10
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/post', 'PATCH',
    );
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].qty).toBe(10);
  });
});

describe('approve / reject a pending count (owner 2026-11-20)', () => {
  /* A take already submitted and waiting: +10 variance, over the limit. Submitted
     by SOMEONE ELSE — a supervisor's own post never goes pending, so the approver
     is never the submitter (the self-approval guard below covers the edge). */
  const pendingFixture = () => {
    const t = takeFixture({ status: 'PENDING_APPROVAL', submitted_by: OTHER_STAFF, submitted_at: '2026-11-20T00:00:00Z' });
    t.stock_take_lines[0].counted_qty = 20;
    return t;
  };

  test('a supervisor approves: PENDING_APPROVAL -> POSTED and the variance is booked', async () => {
    const t = pendingFixture();
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/approve', 'PATCH',
    );
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].qty).toBe(10);
    // Booked and attributed to the supervisor who signed it off.
    expect(t.inventory_movements[0].performed_by).toBe(CALLER_STAFF);
  });

  test('a non-supervisor may NOT approve', async () => {
    const t = pendingFixture();
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/approve', 'PATCH');
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe('supervisor_required');
    expect(t.stock_takes[0].status).toBe('PENDING_APPROVAL');
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('a supervisor rejects: PENDING_APPROVAL -> OPEN, submission marks cleared, nothing moved', async () => {
    const t = pendingFixture();
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/reject', 'PATCH',
    );
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('OPEN');
    expect(t.stock_takes[0].submitted_by ?? null).toBeNull();
    expect(t.stock_takes[0].submitted_at ?? null).toBeNull();
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('a non-supervisor may NOT reject', async () => {
    const t = pendingFixture();
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/reject', 'PATCH');
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe('supervisor_required');
    expect(t.stock_takes[0].status).toBe('PENDING_APPROVAL');
  });

  test('approve refuses when the take is not pending (already posted)', async () => {
    const t = takeFixture({ status: 'POSTED' });
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/approve', 'PATCH',
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('not_pending');
  });

  test('nobody approves their own submission (owner 2026-11-24, parity with backdate)', async () => {
    const t = pendingFixture();
    t.stock_takes[0].submitted_by = CALLER_STAFF; // the approver IS the submitter
    const res = await jsonReq(
      harness(t, { perms: ['scm.stock_take.supervise'] }).app,
      '/stock-takes/st-1/approve', 'PATCH',
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as Row).error).toBe('own_submission');
    expect(t.stock_takes[0].status).toBe('PENDING_APPROVAL');
    expect(t.inventory_movements).toHaveLength(0);
  });
});

describe('pending-approval count — the approvals-inbox sidebar badge (owner 2026-11-24)', () => {
  const twoPending = (): Record<string, Row[]> => ({
    stock_takes: [
      { id: 'st-1', take_no: 'STK-2611-010', company_id: CO, status: 'PENDING_APPROVAL' },
      { id: 'st-2', take_no: 'STK-2611-011', company_id: CO, status: 'PENDING_APPROVAL' },
      { id: 'st-3', take_no: 'STK-2611-012', company_id: CO, status: 'OPEN' },          // not pending
      { id: 'st-4', take_no: 'STK-2611-013', company_id: 2,  status: 'PENDING_APPROVAL' }, // other company
    ],
  });

  test('a supervisor gets the live count of pending takes in their company', async () => {
    const res = await harness(twoPending(), { perms: ['scm.stock_take.supervise'] }).app.request('/stock-takes/pending-count');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).count).toBe(2);
  });

  test('a non-supervisor is never polled a real number — always 0, so no badge', async () => {
    const res = await harness(twoPending()).app.request('/stock-takes/pending-count');
    expect(res.status).toBe(200);
    expect(((await res.json()) as Row).count).toBe(0);
  });
});

describe('posted detail surfaces its booked adjustments (owner 2026-11-20)', () => {
  test('a POSTED take returns its STOCK_TAKE movements, sorted, excluding other takes and zero-qty rows', async () => {
    const t = takeFixture({ status: 'POSTED' });
    t.inventory_movements = [
      { source_doc_type: 'STOCK_TAKE', source_doc_id: 'st-1', item_code: 'ZED', product_name: 'Zed', variant_key: '', qty: -1, unit_cost_sen: 0 },
      { source_doc_type: 'STOCK_TAKE', source_doc_id: 'st-1', item_code: 'CODY', product_name: 'Cody sofa', variant_key: '', qty: 2, unit_cost_sen: 1000 },
      { source_doc_type: 'STOCK_TAKE', source_doc_id: 'st-1', item_code: 'NIL', product_name: 'Nil', variant_key: '', qty: 0, unit_cost_sen: 0 },
      { source_doc_type: 'STOCK_TAKE', source_doc_id: 'other', item_code: 'NOPE', product_name: 'Other take', variant_key: '', qty: 5, unit_cost_sen: 0 },
    ];
    const body = await (await harness(t).app.request('/stock-takes/st-1')).json() as Row;
    expect((body.adjustments as Row[]).map((a) => a.item_code)).toEqual(['CODY', 'ZED']);
    expect((body.adjustments as Row[])[0].qty).toBe(2);
  });

  test('an OPEN take exposes no adjustments', async () => {
    const t = takeFixture();
    t.inventory_movements = [{ source_doc_type: 'STOCK_TAKE', source_doc_id: 'st-1', item_code: 'CODY', variant_key: '', qty: 2, unit_cost_sen: 1000 }];
    const body = await (await harness(t).app.request('/stock-takes/st-1')).json() as Row;
    expect(body.adjustments).toEqual([]);
  });

  test('the detail links to the take\'s mirror Stock Adjustment document', async () => {
    const t = takeFixture({ status: 'POSTED' });
    t.stock_adjustments = [{ id: 'sa-1', adjustment_no: 'HC-SA-2611-009', company_id: CO, warehouse_id: 'w1', source_stock_take_id: 'st-1' }];
    const body = await (await harness(t).app.request('/stock-takes/st-1')).json() as Row;
    expect((body.adjustment as Row).id).toBe('sa-1');
    expect((body.adjustment as Row).adjustment_no).toBe('HC-SA-2611-009');
  });
});

describe('posting mints a mirror Stock Adjustment document (owner 2026-11-20)', () => {
  test('a within-limit post creates a read-only SA document whose lines mirror the variance; stock moves once', async () => {
    const t = takeFixture(); // variance +2, under the limit
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    // ONE movement (stock moved once, through the take) ...
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].source_doc_type).toBe('STOCK_TAKE');
    // ... and a formal Stock Adjustment document mirroring it, linked back to the take.
    expect(t.stock_adjustments).toHaveLength(1);
    expect(t.stock_adjustments[0].source_stock_take_id).toBe('st-1');
    expect(t.stock_adjustment_lines).toHaveLength(1);
    expect(t.stock_adjustment_lines[0].item_code).toBe('CODY');
    expect(t.stock_adjustment_lines[0].qty).toBe(2);
    expect(t.stock_adjustment_lines[0].reason_code).toBe('COUNT');
    // The SA document writes NO movements of its own (source stays STOCK_TAKE).
    expect(t.inventory_movements.filter((m) => m.source_doc_type === 'ADJUSTMENT')).toHaveLength(0);
  });

  test('a zero-variance post writes no movement and mints no adjustment document', async () => {
    const t = takeFixture();
    t.stock_take_lines[0].counted_qty = 10; // equals live on-hand -> no variance
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.inventory_movements).toHaveLength(0);
    expect(t.stock_adjustments ?? []).toHaveLength(0);
  });
});

describe('cost_required refusal is short and names the SKU (owner 2026-11-20)', () => {
  test('a positive variance with no cost basis refuses 422, names the item, stays under the 200-char client filter', async () => {
    const t = takeFixture();           // CODY counted 12 vs live 10 -> +2 found
    t.inventory_lots = [];             // ... but no priced lot, so no cost basis
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(422);
    const body = await res.json() as Row;
    expect(body.error).toBe('cost_required');
    expect(body.itemCodes).toEqual(['CODY']);
    // The operator must see WHICH item, and the sentence must survive the client's
    // isPlain filter (authed-fetch.ts: < 200 chars) instead of being genericised.
    expect(String(body.message)).toContain('CODY');
    expect(String(body.message).length).toBeLessThan(200);
    expect(t.inventory_movements).toHaveLength(0);
  });

  test('many costless SKUs are capped so the sentence stays short', async () => {
    const t = takeFixture();
    t.stock_take_lines = Array.from({ length: 6 }, (_, i) => ({
      id: `ln-${i}`, stock_take_id: 'st-1',
      item_code: `VERY LONG MATTRESS MODEL NAME NUMBER ${i} (QUEEN)`,
      product_name: `Mattress ${i}`, variant_key: '', system_qty: 0, counted_qty: 1, variance: 1, notes: null,
    }));
    t.inventory_balances = [];
    t.inventory_lots = [];
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(422);
    const body = await res.json() as Row;
    expect(body.itemCodes).toHaveLength(6);           // full set still carried
    expect(String(body.message)).toMatch(/and \d+ more/); // the rest are summarised
    expect(String(body.message).length).toBeLessThan(200);
  });
});

describe('reopen a cancelled take → OPEN with a fresh snapshot (owner 2026-11-23)', () => {
  const reopenTables = (status = 'CANCELLED'): Record<string, Row[]> => ({
    stock_takes: [{
      id: 'st-1', take_no: 'STK-2611-006', company_id: CO, status,
      warehouse_id: 'w1', scope_type: 'NONZERO', scope_value: null, nonzero_only: true,
      assignee_staff_id: CALLER_STAFF, blind: false,
      cancelled_at: '2026-11-21T00:00:00Z', posted_at: null,
    }],
    // Stale lines from when it was first created — reopen must replace these.
    stock_take_lines: [
      { id: 'old-1', stock_take_id: 'st-1', item_code: 'OLDGONE', product_name: 'Removed', variant_key: '', system_qty: 2, counted_qty: 2 },
    ],
    v_inventory_all_skus: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'CODY', product_name: 'Cody sofa', category: 'SOFA' },
    ],
    inventory_balances: [
      { company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: '', product_name: 'Cody sofa', qty: 7 },
    ],
  });

  test('CANCELLED → OPEN; the stale sheet is replaced by a snapshot at CURRENT stock, counts cleared', async () => {
    const t = reopenTables();
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/reopen', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('OPEN');
    expect(t.stock_takes[0].cancelled_at).toBeNull();
    const codes = t.stock_take_lines.map((l) => l.item_code);
    expect(codes).toContain('CODY');      // fresh snapshot line
    expect(codes).not.toContain('OLDGONE'); // stale line dropped
    const cody = t.stock_take_lines.find((l) => l.item_code === 'CODY')!;
    expect(cody.system_qty).toBe(7);       // today's on-hand, not the old snapshot
    expect(cody.counted_qty).toBeNull();   // a fresh count
  });

  test('only a CANCELLED take reopens — any other status refuses 409 and nothing changes', async () => {
    const t = reopenTables('OPEN');
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/reopen', 'PATCH');
    expect(res.status).toBe(409);
    expect(((await res.json()) as Row).error).toBe('not_cancelled');
    expect(t.stock_takes[0].status).toBe('OPEN');
    expect(t.stock_take_lines.map((l) => l.item_code)).toEqual(['OLDGONE']); // untouched
  });
});

describe('a found line can carry an entered unit cost from the sheet (owner 2026-11-23)', () => {
  test('a +variance SKU with no priced lot posts when the counter typed a unit cost; the found lot is valued at it', async () => {
    const t = takeFixture();                               // CODY counted 12 vs live 10 -> +2 found
    t.inventory_lots = [];                                 // no priced lot, so no lot cost basis
    t.stock_take_lines[0].entered_unit_cost_sen = 35_000;  // ...but the counter typed RM350 on the sheet
    /* +2 × RM350 = RM700 now exceeds the RM500 value limit (the entered cost GIVES the
       found line a value), so a supervisor posts it — the point here is the valuation,
       not the threshold (covered elsewhere). */
    const res = await jsonReq(harness(t, { perms: ['*'] }).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.stock_takes[0].status).toBe('POSTED');
    // The found +2 books instead of refusing, valued at the entered cost — the lot
    // that opens carries it (the FIFO trigger reads the movement's unit_cost_sen).
    expect(t.inventory_movements).toHaveLength(1);
    expect(t.inventory_movements[0].item_code).toBe('CODY');
    expect(t.inventory_movements[0].qty).toBe(2);
    expect(t.inventory_movements[0].unit_cost_sen).toBe(35_000);
  });

  test('a real lot cost still wins over the entered cost — a hand-typed figure never overrides costed stock', async () => {
    const t = takeFixture();                               // priced open lot RM10 (1000 sen)
    t.stock_take_lines[0].entered_unit_cost_sen = 99_999;  // an entry that must be ignored
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(200);
    expect(t.inventory_movements[0].unit_cost_sen).toBe(1000); // the lot cost, not the typed one
  });

  test('a zero entered cost still refuses — RM0 is never booked', async () => {
    const t = takeFixture();
    t.inventory_lots = [];
    t.stock_take_lines[0].entered_unit_cost_sen = 0;       // 0 is not a cost
    const res = await jsonReq(harness(t).app, '/stock-takes/st-1/post', 'PATCH');
    expect(res.status).toBe(422);
    const body = await res.json() as Row;
    expect(body.error).toBe('cost_required');
    expect(t.inventory_movements).toHaveLength(0);
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

  test('HC-0140: an added line and a sheet line can both be deleted while OPEN; not once POSTED', async () => {
    const t = takeFixture();
    t.mfg_products = [{ code: 'PILLOW', name: 'Pillow', category: 'ACCESSORY', company_id: CO }];
    t.stock_take_lines[0].company_id = CO;
    const { app } = harness(t);
    app.delete('/stock-takes/:id/lines/:lineId', deleteStockTakeLineHandler as never);
    await jsonReq(app, '/stock-takes/st-1/lines', 'POST', { itemCode: 'PILLOW', countedQty: 3 });
    const added = t.stock_take_lines.find((l) => l.item_code === 'PILLOW')!;
    added.id = 'ln-added';
    expect((await jsonReq(app, '/stock-takes/st-1/lines/ln-added', 'DELETE')).status).toBe(200);
    expect(t.stock_take_lines.map((l) => l.id)).toEqual(['ln-1']);
    t.stock_takes[0].status = 'POSTED';
    expect((await jsonReq(app, '/stock-takes/st-1/lines/ln-1', 'DELETE')).status).toBe(409);
    t.stock_takes[0].status = 'OPEN';
    expect((await jsonReq(app, '/stock-takes/st-1/lines/ln-1', 'DELETE')).status).toBe(200);
    expect(t.stock_take_lines).toEqual([]);
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

  test('HC-0158: detail names the PO behind each bucket\'s open lots; a blind OPEN take withholds them', async () => {
    const lot = (over: Row): Row => ({
      company_id: CO, warehouse_id: 'w1', item_code: 'CODY', variant_key: '', unit_cost_sen: 1000,
      qty_remaining: 1, source_doc_type: 'GRN', source_doc_id: null, batch_no: null,
      received_at: '2026-08-01T00:00:00Z', ...over,
    });
    const t = takeFixture();
    t.stock_take_lines.push({ ...t.stock_take_lines[0], id: 'ln-2', variant_key: 'fabric=a', system_qty: -1 });
    t.inventory_lots = [
      lot({ batch_no: 'HC-PO-009630', qty_remaining: 2 }),
      lot({ source_doc_id: 'grn-1', qty_remaining: 3 }),
      lot({ source_doc_id: 'grn-1', qty_remaining: 1 }),
      lot({ source_doc_id: 'grn-2', qty_remaining: 0 }),
      lot({ source_doc_type: 'AC_OPENING', qty_remaining: 4 }),
      lot({ variant_key: 'fabric=a', source_doc_id: 'grn-2', qty_remaining: 0 }),
    ];
    t.grns = [
      { id: 'grn-1', company_id: CO, purchase_order_id: 'po-1' },
      { id: 'grn-2', company_id: CO, purchase_order_id: 'po-2' },
    ];
    t.purchase_orders = [
      { id: 'po-1', company_id: CO, po_number: 'HC-PO-010086' },
      { id: 'po-2', company_id: CO, po_number: 'HC-PO-010100' },
    ];
    const body = await (await harness(t).app.request('/stock-takes/st-1')).json() as Row;
    expect(body.lines[0].source_pos).toEqual([{ po: 'HC-PO-009630', qty: 2 }, { po: 'HC-PO-010086', qty: 4 }]);
    expect(body.lines[1].source_pos).toEqual([]);
    const hidden = await (await harness({ ...t, stock_takes: [{ ...t.stock_takes[0], blind: true }] })
      .app.request('/stock-takes/st-1')).json() as Row;
    expect(hidden.lines[0].source_pos).toEqual([]);
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
