// GET /purchase-returns/export/rows — the Purchase Returns list's ONE export
// over EVERY return its filters match (owner 2026-09-15), and GET / — the list
// read that shares its filter and its line attach.
//
// Harness follows grn-exports.test.ts: a bare Hono app whose middleware injects
// the fake PostgREST client and a company context, mounting the EXPORTED
// handlers.
//
// WHAT IS ASSERTED is the owner's requirement:
//   1. The export reads every return past the list's 300-row screen cap and
//      PostgREST's response ceiling.
//   2. It follows the list's server filter (status, supplier) and company scope
//      on the header, the line and every lookup.
//   3. Each row carries its lines in the list's shape: AutoCount's item code
//      spelling (HOUZS only), Item Description 2 from the variants, Location as
//      the short code, the GRN / PO links.
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Env, Variables } from '../env';

import { fakeSb } from '../lib/fake-postgrest';
import { purchaseReturnExportRowsHandler } from './purchase-return-exports';
import { purchaseReturnListHandler } from './purchase-returns';
import { buildVariantSummary } from '../shared';
import { bookLineItem } from '../../services/autocount-book-item';

type Row = Record<string, unknown>;

let seq = 0;
const pr = (over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pr-${String(seq).padStart(5, '0')}`,
    company_id: 1,
    return_number: `HC-PRT-2609-${String(seq).padStart(4, '0')}`,
    return_date: '2026-09-10',
    status: 'POSTED',
    supplier_id: 'sup-1',
    supplier: { id: 'sup-1', code: '400-A003', name: 'ANNEX DESIGN SDN BHD' },
    purchase_order_id: null,
    purchase_order: null,
    grn_id: 'grn-1',
    grn: { id: 'grn-1', grn_number: 'HC-GRN-000001', currency: 'MYR', warehouse_id: 'wh-kl' },
    refund_sen: 136800,
    credit_note_ref: null,
    reason: null,
    notes: null,
    ...over,
  };
};

const line = (h: Row, over: Row = {}): Row => {
  seq += 1;
  return {
    id: `pri-${String(seq).padStart(5, '0')}`,
    purchase_return_id: h.id,
    company_id: h.company_id,
    created_at: `2026-09-10T00:00:${String(seq % 60).padStart(2, '0')}Z`,
    grn_item_id: null,
    item_code: 'AN-DINING CHAIR',
    material_name: 'ANNEX DINING CHAIR',
    description: null,
    description2: null,
    notes: null,
    reason: null,
    item_group: 'dining',
    variants: null,
    uom: 'UNIT',
    qty_returned: 8,
    unit_price_sen: 18000,
    line_refund_sen: 136800,
    ...over,
  };
};

type Tables = { prs: Row[]; lines: Row[]; grnLines?: Row[]; grns?: Row[]; poLines?: Row[]; pos?: Row[]; bindings?: Row[] };

function harness(t: Tables, opts: { companyId?: number; companyCode?: string; maxRows?: number | null } = {}) {
  const sb = fakeSb({
    purchase_returns: t.prs,
    purchase_return_items: t.lines,
    grn_items: t.grnLines ?? [],
    grns: t.grns ?? [],
    purchase_order_items: t.poLines ?? [],
    purchase_orders: t.pos ?? [],
    supplier_material_bindings: t.bindings ?? [],
    warehouses: [
      { id: 'wh-kl', code: 'KL WAREHOUSE', name: 'BALAKONG WAREHOUSE' },
      { id: 'wh-pg', code: 'PG WAREHOUSE', name: 'PENANG WAREHOUSE' },
    ],
  }, {}, [], [], opts.maxRows ?? null);
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('supabase', sb as unknown as Variables['supabase']);
    c.set('companyId', (opts.companyId ?? 1) as Variables['companyId']);
    c.set('companyCode', (opts.companyCode ?? 'HOUZS') as Variables['companyCode']);
    await next();
  });
  app.get('/export/rows', purchaseReturnExportRowsHandler);
  app.get('/', purchaseReturnListHandler);
  return app;
}

type PrLine = Record<string, unknown> & { id: string };
type Body = { error?: string; purchaseReturns: Array<Row & { lines: PrLine[] }>; total: number; lineCount: number; truncated: boolean };

const getRows = async (app: ReturnType<typeof harness>, qs = '') => {
  const res = await app.request(`/export/rows${qs}`);
  return { status: res.status, body: (await res.json()) as Body };
};

describe('the export holds every return, not the screen read', () => {
  it('returns every return past the 300-row list cap and the response ceiling, each with its lines', async () => {
    const prs: Row[] = [];
    const lines: Row[] = [];
    for (let i = 0; i < 1_105; i += 1) {
      const h = pr();
      prs.push(h);
      lines.push(line(h));
    }
    const app = harness({ prs, lines }, { maxRows: 1_000 });
    const { status, body } = await getRows(app);
    expect(status).toBe(200);
    expect(body.total).toBe(1_105);
    expect(body.lineCount).toBe(1_105);
    expect(new Set(body.purchaseReturns.flatMap((r) => r.lines.map((l) => l.id))).size).toBe(1_105);
    expect(body.truncated).toBe(false);

    const list = await app.request('/');
    const listBody = (await list.json()) as { purchaseReturns: Row[] };
    expect(listBody.purchaseReturns).toHaveLength(300);
  });
});

describe('the export follows the list filter and the company', () => {
  it('applies status and supplier, as the list does', async () => {
    const a = pr({ status: 'POSTED' });
    const b = pr({ status: 'CANCELLED' });
    const c = pr({ status: 'POSTED', supplier_id: 'sup-2' });
    const app = harness({ prs: [a, b, c], lines: [line(a), line(b), line(c)] });
    expect((await getRows(app, '?status=POSTED')).body.purchaseReturns.map((r) => r.id).sort()).toEqual([a.id, c.id].sort());
    expect((await getRows(app, '?supplierId=sup-2')).body.purchaseReturns.map((r) => r.id)).toEqual([c.id]);
    expect((await getRows(app)).body.total).toBe(3);
  });

  it('never exports another company\'s return, line or link', async () => {
    const mine = pr({ company_id: 1 });
    const theirs = pr({ company_id: 2, return_number: '2990-PRT-THEIRS' });
    const planted = line(mine, { company_id: 2, item_code: 'PLANTED' });
    const linked = line(mine, { grn_item_id: 'gi-2' });
    const tables = {
      prs: [mine, theirs],
      lines: [line(mine), linked, line(theirs), planted],
      grnLines: [{ id: 'gi-2', company_id: 2, grn_id: 'grn-2', purchase_order_item_id: null }],
      grns: [{ id: 'grn-2', company_id: 2, grn_number: '2990-GRN-000001', warehouse_id: 'wh-pg' }],
    };
    const one = await getRows(harness(tables, { companyId: 1 }));
    expect(one.body.purchaseReturns.map((r) => r.id)).toEqual([mine.id]);
    const codes = one.body.purchaseReturns[0]!.lines.map((l) => l.item_code);
    expect(codes).not.toContain('PLANTED');
    expect(one.body.purchaseReturns[0]!.lines.map((l) => l.grn_no)).not.toContain('2990-GRN-000001');

    const two = await getRows(harness(tables, { companyId: 2, companyCode: '2990' }));
    expect(two.body.purchaseReturns.map((r) => r.return_number)).toEqual(['2990-PRT-THEIRS']);
  });
});

describe('each line in the list shape', () => {
  it('links through the GRN line, prints the short location, composes Description 2, spells the item code as AutoCount', async () => {
    const h = pr({ return_number: 'HC-PRT-2609-0001', grn: { id: 'grn-1', grn_number: 'HC-GRN-HEADER', currency: 'MYR', warehouse_id: 'wh-kl' } });
    const l = line(h, {
      grn_item_id: 'gi-1',
      item_code: 'Y04-(K)',
      item_group: 'bedframe',
      variants: { fabricCode: 'BF-01', colourLabel: 'Sand' },
      description2: 'stored text',
      qty_returned: 2,
      unit_price_sen: 5.5,
      line_refund_sen: 11,
      notes: 'torn cover',
      reason: 'damaged',
    });
    const tables = {
      prs: [h],
      lines: [l],
      grnLines: [{ id: 'gi-1', company_id: 1, grn_id: 'grn-9', purchase_order_item_id: 'poi-1' }],
      grns: [{ id: 'grn-9', company_id: 1, grn_number: 'HC-GRN-000610', warehouse_id: 'wh-pg' }],
      poLines: [{ id: 'poi-1', company_id: 1, purchase_order_id: 'po-1' }],
      pos: [{ id: 'po-1', company_id: 1, po_number: 'HC-PO-009951' }],
    };
    const { body } = await getRows(harness(tables));
    const out = body.purchaseReturns[0]!.lines[0]!;
    expect(out).toMatchObject({
      id: l.id,
      item_code: 'AERO-Y04 (K)',
      material_name: 'ANNEX DINING CHAIR',
      description: bookLineItem({ itemCode: 'Y04-(K)', description: 'ANNEX DINING CHAIR', category: 'bedframe', uom: 'UNIT' }, '400-A003').description,
      item_group: bookLineItem({ itemCode: 'Y04-(K)', description: null, category: 'bedframe', uom: 'UNIT' }, '400-A003').itemGroup,
      notes: 'torn cover',
      reason: 'damaged',
      qty_returned: 2,
      unit_price_sen: 5.5,
      line_refund_sen: 11,
      location: 'PG',
      grn_no: 'HC-GRN-000610',
      po_no: 'HC-PO-009951',
    });
    const composed = buildVariantSummary('bedframe', { fabricCode: 'BF-01', colourLabel: 'Sand' });
    expect(composed).not.toBe('');
    expect(out.description2).toBe(composed);
  });

  it('keeps the stored Description 2 when the variants compose nothing, and the ERP item outside the book company', async () => {
    const h = pr({ company_id: 2, return_number: '2990-PRT-2609-0001' });
    const l = line(h, { item_code: 'Y04-(K)', variants: null, description2: 'refer PO4322/PI3835' });
    const { body } = await getRows(harness({ prs: [h], lines: [l] }, { companyId: 2, companyCode: '2990' }));
    const out = body.purchaseReturns[0]!.lines[0]!;
    expect(out.item_code).toBe('Y04-(K)');
    expect(out.item_group).toBe('dining');
    expect(out.description).toBe('ANNEX DINING CHAIR');
    expect(out.description2).toBe('refer PO4322/PI3835');
    expect(out.location).toBe('KL');
    expect(out.grn_no).toBe('HC-GRN-000001');
  });

  it("a live binding for the return supplier's own wins over the cutover snapshot, as on the write-back", async () => {
    const h = pr();
    const l = line(h, { item_code: 'Y04-(K)' });
    const bindings = [
      { id: 'b1', company_id: 1, material_kind: 'mfg_product', item_code: 'Y04-(K)', supplier_id: 'sup-1', supplier_sku: 'AERO-Y04-RENAMED', ac_item_code: null, is_main_supplier: true },
    ];
    const { body } = await getRows(harness({ prs: [h], lines: [l], bindings }));
    expect(body.purchaseReturns[0]!.lines[0]!.item_code).toBe('AERO-Y04-RENAMED');
  });

  it('refuses the file when a lookup fails, rather than exporting blank links', async () => {
    const h = pr();
    const sbTables = { prs: [h], lines: [line(h, { grn_item_id: 'gi-1' })] };
    const sb = fakeSb({
      purchase_returns: sbTables.prs,
      purchase_return_items: sbTables.lines,
      grn_items: [],
      warehouses: [],
    }, { grn_items: ['purchase_order_item_id'] });
    const app = new Hono<{ Bindings: Env; Variables: Variables }>();
    app.use('*', async (c, next) => {
      c.set('supabase', sb as unknown as Variables['supabase']);
      c.set('companyId', 1 as Variables['companyId']);
      await next();
    });
    app.get('/export/rows', purchaseReturnExportRowsHandler);
    const res = await app.request('/export/rows');
    expect(res.status).toBe(500);
    expect(((await res.json()) as { reason: string }).reason).toMatch(/goods received lines/);
  });
});
