/* A SALES INVOICE STATUS MOVE FOLLOWS THE MONEY AND IS COMPARE-AND-SET.
 *
 * patchSalesInvoiceStatusHandler checked only that a move was legal. Two holes:
 *  - PAID / PARTIALLY_PAID could be written by hand with nothing received, so an
 *    invoice read settled with paid_sen 0 (recomputeSiPaid quietly undid it the
 *    next time its money moved).
 *  - every non-cancel write matched on id alone, so a late SENT / OVERDUE that
 *    read the invoice before a cancel landed wrote over CANCELLED and brought back
 *    an invoice whose revenue had already been reversed.
 * Now a paid status must match receipts + order deposit applied + credit notes
 * (409 status_follows_money otherwise), and the write carries
 * `.eq('status', <status read>)`, answering 409 status_changed when it lost.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { patchSalesInvoiceStatusHandler } from '../src/scm/routes/sales-invoices';

const CO = 1;
type Row = Record<string, any>;

class FakeQuery {
  private preds: Array<(r: Row) => boolean> = [];
  private op: 'select' | 'update' = 'select';
  private patch: Row = {};
  constructor(private rows: Row[], private afterRead: () => void) {}
  select() { return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  eq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) === String(val)); return this; }
  neq(col: string, val: unknown) { this.preds.push((r) => String(r[col]) !== String(val)); return this; }
  in(col: string, vals: unknown[]) {
    const s = new Set((vals ?? []).map(String));
    this.preds.push((r) => s.has(String(r[col])));
    return this;
  }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  is() { return this; }
  not() { return this; }
  private run(): Row[] {
    const hit = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.op === 'update') for (const r of hit) Object.assign(r, this.patch);
    return hit;
  }
  maybeSingle() {
    const h = this.run().map((r) => ({ ...r }));
    if (this.op === 'select') this.afterRead();
    return Promise.resolve({ data: h[0] ?? null, error: null });
  }
  single() {
    const h = this.run().map((r) => ({ ...r }));
    return Promise.resolve({ data: h[0] ?? null, error: h.length ? null : { message: 'PGRST116: no rows' } });
  }
  then(res: (v: any) => any, rej?: (e: any) => any) {
    return Promise.resolve({ data: this.run(), error: null }).then(res, rej);
  }
}

/* `concurrent` runs once, right after the handler's first single-row read: another request committing between this
   one's read and its write. */
function harness(tables: Record<string, Row[]>, concurrent: () => void = () => {}) {
  let fired = false;
  const afterRead = () => { if (!fired) { fired = true; concurrent(); } };
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('supabase' as never, {
      from: (t: string) => new FakeQuery((tables[t] ||= []), afterRead),
      rpc: async () => ({ data: null, error: null }),
    } as never);
    c.set('companyId' as never, CO as never);
    c.set('user' as never, { id: 'u1' } as never);
    c.set('houzsUser' as never, { id: 9, name: 'Tester', permissions: ['*'] } as never);
    await next();
  });
  app.patch('/sales-invoices/:id/status', patchSalesInvoiceStatusHandler as never);
  return app;
}

const patch = (app: Hono, status: string) =>
  app.request('/sales-invoices/si-1/status', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });

const si = (over: Row = {}): Row => ({
  id: 'si-1', company_id: CO, invoice_number: 'SI-1', status: 'SENT', paid_sen: 0, total_sen: 1000, so_doc_no: null, ...over,
});

describe('a paid status follows the money recorded', () => {
  test('PAID by hand with nothing received is refused and the status stays', async () => {
    const tables = { sales_invoices: [si()] };
    const res = await patch(harness(tables), 'PAID');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'status_follows_money', settledSen: 0, totalSen: 1000 });
    expect(tables.sales_invoices[0]!.status).toBe('SENT');
  });

  test('PAID with only part received is refused', async () => {
    const tables = { sales_invoices: [si({ paid_sen: 400 })] };
    const res = await patch(harness(tables), 'PAID');
    expect(res.status).toBe(409);
    expect(tables.sales_invoices[0]!.status).toBe('SENT');
  });

  test('PARTIALLY_PAID with nothing received is refused', async () => {
    const tables = { sales_invoices: [si()] };
    const res = await patch(harness(tables), 'PARTIALLY_PAID');
    expect(res.status).toBe(409);
    expect(tables.sales_invoices[0]!.status).toBe('SENT');
  });

  test('a posted credit note counts toward the money', async () => {
    const tables = {
      sales_invoices: [si({ paid_sen: 600 })],
      acc_credit_note_allocations: [{ id: 'a1', note_id: 'cn-1', sales_invoice_id: 'si-1', applied_sen: 400, company_id: CO }],
      acc_credit_notes: [{ id: 'cn-1', status: 'POSTED', company_id: CO }],
    };
    const res = await patch(harness(tables), 'PAID');
    expect(res.status).toBe(200);
    expect(tables.sales_invoices[0]!.status).toBe('PAID');
  });

  test('PAID when receipts cover the total still lands', async () => {
    const tables = { sales_invoices: [si({ paid_sen: 1000 })] };
    const res = await patch(harness(tables), 'PAID');
    expect(res.status).toBe(200);
    expect(tables.sales_invoices[0]!.status).toBe('PAID');
  });
});

describe('a status move that lost the race to a cancel', () => {
  test('the invoice stays CANCELLED and the late move gets 409', async () => {
    const tables = { sales_invoices: [si()] };
    const res = await patch(harness(tables, () => { tables.sales_invoices[0]!.status = 'CANCELLED'; }), 'OVERDUE');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'status_changed' });
    expect(tables.sales_invoices[0]!.status).toBe('CANCELLED');
  });

  test('without a race the move still lands', async () => {
    const tables = { sales_invoices: [si()] };
    const res = await patch(harness(tables), 'OVERDUE');
    expect(res.status).toBe(200);
    expect(tables.sales_invoices[0]!.status).toBe('OVERDUE');
  });
});
