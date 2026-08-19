// A BOUND SKU MUST NEVER READ AS UNBOUND.
//
// The MRP page renders "— none —" in the Supplier cell of any shortage row whose
// SKU carries no bindings (frontend/src/pages/scm-v2/Mrp.tsx:1223), and the
// convert refuses with `missing_bindings` naming the SKU
// (mfg-purchase-orders.ts, the `noBinding` guard). Both are correct answers to
// the question "does this SKU have a supplier?" — and both are wrong answers
// when the READ that asked it came back short.
//
// On 2026-08-16 production held 2,660 supplier_material_bindings rows against
// PostgREST's 1,000-row response cap. routes/mrp.ts section 5 was taught to
// chunk its IN-list and page its result. The same question is asked at five
// other call sites, and TWO of them are the next thing the operator touches
// after the MRP page: the SO→PO picker's Main Supplier column, and the convert
// body below. Neither chunked, neither paged, and each ordered only by
// `is_main_supplier DESC` — so which bindings survived the cap was decided by
// the arbitrary order of ties, and two identically-bound modules of one sofa
// could disagree with each other.
//
// The fixture is the shape that produces it. The convert reads bindings for the
// codes IT IS CONVERTING, so the size that matters is the size of the pick — and
// the pick is "select all, Proceed PO" from the MRP page, which on production
// spans the whole outstanding book (531 distinct demand codes / 887 binding rows
// measured 2026-08-16, run 31942066593). Push that past the cap and the sofa
// modules at the end of it come back as `missing_bindings`: the operator is told
// three SKUs "aren't bound to a supplier yet" while their bindings sit in the
// very table the server just read.
import { describe, expect, test } from 'vitest';
import { convertSosToPosCore, type PoConvertContext } from './mfg-purchase-orders';

type Row = Record<string, unknown>;

/* THE FAKE ENFORCES POSTGREST'S REAL ROW CEILING — the point of the harness.
   A live PostgREST returns at most `max-rows` (1000 on this project) per
   response, drops the rest, and reports NOTHING. A fake that hands back
   everything makes an un-paged read look correct here while it is short in
   production. Same device as mrp.test.ts. */
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
    not() { return this; }
    is(col: string, val: unknown) { if (val === null) this.rows = this.rows.filter((r) => r[col] == null); return this; }
    or() { return this; }
    like() { return this; }
    ilike() { return this; }
    gte() { return this; }
    lte() { return this; }
    /* A STABLE sort, so ties keep insertion order. That is the closest a fake
       gets to "the planner decides", and it makes the pre-fix truncation
       reproducible instead of flaky. */
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
          return a.i - b.i;                       // stable
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

/* The three modules of one sofa, the shape the owner reported: same SO, same
   fabric/seat/leg, one code each. */
const MODULES = ['9028-1A(LHF)', '9028-1A(RHF)', '9028-1NA'] as const;

const soLine = (id: string, itemCode: string): Row => ({
  id, doc_no: DOC, item_code: itemCode, description: itemCode,
  item_group: 'SOFA', variants: {}, qty: 1, po_qty_picked: 0,
  unit_price_sen: 100000, line_delivery_date: '2026-09-30', warehouse_id: 'wh-kl',
  photo_urls: [],
  so: { sales_location: 'KL', customer_delivery_date: '2026-09-30' },
});

/* THREE bindings per SKU — a main plus two alternates, which is what this
   catalogue actually looks like (the three modules under report carry five
   each in production). It is also what makes the ROW count outgrow the LINE
   count, so this test measures the binding read and not the SO-line read. */
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

/**
 * Converts `filler` other bound SO lines PLUS the three sofa modules in one
 * batch — the "select all, Proceed PO" pick. The three sit at the END of the
 * binding table, so once the batch is above the cap they are exactly the rows an
 * un-paged read drops.
 */
async function convertWithCatalogue(filler: number, pickSupplierId?: string) {
  const captured: Row[] = [];
  const fillerCodes = Array.from({ length: filler }, (_, i) => `FILL-${String(i).padStart(5, '0')}`);
  const soLines = [
    ...fillerCodes.map((code, i) => soLine(`si-f-${String(i).padStart(5, '0')}`, code)),
    ...MODULES.map((code, i) => soLine(`si-${i}`, code)),
  ];
  const sb = fakeSb({
    mfg_sales_order_items: soLines,
    mfg_sales_orders: [{ doc_no: DOC, status: 'CONFIRMED' }],
    warehouses: [{ id: 'wh-kl', code: 'KL', name: 'KL' }],
    suppliers: [
      { id: SUPPLIER_ID, code: '400-H004', name: 'HOOKKA INDUSTRIES' },
      ...ALTERNATES.map((id, i) => ({ id, code: `400-A00${i}`, name: `ALT ${i}` })),
    ],
    // Every code in the fixture IS bound. Nothing here is missing data.
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
          /* The MRP page sends a per-line supplierId whenever the operator uses
             the row's Supplier dropdown — an ALTERNATE, not the main. */
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
    /* `supplier_sku` is the alternate's own code for the SKU, so it names WHICH
       binding the line was costed and grouped from — the PO line itself carries
       no supplier_id (that lives on the header it was grouped into). */
    for (const r of modules) expect(r.supplier_sku).toBe(`ALT-${r.item_code}`);
  });

  /* THE ONE THAT FAILS PRE-FIX.
     `is_main_supplier DESC` is what saved the mains: with 403 codes the 403 main
     rows all land inside the first page, so nothing is reported "unbound". What
     falls off the end is the ALTERNATES — and the alternate is precisely what
     the MRP row's Supplier dropdown sends. `effectiveBindingFor` then finds no
     `code|supplier` binding, falls back to the SKU's MAIN one, and raises the
     purchase order against a supplier the operator did not pick, at that
     supplier's price, reporting nothing. */
  test('the alternate supplier the operator picked survives a pick whose bindings outgrow one page', async () => {
    /* 403 picked lines x 3 bindings = 1,209 rows against a 1,000-row cap.
       Production held 2,660 binding rows on 2026-08-16 (887 of them for codes in
       demand), so this is the smaller end of the real range. The LINE count
       stays under the cap on purpose: this measures the binding read. */
    const { out, captured } = await convertWithCatalogue(400, 'sup-3');
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const modules = captured.filter((r) => (MODULES as readonly string[]).includes(r.item_code as string));
    expect(modules).toHaveLength(3);
    /* Assert the whole per-module outcome, so a failure prints WHICH supplier
       each module was actually ordered from rather than a bare boolean. */
    expect(
      modules.map((r) => `${r.item_code} ordered from ${r.supplier_sku}`).sort(),
    ).toEqual(MODULES.map((c) => `${c} ordered from ALT-${c}`).sort());
  });
});
