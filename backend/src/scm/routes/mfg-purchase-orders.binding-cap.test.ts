import { describe, expect, test } from 'vitest';
import { convertSosToPosCore, type PoConvertContext } from './mfg-purchase-orders';
import { parsePgrestInList } from '../lib/pgrest-in-list';

type Row = Record<string, unknown>;

const PGRST_MAX_ROWS = 1000;

function fakeSb(tables: Record<string, Row[]>, captured: Row[]) {
  class Q {
    rows: Row[];
    private table: string;
    private singleRow = false;
    private window: [number, number] | null = null;
    private orders: Array<{ col: string; asc: boolean }> = [];
    constructor(table: string, rows: Row[]) { this.table = table; this.rows = [...rows]; }
    select() { return this; }
    eq(col: string, val: unknown) { this.rows = this.rows.filter((r) => r[col] === val); return this; }
    in(col: string, vals: unknown[]) { const s = new Set(vals); this.rows = this.rows.filter((r) => s.has(r[col])); return this; }
    /* The ESCAPED in-list the shared readers now build — supabase-js cannot
       serialise a value carrying a `"` (docs/bugs/0780). Parsed by the SAME
       function the app writes with, never a second split(','). */
    filter(col: string, op: string, val: string) {
      if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
      return this.in(col, parsePgrestInList(val));
    }
    not() { return this; }
    is(col: string, val: unknown) { if (val === null) this.rows = this.rows.filter((r) => r[col] == null); return this; }
    or() { return this; }
    like() { return this; }
    ilike() { return this; }
    gte() { return this; }
    lte() { return this; }
    order(col?: string, o?: { ascending?: boolean }) {
      if (col) this.orders.push({ col, asc: o?.ascending !== false });
      return this;
    }
    limit(n: number) { this.rows = this.rows.slice(0, n); return this; }
    range(from: number, to: number) { this.window = [from, to]; return this; }
    maybeSingle() { this.singleRow = true; return this; }
    single() { this.singleRow = true; return this; }
    update() { return this; }
    delete() { return this; }
    insert(payload: Row | Row[]) {
      const rows = Array.isArray(payload) ? payload : [payload];
      if (this.table === 'purchase_order_items') captured.push(...rows);
      if (this.table === 'purchase_orders') {
        this.rows = rows.map((r, i) => ({ ...r, id: `po-new-${i + 1}`, po_number: r.po_number ?? 'PO-2608-001' }));
      } else {
        this.rows = rows;
      }
      return this;
    }
    private sorted(): Row[] {
      if (this.orders.length === 0) return this.rows;
      return this.rows
        .map((r, i) => ({ r, i }))
        .sort((a, b) => {
          for (const { col, asc } of this.orders) {
            const av = a.r[col], bv = b.r[col];
            if (av === bv) continue;
            const cmp = (av == null) ? 1 : (bv == null) ? -1 : av < bv ? -1 : 1;
            return asc ? cmp : -cmp;
          }
          return a.i - b.i;
        })
        .map((x) => x.r);
    }
    private result() {
      if (this.singleRow) return { data: this.rows[0] ?? null, error: null as null };
      const rows = this.sorted();
      const windowed = this.window ? rows.slice(this.window[0], this.window[1] + 1) : rows;
      return { data: windowed.slice(0, PGRST_MAX_ROWS), error: null as null };
    }
    then<T>(onF: (v: { data: unknown; error: null }) => T, onR?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(onF, onR);
    }
  }
  return { from: (table: string) => new Q(table, tables[table] ?? []) };
}

const SUPPLIER_ID = 'sup-1';
const DOC = 'SO-2608-001';
/* The filler catalogue rides on a SECOND order: a sofa set must leave in ONE
   purchase order (one supplier per set, owner 2026-10-05, refused as
   sofa_set_supplier_split), and the fillers stay on the main supplier while
   the three modules under test are picked onto an alternate. */
const FILLER_DOC = 'SO-2608-002';

const MODULES = ['9028-1A(LHF)', '9028-1A(RHF)', '9028-1NA'] as const;

const soLine = (id: string, itemCode: string, docNo: string = DOC): Row => ({
  id, doc_no: docNo, item_code: itemCode, description: itemCode,
  item_group: 'SOFA', variants: {}, qty: 1, po_qty_picked: 0,
  unit_price_sen: 100000, line_delivery_date: '2026-09-30', warehouse_id: 'wh-kl',
  photo_urls: [],
  so: { sales_location: 'KL', customer_delivery_date: '2026-09-30' },
});

const ALTERNATES = ['sup-2', 'sup-3'];
const bindingsFor = (itemCode: string): Row[] => [
  {
    id: `bind-${itemCode}-main`, item_code: itemCode, material_kind: 'mfg_product',
    supplier_id: SUPPLIER_ID, supplier_sku: `AC-${itemCode}`, unit_price_sen: 50000,
    currency: 'MYR', price_matrix: null, is_main_supplier: true,
  },
  ...ALTERNATES.map((sid) => ({
    id: `bind-${itemCode}-${sid}`, item_code: itemCode, material_kind: 'mfg_product',
    supplier_id: sid, supplier_sku: `ALT-${itemCode}`, unit_price_sen: 60000,
    currency: 'MYR', price_matrix: null, is_main_supplier: false,
  })),
];

async function convertWithCatalogue(filler: number, pickSupplierId?: string) {
  const captured: Row[] = [];
  const fillerCodes = Array.from({ length: filler }, (_, i) => `FILL-${String(i).padStart(5, '0')}`);
  const soLines = [
    ...fillerCodes.map((code, i) => soLine(`si-f-${String(i).padStart(5, '0')}`, code, FILLER_DOC)),
    ...MODULES.map((code, i) => soLine(`si-${i}`, code)),
  ];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    mfg_sales_orders: [{ doc_no: DOC, status: 'CONFIRMED' }, { doc_no: FILLER_DOC, status: 'CONFIRMED' }],
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
    suppliers: [
      { id: SUPPLIER_ID, code: '400-H004', name: 'HOOKKA INDUSTRIES' },
      ...ALTERNATES.map((id, i) => ({ id, code: `400-A00${i}`, name: `ALT ${i}` })),
    ],
    supplier_material_bindings: [
      ...fillerCodes.flatMap(bindingsFor),
      ...MODULES.flatMap(bindingsFor),
    ],
    fabric_trackings: [],
    mrp_category_lead_times: [],
    sofa_combo_pricing: [],
    purchase_orders: [],
    purchase_order_items: [],
  }, captured);

  const ctx = {
    req: {
      json: async () => ({
        picks: soLines.map((l) => ({
          soItemId: l.id, qty: 1,
          ...(pickSupplierId && (MODULES as readonly string[]).includes(l.item_code as string)
            ? { supplierId: pickSupplierId }
            : {}),
        })),
      }),
    },
    get: (key: string) => {
      if (key === 'supabase') return sb;
      if (key === 'user') return { id: 'user-1' };
      return undefined;
    },
    env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
    json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
  } as unknown as PoConvertContext;

  return { out: await convertSosToPosCore(ctx), captured };
}

describe('SO -> PO convert: a bound SKU past the response cap is still bound', () => {
  test('a small pick puts each module on the supplier the operator chose (control)', async () => {
    const { out, captured } = await convertWithCatalogue(10, 'sup-3');
    expect(out.status).toBe(201);
    const modules = captured.filter((r) => (MODULES as readonly string[]).includes(r.item_code as string));
    expect(modules).toHaveLength(3);
    for (const r of modules) expect(r.supplier_sku).toBe(`ALT-${r.item_code}`);
  });

  test('the alternate supplier the operator picked survives a pick whose bindings outgrow one page', async () => {
    const { out, captured } = await convertWithCatalogue(400, 'sup-3');
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const modules = captured.filter((r) => (MODULES as readonly string[]).includes(r.item_code as string));
    expect(modules).toHaveLength(3);
    expect(
      modules.map((r) => `${r.item_code} ordered from ${r.supplier_sku}`).sort(),
    ).toEqual(MODULES.map((c) => `${c} ordered from ALT-${c}`).sort());
  });
});

describe('SO -> PO convert: a sofa set is one model on one order (HC-SO-2610-104)', () => {
  const SET_DOC = 'HC-SO-2610-104';
  const SET_MODULES = ['8030-1A(LHF)', '8030-1A(RHF)', '8069-1A(LHF)', '8069-2A(RHF)'] as const;

  async function convertSet(supplierByCode: Record<string, string>, allowSofaSupplierSplit: boolean) {
    const captured: Row[] = [];
    const soLines = SET_MODULES.map((code, i) => soLine(`si-set-${i}`, code, SET_DOC));
    const sb = fakeSb({
      mfg_sales_order_items: soLines,
      mfg_sales_orders: [{ doc_no: SET_DOC, status: 'CONFIRMED' }],
      warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
      suppliers: [
        { id: SUPPLIER_ID, code: '400-H004', name: 'HOOKKA INDUSTRIES' },
        ...ALTERNATES.map((id, i) => ({ id, code: `400-A00${i}`, name: `ALT ${i}` })),
      ],
      supplier_material_bindings: SET_MODULES.flatMap(bindingsFor),
      fabric_trackings: [],
      mrp_category_lead_times: [],
      sofa_combo_pricing: [],
      purchase_orders: [],
      purchase_order_items: [],
    }, captured);
    const ctx = {
      req: {
        json: async () => ({
          allowSofaSupplierSplit,
          picks: soLines.map((l) => ({ soItemId: l.id, qty: 1, supplierId: supplierByCode[l.item_code as string] })),
        }),
      },
      get: (key: string) => {
        if (key === 'supabase') return sb;
        if (key === 'user') return { id: 'user-1' };
        return undefined;
      },
      env: { DB: { prepare: () => { throw new Error('no D1 in this harness'); } } },
      json: (body: unknown, status = 200) => ({ status, body: body as Record<string, unknown> }),
    } as unknown as PoConvertContext;
    return { out: await convertSosToPosCore(ctx), captured };
  }

  const perModel = { '8030-1A(LHF)': SUPPLIER_ID, '8030-1A(RHF)': SUPPLIER_ID, '8069-1A(LHF)': 'sup-2', '8069-2A(RHF)': 'sup-2' };

  test('two models on two suppliers without the confirm are refused before any write', async () => {
    const { out, captured } = await convertSet(perModel, false);
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('sofa_set_suppliers_unconfirmed');
    expect(captured).toHaveLength(0);
  });

  test('the same picks with the confirm raise one PO per supplier', async () => {
    const { out, captured } = await convertSet(perModel, true);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    expect(out.body.total).toBe(2);
    expect(captured.map((r) => `${r.item_code} ${r.supplier_sku}`).sort()).toEqual([
      '8030-1A(LHF) AC-8030-1A(LHF)', '8030-1A(RHF) AC-8030-1A(RHF)',
      '8069-1A(LHF) ALT-8069-1A(LHF)', '8069-2A(RHF) ALT-8069-2A(RHF)',
    ]);
  });

  test('one model on two suppliers is refused even with the confirm', async () => {
    const { out, captured } = await convertSet({ ...perModel, '8030-1A(RHF)': 'sup-2' }, true);
    expect(out.status).toBe(409);
    expect(out.body.error).toBe('sofa_set_supplier_split');
    expect(captured).toHaveLength(0);
  });
});
