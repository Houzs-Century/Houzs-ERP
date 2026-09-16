// GET /sales-invoices/export/rows — every Sales Invoice the list's filter and
// the caller's sales scope match, each carrying its lines, for the grid-driven
// export (owner 2026-09-15). Harness as sales-invoice-exports.test.ts.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';
import { fakeSb } from '../lib/fake-postgrest';
import { readSiExportRows, siExportAgent } from '../lib/si-export-rows';
import { siExportRowsHandler } from './sales-invoice-exports';

type Row = Record<string, unknown>;
let seq = 0;
const si = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `si-${String(seq).padStart(5, '0')}`, company_id: 1, invoice_number: `HC-SI-${String(seq).padStart(6, '0')}`,
    linked_ac_docno: null, invoice_date: '2026-09-01', status: 'SENT', debtor_code: '300-C001', debtor_name: 'TAN AH KOW',
    ref: null, customer_so_no: null, po_doc_no: null, due_date: null, total_sen: 100000, local_total_sen: 100000, paid_sen: 0,
    salesperson_id: 'staff-1', agent: null, branding: 'HOUZS', venue: null, phone: null, so_doc_no: null, sales_location: 'KL WAREHOUSE',
    delivery_order_id: null, ...over,
  };
};
const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `sii-${String(seq).padStart(5, '0')}`, sales_invoice_id: h.id, company_id: h.company_id, line_no: 1, created_at: '2026-09-01T00:00:00Z',
    do_item_id: null, item_code: 'CODY-(K)', item_group: 'mattress', description: 'CODY KING', description2: null, notes: null, uom: 'UNIT',
    qty: 1, unit_price_sen: 100000, discount_sen: 0, line_total_sen: 100000, line_delivery_date: null, variants: null, ...over,
  };
};

type Tables = { sis: Row[]; lines: Row[]; doLines?: Row[]; dos?: Row[] };
const tables = (t: Tables) => ({
  sales_invoices: t.sis, sales_invoice_items: t.lines, delivery_order_items: t.doLines ?? [], delivery_orders: t.dos ?? [],
  mfg_sales_orders: [], mfg_sales_order_payments: [], supplier_material_bindings: [], staff: [{ id: 'staff-1', name: 'Siti' }],
  warehouses: [{ id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG' }, { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG' }],
});
function app(t: Tables, companyId = 1, maxRows: number | null = null) {
  const sb = fakeSb(tables(t), {}, [], [], maxRows);
  const a = new Hono<{ Bindings: Env; Variables: Variables }>();
  a.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', companyId as Variables['companyId']);
    c.set('houzsUser', { id: 7, permissions_set: new Set(['*']) } as unknown as Variables['houzsUser']);
    await next();
  });
  a.get('/export/rows', siExportRowsHandler);
  return a;
}
type Body = { salesInvoices: Array<Row & { ac_agent: string | null; lines: Row[] }>; total: number; lineCount: number; truncated: boolean };

describe('GET /sales-invoices/export/rows', () => {
  it('holds every invoice of the tab past the ceiling, with the list stamps and lines', async () => {
    const sis: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_001; i += 1) {
      const h = si();
      sis.push(h);
      lines.push(line(h));
    }
    const paid = si({ status: 'PAID' });
    const res = await app({ sis: [...sis, paid], lines: [...lines, line(paid)] }, 1, 1_000).request('/export/rows?status=sent');
    const body = (await res.json()) as Body;
    expect(res.status).toBe(200);
    expect(body.total).toBe(1_001);
    expect(body.lineCount).toBe(1_001);
    expect(body.salesInvoices.map((r) => r.id)).not.toContain(paid.id);
    expect(body.salesInvoices.every((r) => r.so_deposit_applied_sen === 0)).toBe(true);
  });

  it('reaches the delivery order through the DO line, company-scoped, and prints the agent as the book spells it', async () => {
    const h = si();
    const l = line(h, { do_item_id: 'doi-1', description2: 'typed' });
    const planted = line(h, { company_id: 2 });
    const res = await app({
      sis: [h],
      lines: [l, planted],
      doLines: [{ id: 'doi-1', company_id: 1, delivery_order_id: 'do-1' }],
      dos: [{ id: 'do-1', company_id: 1, do_number: 'HC-DO-2608-010', warehouse_id: 'wh-pg', sales_location: 'KL WAREHOUSE' }],
    }).request('/export/rows');
    const body = (await res.json()) as Body;
    expect(body.salesInvoices[0]!.ac_agent).toBe('Siti');
    expect(body.salesInvoices[0]!.lines.map((x) => x.id)).toEqual([l.id]);
    expect(body.salesInvoices[0]!.lines[0]).toMatchObject({ do_no: 'HC-DO-2608-010', location: 'PG', description2: 'typed', unit_price_sen: 100000 });
  });

  it('holds only the sellers the caller may see', async () => {
    const mine = si({ salesperson_id: 'staff-1' });
    const other = si({ salesperson_id: 'staff-9' });
    const sb = fakeSb(tables({ sis: [mine, other], lines: [line(mine), line(other)] }));
    const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) };
    const out = await readSiExportRows(sb, ctx, { status: null, q: null, from: null, to: null, sort: null, debtorNames: null, currencies: null }, ['staff-1']);
    if (out.error !== null) throw new Error(out.error);
    expect(out.rows.map((r) => r.id)).toEqual([mine.id]);
  });

  it('prints the agent in the agent map spelling, and none when nobody is named', () => {
    expect(siExportAgent(null, 'ZACK')).toBe('Zack');
    expect(siExportAgent(null, 'CHEA HUAN')).toBe('Chea Huan');
    expect(siExportAgent(null, null)).toBeNull();
  });
});
