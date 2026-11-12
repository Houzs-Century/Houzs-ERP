/* A read that FAILED is not a read that found nothing — on the screens.
 *
 * refuseOnFailedRead.test.ts covers the reads in front of stock, money and
 * status WRITES. This file covers the reads whose empty answer used to be SHOWN
 * as a real answer: an SO whose payments read failed printed "paid 0.00" and the
 * whole total as owing, a PO whose receipts read failed showed every line as not
 * received, a GRN whose invoice read failed said a billed note had no invoice,
 * the document map drew an order with no payment. Each test makes exactly one
 * read fail and asserts the answer is an error (lib/read-failure.ts's
 * `load_failed` body), never a made-up 0 or empty list. */
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, test } from 'vitest';

import {
  computeSoLifecycle, doLineConsumedQty, soCurrentDocNo, soLineDeliveries,
} from '../src/scm/routes/delivery-orders-mfg';
import { deleteSoPaymentHandler, mfgSalesOrders } from '../src/scm/routes/mfg-sales-orders';
import { mfgPurchaseOrders } from '../src/scm/routes/mfg-purchase-orders';
import { grns } from '../src/scm/routes/grns';
import { documentFlow } from '../src/scm/routes/document-flow';
import { SCM_SYSTEM_STAFF_ID } from '../src/scm/middleware/auth';

const CO = 1;
type Row = Record<string, any>;
/** Which read fails: (table, the select list) -> true. */
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
  contains() { return this; } overlaps() { return this; } match() { return this; } returns() { return this; }
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
  const sb: any = {
    from: (t: string) => new FakeQuery(t, (tables[t] ||= []), failWhen),
    schema() { return sb; },
    rpc: async () => ({ data: null, error: null }),
  };
  return sb;
}

function harness(tables: Record<string, Row[]>, failWhen: FailWhen) {
  const sb = fakeSupabase(tables, failWhen);
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('supabase' as never, sb as never);
    c.set('companyId' as never, CO as never);
    c.set('allowedCompanyIds' as never, [CO] as never);
    c.set('user' as never, { id: SCM_SYSTEM_STAFF_ID } as never); // supabaseAuth steps aside
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions_set: new Set(['*']) } as never);
    await next();
  });
  a.route('/so', mfgSalesOrders);
  a.delete('/so-pay/:docNo/payments/:id', deleteSoPaymentHandler as never);
  a.route('/po', mfgPurchaseOrders);
  a.route('/grns', grns);
  a.route('/document-flow', documentFlow);
  return a;
}

const failOn = (table: string, colsHas = ''): FailWhen => (t, cols) => t === table && cols.includes(colsHas);

async function expectLoadFailed(res: Response, stage: string) {
  expect(res.status).toBe(500);
  const body = await res.json() as { error?: string; stage?: string; reason?: string };
  expect(body.error).toBe('load_failed');
  expect(body.stage).toBe(stage);
  expect(body.reason).toMatch(/^Could not load /);
}

// ── Shared fixtures ─────────────────────────────────────────────────────────
function salesTables(): Record<string, Row[]> {
  return {
    mfg_sales_orders: [{ doc_no: 'SO-1', company_id: CO, status: 'CONFIRMED', debtor_code: null, total_sen: 50_000, salesperson_id: null, open_to_all: true }],
    mfg_sales_order_items: [{ id: 'soi-1', doc_no: 'SO-1', company_id: CO, item_code: 'SKU-1', item_group: 'chair', qty: 2 }],
    delivery_orders: [{ id: 'do-1', do_number: 'DO-1', so_doc_no: 'SO-1', company_id: CO, status: 'DELIVERED', do_date: '2026-11-01', created_at: '2026-11-01' }],
    delivery_order_items: [{ id: 'doi-1', delivery_order_id: 'do-1', so_item_id: 'soi-1', qty: 2 }],
    sales_invoices: [{ id: 'si-1', invoice_number: 'SI-1', so_doc_no: 'SO-1', delivery_order_id: 'do-1', company_id: CO, status: 'POSTED', invoice_date: '2026-11-02', created_at: '2026-11-02' }],
    sales_invoice_items: [{ sales_invoice_id: 'si-1', do_item_id: 'doi-1', so_item_id: 'soi-1', qty: 2 }],
    sales_invoice_payments: [{ id: 'sip-1', sales_invoice_id: 'si-1', method: 'cash', approval_code: null, amount_sen: 50_000, company_id: CO }],
    delivery_returns: [{ id: 'dr-1', delivery_order_id: 'do-1', return_number: 'DR-1', status: 'POSTED', return_date: '2026-11-03', created_at: '2026-11-03' }],
    delivery_return_items: [],
    mfg_sales_order_payments: [{ id: 'pay-1', so_doc_no: 'SO-1', company_id: CO, amount_sen: 50_000, is_deposit: true, version: 1, method: 'cash', created_at: '2026-11-01T02:00:00Z', paid_at: '2026-11-01' }],
  };
}

// ── DO helpers the SO, SO list and DO line edit read through ────────────────
describe('delivery helpers throw on a failed read instead of answering empty', () => {
  const sbFailing = (table: string, colsHas = '') => fakeSupabase(salesTables(), failOn(table, colsHas));

  test('soLineDeliveries: no "nothing delivered" when the DO lines cannot be read', async () => {
    await expect(soLineDeliveries(sbFailing('delivery_order_items'), ['soi-1'])).rejects.toBeInstanceOf(HTTPException);
    await expect(soLineDeliveries(sbFailing('delivery_orders'), ['soi-1'])).rejects.toBeInstanceOf(HTTPException);
    // Control: the same data, read cleanly, is a real delivery.
    const ok = await soLineDeliveries(fakeSupabase(salesTables(), () => false), ['soi-1']);
    expect(ok.get('soi-1')).toEqual([{ doNumber: 'DO-1', qty: 2, status: 'DELIVERED' }]);
  });

  test('computeSoLifecycle / soCurrentDocNo: no "none" badge when a read fails', async () => {
    for (const t of ['delivery_orders', 'sales_invoices', 'delivery_returns']) {
      await expect(computeSoLifecycle(sbFailing(t), ['SO-1'])).rejects.toBeInstanceOf(HTTPException);
      await expect(soCurrentDocNo(sbFailing(t), ['SO-1'])).rejects.toBeInstanceOf(HTTPException);
    }
    const ok = await computeSoLifecycle(fakeSupabase(salesTables(), () => false), ['SO-1']);
    expect(ok.get('SO-1')).toBe('returned');
  });

  test('doLineConsumedQty: a failed read is not a floor of 0', async () => {
    for (const t of ['sales_invoice_items', 'sales_invoices', 'delivery_return_items']) {
      const err = await doLineConsumedQty(sbFailing(t), 'doi-1').catch((e) => e);
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).status).toBe(500);
    }
    expect(await doLineConsumedQty(fakeSupabase(salesTables(), () => false), 'doi-1')).toBe(2);
  });
});

// ── Sales order payments ────────────────────────────────────────────────────
describe('sales order payments: a failed read is an error, not "no payment"', () => {
  test('SO detail answers 500 when the payments ledger cannot be read', async () => {
    const res = await harness(salesTables(), failOn('mfg_sales_order_payments', 'amount_sen, is_deposit')).request('/so/SO-1');
    await expectLoadFailed(res, 'so_payments');
  });

  test('SO detail answers 500 when the lines cannot be read', async () => {
    const res = await harness(salesTables(), (t, cols) => t === 'mfg_sales_order_items' && cols.includes('item_code')).request('/so/SO-1');
    expect(res.status).toBe(500);
  });

  test('deleting a payment whose row cannot be read is 500, not 404 "not found"', async () => {
    const res = await harness(salesTables(), failOn('mfg_sales_order_payments')).request('/so-pay/SO-1/payments/pay-1?version=1', { method: 'DELETE' });
    await expectLoadFailed(res, 'so_payments');
  });
});

// ── Purchase order receipts ─────────────────────────────────────────────────
describe('purchase order: a failed receipts read is an error, not "nothing received"', () => {
  test('PO detail answers 500 when the GRN lines cannot be read', async () => {
    const tables: Record<string, Row[]> = {
      purchase_orders: [{ id: 'po-1', po_number: 'PO-1', company_id: CO, status: 'SUBMITTED' }],
      purchase_order_items: [{ id: 'poi-1', purchase_order_id: 'po-1', item_code: 'SKU-1', qty: 5, company_id: CO }],
      grn_items: [{ id: 'gi-1', grn_id: 'g-1', purchase_order_item_id: 'poi-1', qty_accepted: 5, returned_qty: 0, returned_closed_qty: 0 }],
      grns: [{ id: 'g-1', grn_number: 'GRN-1', status: 'POSTED', company_id: CO, purchase_order_id: 'po-1' }],
    };
    const res = await harness(tables, failOn('grn_items', 'returned_closed_qty')).request('/po/po-1');
    await expectLoadFailed(res, 'po_line_receipts');
  });
});

// ── GRN linked invoices ─────────────────────────────────────────────────────
describe('GRN linked documents: a failed read is an error, not "no invoice yet"', () => {
  test('answers 500 when the line-level invoice read fails', async () => {
    const tables: Record<string, Row[]> = {
      grns: [{ id: 'g-1', company_id: CO, purchase_order_id: null }],
      grn_items: [{ id: 'gi-1', grn_id: 'g-1' }],
      purchase_invoice_items: [{ purchase_invoice_id: 'pi-9', grn_item_id: 'gi-1' }],
      purchase_invoices: [{ id: 'pi-9', invoice_number: 'PI-9', status: 'POSTED', invoice_date: '2026-11-01', grn_id: 'g-other' }],
      purchase_returns: [],
    };
    const res = await harness(tables, failOn('purchase_invoice_items')).request('/grns/g-1/linked');
    await expectLoadFailed(res, 'grn_linked_invoices');
    // Control: read cleanly, the invoice billed on another note's PI is listed.
    const ok = await harness(tables, () => false).request('/grns/g-1/linked');
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { invoices: Array<{ id: string }> }).invoices.map((v) => v.id)).toEqual(['pi-9']);
  });
});

// ── Document flow ───────────────────────────────────────────────────────────
describe('document flow: a failed sales-chain read is an error, not a missing node', () => {
  for (const table of ['mfg_sales_order_items', 'delivery_orders', 'sales_invoices', 'sales_invoice_payments', 'delivery_returns']) {
    test(`answers 500 when ${table} cannot be read`, async () => {
      const cols = table === 'mfg_sales_order_items' ? 'id, doc_no, qty'
        : table === 'delivery_orders' ? 'id, do_number, status, so_doc_no'
        : table === 'sales_invoices' ? 'id, invoice_number, status, so_doc_no, delivery_order_id'
        : table === 'delivery_returns' ? 'id, return_number, status, delivery_order_id'
        : '';
      const res = await harness(salesTables(), (t, c) => t === table && (cols === '' || c === cols)).request('/document-flow/so/SO-1');
      await expectLoadFailed(res, 'document_flow');
    });
  }

  test('control: read cleanly, the payment node is on the map', async () => {
    const res = await harness(salesTables(), () => false).request('/document-flow/so/SO-1');
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Array<{ type: string }> };
    expect(body.nodes.some((n) => n.type === 'payment')).toBe(true);
  });
});
