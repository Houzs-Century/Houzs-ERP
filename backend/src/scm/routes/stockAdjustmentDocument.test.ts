// BUG-66 (Sim 2026-10-07): a stock adjustment became a numbered document that
// can be opened and edited. This drives the REAL routes through the fake
// PostgREST client and asserts:
//   - POST writes ONE header + its lines, and every movement carries the
//     document's id and number
//   - an edit moves only the DIFFERENCE per bucket (-3 -> -5 writes one -2)
//   - an edit that would take out more than the bucket holds is refused
//     before anything is written (Sim's "-3 edited to -12" example)
//   - putting written-off stock back enters at the cost it was written off at
//   - a reason / notes-only edit moves no stock
//   - another company's document 404s and nothing is written
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { User } from '@supabase/supabase-js';

import { fakeSb, type Row } from '../lib/fake-postgrest';
import type { Env, Variables } from '../env';

function makeSb() {
  return Object.assign(
    fakeSb({
      warehouses: [{ id: 'wh-1', code: 'KL', company_id: 1 }],
      stock_adjustments: [
        { id: 'sa-1', adjustment_no: 'HC-SA-2610-001', warehouse_id: 'wh-1', notes: null, company_id: 1,
          created_by: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' },
        { id: 'sa-9', adjustment_no: '2990-SA-2610-001', warehouse_id: 'wh-1', notes: 'other company', company_id: 2,
          created_by: null, created_at: '2026-10-07T00:00:00Z', updated_at: '2026-10-07T00:00:00Z' },
      ],
      stock_adjustment_lines: [
        { id: 'l-1', stock_adjustment_id: 'sa-1', company_id: 1, line_no: 1, item_code: 'CH-1', product_name: 'Chair',
          item_group: null, variants: null, description2: null, variant_key: '', batch_no: null, qty: -3,
          reason_code: 'DAMAGE', notes: null },
      ],
      // The original -3 already went out at RM10 a unit; 7 remain open.
      inventory_movements: [
        { id: 'm-1', movement_type: 'ADJUSTMENT', warehouse_id: 'wh-1', item_code: 'CH-1', variant_key: '', batch_no: null,
          qty: -3, unit_cost_sen: 1000, source_doc_type: 'ADJUSTMENT', source_doc_id: 'sa-1',
          source_doc_no: 'HC-SA-2610-001', company_id: 1 },
      ],
      v_inventory_lots_open: [
        { warehouse_id: 'wh-1', item_code: 'CH-1', variant_key: '', batch_no: null, qty_remaining: 7, company_id: 1 },
        { warehouse_id: 'wh-1', item_code: 'CH-2', variant_key: '', batch_no: null, qty_remaining: 4, company_id: 1 },
      ],
      inventory_lots: [
        { warehouse_id: 'wh-1', item_code: 'CH-1', variant_key: '', unit_cost_sen: 1200, qty_remaining: 7,
          source_doc_type: 'GRN', received_at: '2026-09-01T00:00:00Z', company_id: 1 },
        { warehouse_id: 'wh-1', item_code: 'CH-2', variant_key: '', unit_cost_sen: 500, qty_remaining: 4,
          source_doc_type: 'GRN', received_at: '2026-09-01T00:00:00Z', company_id: 1 },
      ],
      entity_audit_log: [],
      app_config: [],
    }),
    { rpc: async (name: string) => ({ data: name === 'next_doc_no_n' ? 1 : true, error: null }) },
  );
}

vi.mock('../../db/supabase', () => ({ getSupabaseService: () => sb }));
vi.mock('../lib/so-stock-allocation', () => ({ recomputeSoStockAllocation: async () => undefined }));
vi.mock('../lib/oversell-retrocost', () => ({ reconcileUncostedAfterIn: async () => ({ reconciled: 0, affectedDoIds: [] }) }));

let sb = makeSb();
beforeEach(() => { sb = makeSb(); });

const movements = () => sb.tables.inventory_movements as Row[];
const docMovements = (id: string) => movements().filter((m) => m.source_doc_id === id);
const docLines = (id: string) => (sb.tables.stock_adjustment_lines as Row[]).filter((l) => l.stock_adjustment_id === id);

const CALLER = {
  id: '7', email: 'store@houzs.test', app_metadata: {},
  user_metadata: { name: 'Store' }, aud: 'authenticated', created_at: '',
} as unknown as User;

const { inventoryAdjustments } = await import('./inventory-adjustments');

async function call(method: string, path: string, body: Record<string, unknown>, companyId = 1) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('user', CALLER);
    c.set('companyId', companyId);
    c.set('supabase', sb as unknown as Variables['supabase']);
    await next();
  });
  app.route('/', inventoryAdjustments);
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

const line = (itemCode: string, qty: number, reasonCode = 'DAMAGE') => ({ itemCode, qty, reasonCode });

describe('POST /inventory/adjustments — one document', () => {
  it('writes one numbered header, its lines, and movements that point back at it', async () => {
    const res = await call('POST', '/', { warehouseId: 'wh-1', lines: [line('CH-1', -1), line('CH-2', 2, 'FOUND')] });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; adjustmentNo: string };
    expect(body.adjustmentNo).toMatch(/^HC-SA-\d{4}-\d{3}$/);
    expect(docLines(body.id).map((l) => [l.item_code, l.qty])).toEqual([['CH-1', -1], ['CH-2', 2]]);
    const mv = docMovements(body.id);
    // Found stock first, so a write-off in the same bucket finds the lot.
    expect(mv.map((m) => [m.item_code, m.qty])).toEqual([['CH-2', 2], ['CH-1', -1]]);
    expect(new Set(mv.map((m) => m.source_doc_no))).toEqual(new Set([body.adjustmentNo]));
  });

  it('refuses a write-off larger than the bucket holds, writing nothing', async () => {
    const before = (sb.tables.stock_adjustments as Row[]).length;
    const res = await call('POST', '/', { warehouseId: 'wh-1', lines: [line('CH-2', -5)] });
    expect(res.status).toBe(422);
    expect((sb.tables.stock_adjustments as Row[]).length).toBe(before);
    expect(movements()).toHaveLength(1);
  });
});

describe('PATCH /inventory/adjustments/:id — edit moves only the difference', () => {
  it('-3 edited to -5 writes ONE -2 movement and replaces the line', async () => {
    const res = await call('PATCH', '/sa-1', { lines: [line('CH-1', -5)] });
    expect(res.status).toBe(200);
    const mv = docMovements('sa-1');
    expect(mv.map((m) => m.qty)).toEqual([-3, -2]);
    expect(docLines('sa-1').map((l) => l.qty)).toEqual([-5]);
    expect((sb.tables.entity_audit_log as Row[]).some((a) => a.action === 'UPDATE' && a.entity_id === 'sa-1')).toBe(true);
  });

  it('-3 edited to -12 needs 9 more but only 7 are open: refused, nothing written', async () => {
    const res = await call('PATCH', '/sa-1', { lines: [line('CH-1', -12)] });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('only 7 on hand');
    expect(docMovements('sa-1')).toHaveLength(1);
    expect(docLines('sa-1').map((l) => l.qty)).toEqual([-3]);
  });

  it('-3 edited to -1 puts 2 back at the cost they were written off at', async () => {
    const res = await call('PATCH', '/sa-1', { lines: [line('CH-1', -1)] });
    expect(res.status).toBe(200);
    const back = docMovements('sa-1')[1]!;
    expect(back.qty).toBe(2);
    expect(back.unit_cost_sen).toBe(1000);
  });

  it('a reason / notes-only edit moves no stock', async () => {
    const res = await call('PATCH', '/sa-1', { notes: 'recount', lines: [line('CH-1', -3, 'WRITEOFF')] });
    expect(res.status).toBe(200);
    expect(docMovements('sa-1')).toHaveLength(1);
    expect(docLines('sa-1').map((l) => l.reason_code)).toEqual(['WRITEOFF']);
    expect((sb.tables.stock_adjustments as Row[]).find((h) => h.id === 'sa-1')!.notes).toBe('recount');
  });

  it("404s on another company's document and writes nothing", async () => {
    const res = await call('PATCH', '/sa-9', { notes: 'should not land' }, 1);
    expect(res.status).toBe(404);
    expect((sb.tables.stock_adjustments as Row[]).find((h) => h.id === 'sa-9')!.notes).toBe('other company');
  });
});
