/* A read that FAILED is not a read that found nothing (lib/failed-read-refusal.ts).
 *
 * Every site below used to destructure only `data` from a read in front of a
 * stock, money or status write. supabase-js returns a failed query as
 * `{ data: null, error }` and does not throw, so the null became "no lines" and
 * the write went ahead: a GRN POSTED with no stock IN, a DO shipped reporting no
 * stock errors, a resync reversing a whole shipment. Each test makes exactly one
 * read fail and asserts nothing moved and no status flipped. */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { cancelGrnCommand, postGrnHandler } from '../src/scm/routes/grns';
import { deductInventoryForDo, resyncInventoryForDo } from '../src/scm/routes/delivery-orders-mfg';
import { deletePurchaseReturnItemHandler, writePurchaseReturnMovements } from '../src/scm/routes/purchase-returns';
import { writeTransferMovements } from '../src/scm/routes/stock-transfers';
import { increaseCostSen } from '../src/scm/routes/inventory-adjustments';
import { recomputePoExpectedAt, recomputeSoPicked } from '../src/scm/routes/mfg-purchase-orders';
import { revertShipOnUnreadLines } from '../src/scm/lib/do-read-guards';
import { readOverrideLineCost } from '../src/scm/lib/so-override-cost';
import { hasUnreadableLines, LINES_UNREADABLE } from '../src/scm/lib/failed-read-refusal';
import { scmDb } from '../src/scm/lib/scopedDb';

const CO = 1;
type Row = Record<string, any>;
/** Which read fails: (table, the exact select list) -> true. */
type FailWhen = (table: string, cols: string) => boolean;
const BOOM = { message: 'canceling statement due to statement timeout' };

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' | 'insert' | 'delete' = 'select';
  private cols = '';
  private head = false;
  private patch: Row = {};
  private inserted: Row[] = [];
  constructor(private table: string, private rows: Row[], private failWhen: FailWhen) {}
  select(cols = '*', opts?: { head?: boolean }) { if (this.op === 'select') { this.cols = cols; this.head = !!opts?.head; } return this; }
  insert(v: Row | Row[]) { this.op = 'insert'; this.inserted = Array.isArray(v) ? v : [v]; return this; }
  upsert(v: Row | Row[]) { return this.insert(v); }
  update(v: Row) { this.op = 'update'; this.patch = v; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) { const s = new Set((vals ?? []).map(String)); this.preds.push((r) => s.has(String(r[col]))); return this; }
  is(col: string, val: unknown) { this.preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
  order() { return this; } limit() { return this; } range() { return this; } ilike() { return this; }
  gt() { return this; } gte() { return this; } lt() { return this; } lte() { return this; }
  not() { return this; } like() { return this; } or() { return this; } filter() { return this; }
  private failed() { return this.op === 'select' && this.failWhen(this.table, this.cols); }
  private run(): Row[] {
    if (this.op === 'insert') { this.rows.push(...this.inserted); return this.inserted; }
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    if (this.op === 'delete') for (const r of hit) this.rows.splice(this.rows.indexOf(r), 1);
    return hit;
  }
  maybeSingle() {
    if (this.failed()) return Promise.resolve({ data: null, error: BOOM });
    const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: null });
  }
  single() {
    if (this.failed()) return Promise.resolve({ data: null, error: BOOM });
    const h = this.run(); return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    if (this.failed()) return Promise.resolve({ data: null, count: null, error: BOOM }).then(res, rej);
    const h = this.run();
    return Promise.resolve(this.head ? { data: null, count: h.length, error: null } : { data: h, error: null }).then(res, rej);
  }
}

function fakeSupabase(tables: Record<string, Row[]>, failWhen: FailWhen) {
  const rpcCalls: string[] = [];
  const sb = {
    from: (t: string) => new FakeQuery(t, (tables[t] ||= []), failWhen),
    schema() { return sb; },
    rpc: async (fn: string) => { rpcCalls.push(fn); return { data: true, error: null }; },
  };
  return { sb, rpcCalls };
}

function app(tables: Record<string, Row[]>, failWhen: FailWhen) {
  const { sb, rpcCalls } = fakeSupabase(tables, failWhen);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.patch('/grns/:id/post', postGrnHandler as never);
  a.patch('/grns/:id/cancel', async (c) => cancelGrnCommand(c, c.get('supabase' as never)));
  a.delete('/prs/:id/items/:itemId', deletePurchaseReturnItemHandler as never);
  return { app: a, rpcCalls };
}

const stockRpc = (calls: string[]) => calls.filter((f) => !/audit/i.test(f));

// ── GRN ─────────────────────────────────────────────────────────────────────
function grnTables(status: 'DRAFT' | 'POSTED', poLinked = false): Record<string, Row[]> {
  return {
    grns: [{ id: 'g-1', grn_number: 'GRN-1', company_id: CO, status, warehouse_id: 'w1', total_sen: 0, exchange_rate: 1, migrated_no_stock: false }],
    grn_items: [{
      id: 'gi-1', grn_id: 'g-1', purchase_order_item_id: poLinked ? 'poi-1' : null, qty_accepted: 2, qty_received: 2,
      item_code: 'SKU-1', material_name: 'Chair', unit_price_sen: 10_000, line_total_sen: 20_000,
      item_group: 'chair', variants: null, invoiced_qty: 0, returned_qty: 0, zero_cost_ack: false,
    }],
    purchase_order_items: poLinked ? [{ id: 'poi-1', purchase_order_id: 'po-1', qty: 5, received_qty: 0, warehouse_id: 'w2' }] : [],
    purchase_orders: poLinked ? [{ id: 'po-1', status: 'SUBMITTED', company_id: CO }] : [],
    inventory_balances: [{ warehouse_id: 'w1', item_code: 'SKU-1', variant_key: '', qty: 10 }],
    inventory_movements: [],
  };
}

const confirmGrn = (a: Hono) =>
  a.request('/grns/g-1/post', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });

describe('GRN post refuses when a read in front of it fails', () => {
  const cases: Array<[string, FailWhen, boolean]> = [
    ['the lines (postGrnAndRollup)', (t, c) => t === 'grn_items' && c.includes('zero_cost_ack'), false],
    ['the header (postGrnAndRollup)', (t, c) => t === 'grns' && c === 'grn_number, warehouse_id, company_id, exchange_rate, allocation_method, received_at', false],
    ['the PO-line warehouses (postGrnAndRollup)', (t, c) => t === 'purchase_order_items' && c === 'warehouse_id', true],
    ['the lines (confirm over-receipt check)', (t, c) => t === 'grn_items' && c === 'purchase_order_item_id', false],
  ];
  for (const [what, failWhen, poLinked] of cases) {
    test(`unreadable ${what}: 503, GRN stays DRAFT, no stock IN`, async () => {
      const tables = grnTables('DRAFT', poLinked);
      const { app: a, rpcCalls } = app(tables, failWhen);
      const res = await confirmGrn(a);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error?: string }).error).toBe(LINES_UNREADABLE);
      expect(tables.grns![0]!.status).toBe('DRAFT');
      expect(tables.inventory_movements).toEqual([]);
      expect(stockRpc(rpcCalls)).toEqual([]);
    });
  }

  test('control: the same GRN with every read working posts', async () => {
    const tables = grnTables('DRAFT');
    const res = await confirmGrn(app(tables, () => false).app);
    expect(res.status).toBe(200);
    expect(tables.grns![0]!.status).toBe('POSTED');
  });

  test('cancel with unreadable lines: 503, GRN stays POSTED, no reversing OUT', async () => {
    const tables = grnTables('POSTED');
    const { app: a } = app(tables, (t, c) => t === 'grn_items' && c.startsWith('purchase_order_item_id, qty_accepted'));
    const res = await a.request('/grns/g-1/cancel', { method: 'PATCH' });
    expect(res.status).toBe(503);
    expect(tables.grns![0]!.status).toBe('POSTED');
    expect(tables.inventory_movements).toEqual([]);
  });
});

// ── Delivery order ──────────────────────────────────────────────────────────
function doTables(status: string): Record<string, Row[]> {
  return {
    delivery_orders: [{ id: 'do-1', do_number: 'DO-1', status, warehouse_id: 'w1', is_dropship: false, company_id: CO, migrated_no_stock: false }],
    delivery_order_items: [{ id: 'di-1', delivery_order_id: 'do-1', so_item_id: null, item_code: 'SKU-1', description: 'Chair', qty: 2, item_group: 'chair', variants: null, rack_id: null, committed_po_batch_no: null }],
    inventory_movements: [],
    entity_audit_log: [],
  };
}

describe('DO ship refuses when a read in front of the stock OUT fails', () => {
  const cases: Array<[string, FailWhen]> = [
    ['the lines', (t, c) => t === 'delivery_order_items' && c.includes('rack_id')],
    ['the header', (t, c) => t === 'delivery_orders' && c.startsWith('do_number, warehouse_id')],
    ['the already-deducted check', (t, c) => t === 'inventory_movements' && c === 'id'],
  ];
  for (const [what, failWhen] of cases) {
    test(`unreadable ${what}: reports it (not "no errors") and moves no stock`, async () => {
      const tables = doTables('LOADED');
      const { sb, rpcCalls } = fakeSupabase(tables, failWhen);
      const errors = await deductInventoryForDo(sb, 'do-1', 'u1');
      expect(errors.length).toBe(1);
      expect(hasUnreadableLines(errors)).toBe(true);
      expect(tables.inventory_movements).toEqual([]);
      expect(stockRpc(rpcCalls)).toEqual([]);
    });
  }

  test('the ship flip is put back over the status this request wrote, company-scoped', async () => {
    const tables = doTables('LOADED');
    tables.delivery_orders![0]!.dispatched_at = '2026-11-10T00:00:00Z';
    const { sb } = fakeSupabase(tables, () => false);
    const body = await revertShipOnUnreadLines(sb, 'do-1', CO, 'LOADED', 'DRAFT', { dispatched_at: 'x' }, null, ['e'], null);
    expect(body.reverted).toBe(true);
    expect(body.error).toBe(LINES_UNREADABLE);
    expect(tables.delivery_orders![0]!.status).toBe('DRAFT');
    expect(tables.delivery_orders![0]!.dispatched_at).toBeNull();
  });

  test('the revert never touches another company\'s DO', async () => {
    const tables = doTables('LOADED');
    const { sb } = fakeSupabase(tables, () => false);
    const body = await revertShipOnUnreadLines(sb, 'do-1', 2, 'LOADED', 'DRAFT', {}, null, ['e'], 'DO-1');
    expect(body.reverted).toBe(false);
    expect(tables.delivery_orders![0]!.status).toBe('LOADED');
  });
});

describe('DO resync writes no delta when a read fails', () => {
  const cases: Array<[string, FailWhen]> = [
    // "no lines" made the delta return every unit shipped
    ['the lines', (t, c) => t === 'delivery_order_items' && c.includes('committed_po_batch_no')],
    // "no movements" made the delta ship everything a second time
    ['the existing movements', (t, c) => t === 'inventory_movements' && c.startsWith('movement_type')],
  ];
  for (const [what, failWhen] of cases) {
    test(`unreadable ${what}: no movement, RECOUNT_FAILED on the trail`, async () => {
      const tables = doTables('LOADED');
      tables.inventory_movements!.push({ source_doc_type: 'DO', source_doc_id: 'do-1', movement_type: 'OUT', warehouse_id: 'w1', item_code: 'SKU-1', variant_key: '', qty: 2, total_cost_sen: 0 });
      const { sb } = fakeSupabase(tables, failWhen);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      await resyncInventoryForDo(sb, 'do-1', 'u1');
      err.mockRestore();
      expect(tables.inventory_movements).toHaveLength(1);
      expect(tables.entity_audit_log!.some((r) => r.action === 'RECOUNT_FAILED')).toBe(true);
    });
  }
});

// ── Purchase return ─────────────────────────────────────────────────────────
function prTables(): Record<string, Row[]> {
  return {
    purchase_returns: [{ id: 'pr-1', return_number: 'PR-1', company_id: CO, grn_id: null, kind: 'CREDIT', repair_warehouse_id: null, status: 'DRAFT' }],
    purchase_return_items: [{ id: 'pri-1', purchase_return_id: 'pr-1', company_id: CO, grn_item_id: null, item_code: 'SKU-1', material_name: 'Chair', qty_returned: 1, item_group: 'chair', variants: null }],
    warehouses: [{ id: 'w1', company_id: CO, is_default: true, code: 'KL' }],
    inventory_movements: [],
  };
}

describe('Purchase return refuses when a read in front of its stock write fails', () => {
  const cases: Array<[string, FailWhen]> = [
    ['the lines', (t, c) => t === 'purchase_return_items' && c.startsWith('id, grn_item_id')],
    ['the header', (t, c) => t === 'purchase_returns' && c.startsWith('company_id, kind')],
  ];
  for (const [what, failWhen] of cases) {
    test(`post with unreadable ${what}: reported, no stock OUT`, async () => {
      const tables = prTables();
      const { sb } = fakeSupabase(tables, failWhen);
      const errors = await writePurchaseReturnMovements(sb, 'pr-1', 'PR-1', null, 'u1');
      expect(hasUnreadableLines(errors)).toBe(true);
      expect(tables.inventory_movements).toEqual([]);
    });
  }

  test('line delete with an unreadable header: 503 BEFORE the delete, the line survives', async () => {
    const tables = prTables();
    const { app: a } = app(tables, (t, c) => t === 'purchase_returns' && c === 'return_number, grn_id');
    const res = await a.request('/prs/pr-1/items/pri-1', { method: 'DELETE' });
    expect(res.status).toBe(503);
    expect(tables.purchase_return_items).toHaveLength(1);
    expect(tables.inventory_movements).toEqual([]);
  });
});

// ── Stock transfer / adjustment ─────────────────────────────────────────────
function ctxFor(sb: unknown) {
  const store: Record<string, unknown> = { supabase: sb, companyId: CO, allowedCompanyIds: [CO] };
  return { get: (k: string) => store[k] } as never;
}

describe('Stock transfer and adjustment refuse on a failed read', () => {
  test('transfer with unreadable lines: reported (the caller cancels), nothing moved', async () => {
    const tables: Record<string, Row[]> = { stock_transfer_lines: [{ stock_transfer_id: 't-1', item_code: 'SKU-1', qty: 1 }], inventory_movements: [] };
    const { sb, rpcCalls } = fakeSupabase(tables, (t) => t === 'stock_transfer_lines');
    const c = ctxFor(sb);
    const errors = await writeTransferMovements(scmDb(c), { id: 't-1', transfer_no: 'ST-1', from_warehouse_id: 'w1', to_warehouse_id: 'w2' }, 'u1', CO, c);
    expect(hasUnreadableLines(errors)).toBe(true);
    expect(tables.inventory_movements).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  test('adjustment cost with unreadable lots is an error, never a guessed cost', async () => {
    const { sb } = fakeSupabase({ inventory_lots: [{ warehouse_id: 'w1', item_code: 'SKU-1', variant_key: '', unit_cost_sen: 500, qty_remaining: 1 }] }, (t) => t === 'inventory_lots');
    const c = ctxFor(sb);
    const out = await increaseCostSen(scmDb(c), c, 'w1', { item_code: 'SKU-1', variant_key: '' } as never, 0);
    expect(out).toBeInstanceOf(Error);
  });
});

// ── PO counters and SO price override ───────────────────────────────────────
describe('PO recounts skip their write when the read fails', () => {
  test('unreadable PO lines: po_qty_picked is not zeroed', async () => {
    const tables: Record<string, Row[]> = { purchase_order_items: [{ so_item_id: 'soi-1', qty: 3, purchase_order_id: 'po-1' }], purchase_orders: [{ id: 'po-1', status: 'SUBMITTED' }], mfg_sales_order_items: [{ id: 'soi-1', po_qty_picked: 3 }] };
    const { sb } = fakeSupabase(tables, (t) => t === 'purchase_order_items');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await recomputeSoPicked(sb, ['soi-1']);
    err.mockRestore();
    expect(tables.mfg_sales_order_items![0]!.po_qty_picked).toBe(3);
  });

  test('unreadable PO statuses: a DRAFT PO line is not counted as picked', async () => {
    const tables: Record<string, Row[]> = { purchase_order_items: [{ so_item_id: 'soi-1', qty: 3, purchase_order_id: 'po-1' }], purchase_orders: [{ id: 'po-1', status: 'DRAFT' }], mfg_sales_order_items: [{ id: 'soi-1', po_qty_picked: 0 }] };
    const { sb } = fakeSupabase(tables, (t) => t === 'purchase_orders');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await recomputeSoPicked(sb, ['soi-1']);
    err.mockRestore();
    expect(tables.mfg_sales_order_items![0]!.po_qty_picked).toBe(0);
  });

  test('unreadable PO lines: expected_at is not blanked', async () => {
    const tables: Record<string, Row[]> = { purchase_order_items: [{ purchase_order_id: 'po-1', delivery_date: '2026-12-01' }], purchase_orders: [{ id: 'po-1', expected_at: '2026-12-01' }] };
    const { sb } = fakeSupabase(tables, (t) => t === 'purchase_order_items');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await recomputePoExpectedAt(sb, 'po-1');
    err.mockRestore();
    expect(tables.purchase_orders![0]!.expected_at).toBe('2026-12-01');
  });

  test('SO price override: an unreadable line cost is a failure, not a zero cost', async () => {
    const { sb } = fakeSupabase({ mfg_sales_order_items: [{ id: 'soi-1', line_cost_sen: 7000 }] }, (t) => t === 'mfg_sales_order_items');
    expect((await readOverrideLineCost(sb, 'soi-1')).ok).toBe(false);
    const { sb: ok } = fakeSupabase({ mfg_sales_order_items: [{ id: 'soi-1', line_cost_sen: 7000 }] }, () => false);
    expect(await readOverrideLineCost(ok, 'soi-1')).toEqual({ ok: true, costSen: 7000 });
  });
});
