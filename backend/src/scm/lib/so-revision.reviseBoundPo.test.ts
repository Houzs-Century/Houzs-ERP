// Unit tests for reviseBoundPo's SET reconciliation (the Approve-PO amendment
// engine), driven through a minimal fake PostgREST client. Route-level coverage
// is not possible in this repo's harness (scm rides Supabase Postgres, the
// harness rebuilds only the D1 side), so these pin the reconciliation rules the
// money + stock paths depend on:
//   • an amendment REMOVE deletes the orphaned PO line AND drops it from the PO
//     total — the orphan's so_item_id was SET NULL by the SO-line delete, so it
//     is found via the SO->PO linkage snapshotSo froze at Approve-SO;
//   • a REMOVE whose orphan is already received is PRESERVED and warned, not
//     silently deleted, and it stays in the PO total;
//   • an amendment ADD inserts a correctly-priced PO line (via the SAME
//     deriveMfgPoUnitCost the create path uses) and lifts the PO total;
//   • an ADD whose supplier has no open PO is warned, not guessed;
//   • re-running is idempotent — no double insert, no double delete.
//
// No module mocks: this suite runs on the Cloudflare Workers vitest pool, where
// vi.mock does not reliably intercept module imports. Instead it drives the REAL
// modules against the fake client — deterministic pricing comes from seeding
// supplier_material_bindings (a bedframe line + flat unit_price_centi + null
// price_matrix resolves to that flat cost), and each expected cost is computed by
// calling the REAL deriveMfgPoUnitCost so the assertions never re-implement it.
import { describe, it, expect } from 'vitest';
import { reviseBoundPo } from './so-revision';
import { deriveMfgPoUnitCost } from './po-pricing';

/* ── Minimal chainable, awaitable PostgREST stand-in ────────────────────────
   Supports the exact surface reviseBoundPo + snapshotPo + deriveMfgPoUnitCost +
   recordSoAudit use: select / eq / in / lte / order / limit / maybeSingle /
   single (reads), and update / delete / insert / upsert (writes), all against
   one in-memory table store. */
type Row = Record<string, any>;

function cmp(a: unknown, b: unknown): number {
  const norm = (v: unknown) => (v == null ? -Infinity : typeof v === 'boolean' ? (v ? 1 : 0) : (v as number | string));
  const av = norm(a); const bv = norm(b);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

class Query {
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select';
  private filters: Array<{ kind: 'eq' | 'in'; col: string; val: any }> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private payload: any = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private wantSingle = false;
  private limitN: number | null = null;
  private done = false;
  private result: { data: any; error: null } | null = null;

  constructor(private store: Record<string, Row[]>, private table: string, private ids: { n: number }) {}

  select() { return this; }
  eq(col: string, val: any) { this.filters.push({ kind: 'eq', col, val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  lte() { return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.orders.push({ col, asc: opts?.ascending !== false }); return this; }
  limit(n: number) { this.limitN = n; return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }
  update(payload: any) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }
  insert(payload: any) { this.op = 'insert'; this.payload = payload; return this; }
  upsert(payload: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = 'upsert'; this.payload = payload; this.upsertOpts = opts ?? null; return this;
  }

  private rows() { return (this.store[this.table] ??= []); }
  private match = (r: Row) => this.filters.every((f) =>
    f.kind === 'eq' ? r[f.col] === f.val : Array.isArray(f.val) && f.val.includes(r[f.col]));

  private exec(): { data: any; error: null } {
    if (this.done) return this.result!;
    this.done = true;
    const rows = this.rows();

    if (this.op === 'insert' || this.op === 'upsert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      for (const it of items) {
        if (this.op === 'upsert') {
          const cols = (this.upsertOpts?.onConflict ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const dup = cols.length > 0 && rows.some((r) => cols.every((cc) => r[cc] === it[cc]));
          if (dup && this.upsertOpts?.ignoreDuplicates) continue;
        }
        const row = { ...it };
        if (row.id == null) row.id = `${this.table}-gen-${++this.ids.n}`;
        rows.push(row);
      }
      return (this.result = { data: null, error: null });
    }

    const filtered = rows.filter(this.match);
    if (this.op === 'update') {
      for (const r of filtered) Object.assign(r, this.payload);
      return (this.result = { data: null, error: null });
    }
    if (this.op === 'delete') {
      this.store[this.table] = rows.filter((r) => !this.match(r));
      return (this.result = { data: null, error: null });
    }
    let out = [...filtered];
    for (const o of [...this.orders].reverse()) out.sort((a, b) => cmp(a[o.col], b[o.col]) * (o.asc ? 1 : -1));
    if (this.limitN != null) out = out.slice(0, this.limitN);
    return (this.result = { data: this.wantSingle ? (out[0] ?? null) : out, error: null });
  }

  then<T>(onF: (v: { data: any; error: null }) => T, onR?: (e: unknown) => T) {
    return Promise.resolve(this.exec()).then(onF, onR);
  }
}

function fakeSb(store: Record<string, Row[]>) {
  const ids = { n: 0 };
  return { from: (table: string) => new Query(store, table, ids) };
}

/* Base fixture: SO SO-1 (company 1) with two lines L1 (surviving) + L2, and one
   bound PO POX (supplier S1) carrying a line for each. The Approve-SO gate has
   already run for the REMOVE scenarios — L2 is gone from the SO and its PO line's
   so_item_id is NULL (the FK SET-NULL) — and snapshotSo has frozen the pre-removal
   SO->PO linkage into so_revisions. Bindings give a flat, matrix-less cost so the
   REAL deriveMfgPoUnitCost resolves each bedframe SKU to that flat sen amount. */
const AMD = 'amd-1';
const DOC = 'SO-1';

function baseStore(): Record<string, Row[]> {
  return {
    so_amendments: [{ id: AMD, so_doc_no: DOC, status: 'SO_APPROVED' }],
    mfg_sales_orders: [{ doc_no: DOC, company_id: 1 }],
    so_revisions: [{
      amendment_id: AMD, revision: 1, po_id: null,
      snapshot: { lines: [{ id: 'L1' }, { id: 'L2' }], poLinks: { L1: ['POI-1'], L2: ['POI-2'] } },
    }],
    purchase_orders: [{
      id: 'POX', po_number: 'PO-2607-001', status: 'SUBMITTED', revision: 1,
      supplier_id: 'S1', purchase_location_id: 'WH1', company_id: 1,
      subtotal_centi: 3500, total_centi: 3500, expected_at: null,
    }],
    supplier_material_bindings: [
      binding('BF-1', 'S1', 1000), binding('BF-3', 'S1', 1500),
    ],
    maintenance_config_history: [],
    po_revisions: [],
    staff: [],
    mfg_so_audit_log: [],
  };
}

const binding = (material_code: string, supplier_id: string, unit_price_centi: number, sku = `SKU-${material_code}`): Row => ({
  material_code, supplier_id, supplier_sku: sku, unit_price_centi, price_matrix: null,
  is_main_supplier: true, material_kind: 'mfg_product', company_id: 1,
});
const poLine = (over: Partial<Row>): Row => ({
  id: 'POI-x', purchase_order_id: 'POX', so_item_id: null, qty: 1, received_qty: 0,
  material_code: 'BF', material_name: 'Bed', discount_centi: 0, line_total_centi: 0,
  unit_price_centi: 0, delivery_date: null, warehouse_id: 'WH1', item_group: 'bedframe',
  variants: null, from_mrp: false, company_id: 1, ...over,
});
const soLine = (over: Partial<Row>): Row => ({
  id: 'L', doc_no: DOC, item_code: 'BF', item_group: 'bedframe', qty: 1, variants: null,
  warehouse_id: 'WH1', line_delivery_date: null, description: 'Bed', ...over,
});
// The cost the REAL engine resolves for a bedframe SKU from the seeded binding.
const cost = (store: Record<string, Row[]>, itemCode: string) =>
  deriveMfgPoUnitCost(fakeSb(store) as any, { supplierId: 'S1', itemCode, itemGroup: 'bedframe', variants: null });

describe('reviseBoundPo — REMOVE reconciles the orphaned PO line', () => {
  it('deletes the orphaned PO line and drops it from the PO total', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ id: 'L1', item_code: 'BF-1', qty: 2 })];
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: 'L1', material_code: 'BF-1', qty: 2, line_total_centi: 2000 }),
      poLine({ id: 'POI-2', so_item_id: null, material_code: 'BF-2', material_name: 'Bed Two', qty: 1, line_total_centi: 1500 }),
    ];
    const c1 = await cost(store, 'BF-1');

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    const items = store.purchase_order_items;
    expect(items.find((i) => i.id === 'POI-2')).toBeUndefined();   // orphan deleted
    expect(items.map((i) => i.id)).toEqual(['POI-1']);
    expect(store.purchase_orders[0].subtotal_centi).toBe(c1 * 2);  // survivor only
    expect(store.purchase_orders[0].total_centi).toBe(c1 * 2);
    expect(store.purchase_orders[0].revision).toBe(2);
    expect(res.perPo[0]).toMatchObject({ linesRederived: 1, linesRemoved: 1, linesAdded: 0 });
    expect(res.warnings).toEqual([]);
  });

  it('PRESERVES an already-received orphan and warns instead of deleting it', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ id: 'L1', item_code: 'BF-1', qty: 2 })];
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: 'L1', material_code: 'BF-1', qty: 2, line_total_centi: 2000 }),
      poLine({ id: 'POI-2', so_item_id: null, material_code: 'BF-2', material_name: 'Bed Two', qty: 1, received_qty: 1, line_total_centi: 1500 }),
    ];
    const c1 = await cost(store, 'BF-1');

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    expect(store.purchase_order_items.find((i) => i.id === 'POI-2')).toBeDefined();  // preserved
    expect(store.purchase_orders[0].subtotal_centi).toBe(c1 * 2 + 1500);             // still billed
    expect(res.perPo[0].linesRemoved).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('Bed Two');
    expect(res.warnings[0]).toContain('PO-2607-001');
    expect(res.warnings[0].toLowerCase()).toContain('already received');
    // Plain language: no codes / keys / jargon.
    expect(res.warnings[0]).not.toMatch(/so_item_id|_centi|uuid|null/i);
  });

  it('warns when every line of a PO is removed (PO left empty)', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [];   // both lines removed → SO empty, POX fully orphaned
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: null, material_code: 'BF-1', qty: 1, line_total_centi: 1000 }),
      poLine({ id: 'POI-2', so_item_id: null, material_code: 'BF-2', qty: 1, line_total_centi: 1500 }),
    ];

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    expect(store.purchase_order_items).toHaveLength(0);
    expect(store.purchase_orders[0].subtotal_centi).toBe(0);
    expect(res.perPo[0].linesRemoved).toBe(2);
    expect(res.warnings.some((w) => w.includes('no lines') && w.includes('PO-2607-001'))).toBe(true);
  });

  it('is idempotent — re-running does not double-delete or throw', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ id: 'L1', item_code: 'BF-1', qty: 2 })];
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: 'L1', material_code: 'BF-1', qty: 2, line_total_centi: 2000 }),
      poLine({ id: 'POI-2', so_item_id: null, material_code: 'BF-2', qty: 1, line_total_centi: 1500 }),
    ];
    const c1 = await cost(store, 'BF-1');
    const sb = fakeSb(store);

    await reviseBoundPo(sb, AMD, 'user-1');
    const afterFirst = store.purchase_order_items.map((i) => i.id);
    const res2 = await reviseBoundPo(sb, AMD, 'user-1');   // snapshot poLinks still names POI-2

    expect(store.purchase_order_items.map((i) => i.id)).toEqual(afterFirst);   // no change
    expect(res2.perPo[0].linesRemoved).toBe(0);            // nothing left to remove
    expect(store.purchase_orders[0].subtotal_centi).toBe(c1 * 2);
  });
});

describe('reviseBoundPo — ADD reconciles the missing PO line', () => {
  function addStore(): Record<string, Row[]> {
    const store = baseStore();
    store.so_revisions = [{
      amendment_id: AMD, revision: 1, po_id: null,
      snapshot: { lines: [{ id: 'L1' }], poLinks: { L1: ['POI-1'] } },   // snapshot had only L1
    }];
    store.mfg_sales_order_items = [
      soLine({ id: 'L1', item_code: 'BF-1', qty: 1 }),
      soLine({ id: 'L3', item_code: 'BF-3', qty: 2, warehouse_id: 'WH1', line_delivery_date: '2026-08-01', description: 'Bed Three' }),
    ];
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: 'L1', material_code: 'BF-1', qty: 1, line_total_centi: 1000 }),
    ];
    return store;
  }

  it('inserts a correctly-priced PO line for the added SO line and lifts the total', async () => {
    const store = addStore();
    const c1 = await cost(store, 'BF-1');
    const c3 = await cost(store, 'BF-3');

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    const added = store.purchase_order_items.find((i) => i.so_item_id === 'L3');
    expect(added).toBeDefined();
    expect(added).toMatchObject({
      purchase_order_id: 'POX', material_code: 'BF-3', material_name: 'Bed Three',
      supplier_sku: 'SKU-BF-3', qty: 2, warehouse_id: 'WH1', delivery_date: '2026-08-01',
      from_mrp: false, company_id: 1,
    });
    // Priced by the SAME rule the create path uses.
    expect(added!.unit_price_centi).toBe(c3);
    expect(added!.line_total_centi).toBe(c3 * 2);
    expect(c3).toBeGreaterThan(0);                       // guard: the seed really priced it
    expect(store.purchase_orders[0].subtotal_centi).toBe(c1 * 1 + c3 * 2);
    expect(res.perPo[0]).toMatchObject({ linesAdded: 1, linesRemoved: 0 });
    expect(res.warnings).toEqual([]);
  });

  it('is idempotent — re-running does not insert a second line for the added SO line', async () => {
    const store = addStore();
    const c1 = await cost(store, 'BF-1');
    const c3 = await cost(store, 'BF-3');
    const sb = fakeSb(store);

    await reviseBoundPo(sb, AMD, 'user-1');
    await reviseBoundPo(sb, AMD, 'user-1');

    expect(store.purchase_order_items.filter((i) => i.so_item_id === 'L3')).toHaveLength(1);
    expect(store.purchase_orders[0].subtotal_centi).toBe(c1 * 1 + c3 * 2);
  });

  it('warns (does not guess a PO) when the added item has no supplier bound', async () => {
    const store = addStore();
    store.supplier_material_bindings = [binding('BF-1', 'S1', 1000)];   // BF-3 has no binding

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    expect(store.purchase_order_items.some((i) => i.so_item_id === 'L3')).toBe(false);
    expect(res.perPo[0].linesAdded).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('Bed Three');
    expect(res.warnings[0].toLowerCase()).toContain('no supplier');
  });

  it('warns when the added item is from a supplier with no open PO on this SO', async () => {
    const store = addStore();
    // BF-3 bound to a DIFFERENT supplier (S2) than the SO's only open PO (S1).
    store.supplier_material_bindings = [binding('BF-1', 'S1', 1000), binding('BF-3', 'S2', 1500)];

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');

    expect(store.purchase_order_items.some((i) => i.so_item_id === 'L3')).toBe(false);
    expect(res.perPo[0].linesAdded).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0].toLowerCase()).toContain('purchase order');
  });
});

describe('reviseBoundPo — unchanged contracts still hold', () => {
  it('no bound PO ⇒ NO-OP (empty result, no warnings)', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ id: 'L1', item_code: 'BF-1', qty: 1 })];
    store.purchase_order_items = [];
    store.purchase_orders = [];
    store.so_revisions = [{ amendment_id: AMD, revision: 1, snapshot: { lines: [{ id: 'L1' }], poLinks: {} } }];

    const res = await reviseBoundPo(fakeSb(store), AMD, 'user-1');
    expect(res).toEqual({ revisedPoIds: [], perPo: [], warnings: [] });
  });

  it('a surviving line revised below its received qty still aborts (received floor)', async () => {
    const store = baseStore();
    store.mfg_sales_order_items = [soLine({ id: 'L1', item_code: 'BF-1', qty: 1 })];
    store.so_revisions = [{ amendment_id: AMD, revision: 1, snapshot: { lines: [{ id: 'L1' }], poLinks: { L1: ['POI-1'] } } }];
    store.purchase_order_items = [
      poLine({ id: 'POI-1', so_item_id: 'L1', material_code: 'BF-1', qty: 5, received_qty: 3, line_total_centi: 5000 }),
    ];

    await expect(reviseBoundPo(fakeSb(store), AMD, 'user-1')).rejects.toMatchObject({ code: 'received_floor' });
  });
});
