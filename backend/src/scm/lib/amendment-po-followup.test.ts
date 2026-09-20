// Unit tests for raisePoFollowUps — the PO leg of an approved LINES-lane SO
// amendment — driven through a minimal fake PostgREST client (same shape as the
// applyPoAmendment suite; scm routes cannot be exercised end to end here).
//
// Two contracts are pinned:
//   · a SERVICE-line change (storage / disposal / delivery) never escalates,
//     because a SERVICE line is not goods and never becomes a PO line — the
//     supplier has nothing to follow;
//   · a follow-up is raised only against the PO that actually HOSTS a changed
//     line, or — for a brand-new ADD — the bound PO whose SUPPLIER can make it,
//     the same main-supplier match reviseBoundPo applies at confirm. An ADD whose
//     supplier serves no bound PO is warned, never forced onto the wrong PO; a
//     changed existing line with no PO home is warned too, not fanned out.
import { describe, it, expect } from 'vitest';
import { raisePoFollowUps } from './amendment-po-followup';
import { parsePgrestInList } from './pgrest-in-list';

type Row = Record<string, any>;

class Query {
  private op: 'select' | 'update' | 'insert' = 'select';
  private filters: Array<{ kind: 'eq' | 'in'; col: string; val: any }> = [];
  private payload: any = null;
  private wantSingle = false;
  private selectedAfterWrite = false;
  private done = false;
  private result: { data: any; error: null } | null = null;

  constructor(private store: Record<string, Row[]>, private table: string, private ids: { n: number }) {}

  select() { if (this.op !== 'select') this.selectedAfterWrite = true; return this; }
  eq(col: string, val: any) { this.filters.push({ kind: 'eq', col, val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  /* The ESCAPED in-list the shared binding reader builds (pgrest-in-list) —
     supabase-js cannot serialise a value carrying a `"`; parsed by the SAME
     function the app writes with, never a second split(','). */
  filter(col: string, op: string, val: string) {
    if (op !== 'in') throw new Error(`fake: filter(${op}) is not implemented`);
    return this.in(col, parsePgrestInList(val));
  }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  maybeSingle() { this.wantSingle = true; return this; }
  single() { this.wantSingle = true; return this; }
  update(payload: any) { this.op = 'update'; this.payload = payload; return this; }
  insert(payload: any) { this.op = 'insert'; this.payload = payload; return this; }

  private rows() { return (this.store[this.table] ??= []); }
  private match = (r: Row) => this.filters.every((f) =>
    f.kind === 'eq' ? r[f.col] === f.val : Array.isArray(f.val) && f.val.includes(r[f.col]));

  private exec(): { data: any; error: null } {
    if (this.done) return this.result!;
    this.done = true;
    const rows = this.rows();
    if (this.op === 'insert') {
      const items = Array.isArray(this.payload) ? this.payload : [this.payload];
      const written: Row[] = [];
      for (const it of items) {
        const row = { ...it };
        if (row.id == null) row.id = `${this.table}-gen-${++this.ids.n}`;
        rows.push(row);
        written.push(row);
      }
      const data = this.selectedAfterWrite ? (this.wantSingle ? written[0] ?? null : written) : null;
      return (this.result = { data, error: null });
    }
    const filtered = rows.filter(this.match);
    if (this.op === 'update') {
      for (const r of filtered) Object.assign(r, this.payload);
      return (this.result = { data: null, error: null });
    }
    return (this.result = { data: this.wantSingle ? (filtered[0] ?? null) : filtered, error: null });
  }

  then<T>(onF: (v: { data: any; error: null }) => T, onR?: (e: unknown) => T) {
    return Promise.resolve(this.exec()).then(onF, onR);
  }
}

const fakeSb = (store: Record<string, Row[]>) => {
  const ids = { n: 0 };
  return { from: (table: string) => new Query(store, table, ids) } as any;
};

const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as any;

const SO_DOC = 'HC-SO-006772';
const AMD_ID = 'soamd-1';
const PO_A = 'po-uuid-a';
const PO_A_NO = 'HC-PO-006690';
const PO_B = 'po-uuid-b';
const PO_B_NO = 'HC-PO-006691';
const SUP_A = 'sup-a';
const SUP_B = 'sup-b';

/* One SO with two goods lines on two DIFFERENT purchase orders, plus a storage
   SERVICE line bound to neither — SERVICE lines never become PO lines, which is
   the whole point: without the guard the storage edit still finds a PO through
   a goods line's link and raises an empty amendment against it. */
const baseStore = (): Record<string, Row[]> => ({
  mfg_sales_order_items: [
    { id: 'soi-a', doc_no: SO_DOC, cancelled: false, item_code: 'TRION-(K)', item_group: 'bedframe' },
    { id: 'soi-b', doc_no: SO_DOC, cancelled: false, item_code: 'HILTON-(Q)', item_group: 'bedframe' },
    { id: 'soi-svc', doc_no: SO_DOC, cancelled: false, item_code: 'SVC-ADDON', item_group: 'service' },
  ],
  so_revisions: [{
    amendment_id: AMD_ID,
    revision: 1,
    snapshot: {
      lines: [
        { id: 'soi-a', item_code: 'TRION-(K)', item_group: 'bedframe' },
        { id: 'soi-b', item_code: 'HILTON-(Q)', item_group: 'bedframe' },
        { id: 'soi-svc', item_code: 'SVC-ADDON', item_group: 'service' },
      ],
      poLinks: { 'soi-a': ['poi-a'], 'soi-b': ['poi-b'] },
    },
  }],
  purchase_order_items: [
    { id: 'poi-a', purchase_order_id: PO_A, so_item_id: 'soi-a', item_code: 'TRION-(K)', material_name: 'Trion (K)' },
    { id: 'poi-b', purchase_order_id: PO_B, so_item_id: 'soi-b', item_code: 'HILTON-(Q)', material_name: 'Hilton (Q)' },
  ],
  purchase_orders: [
    { id: PO_A, po_number: PO_A_NO, status: 'RECEIVED', supplier_id: SUP_A },
    { id: PO_B, po_number: PO_B_NO, status: 'CONFIRMED', supplier_id: SUP_B },
  ],
  supplier_material_bindings: [],
  po_amendments: [],
  po_amendment_lines: [],
  so_amendment_lines: [],
});

/* A main-supplier binding row, the shape readMfgProductBindings reads
   (is_main_supplier + material_kind + company scope). */
const binding = (item_code: string, supplier_id: string): Row => ({
  item_code, supplier_id, is_main_supplier: true, material_kind: 'mfg_product', company_id: 1,
});

const amendLine = (over: Row): Row => ({
  amendment_id: AMD_ID, sales_order_item_id: null, change_type: 'QTY',
  new_item_code: null, new_variants: null, new_qty: null, new_unit_price_sen: null, ...over,
});

const run = (store: Record<string, Row[]>) => raisePoFollowUps(fakeSb(store), ctx, {
  soAmendmentId: AMD_ID,
  soAmendmentNo: `${SO_DOC}/A1`,
  soDocNo: SO_DOC,
  reason: 'change the storage charges from 7 months to 10 months',
  requesterStaffId: 'staff-1',
});

describe('raisePoFollowUps — SERVICE lines do not escalate', () => {
  it('a storage QTY change alone raises no PO amendment', async () => {
    const store = baseStore();
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-svc', new_qty: 10 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  it('adding a delivery-fee SERVICE SKU raises no PO amendment', async () => {
    const store = baseStore();
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'SVC-DELIVERY', new_qty: 1 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  /* HC-SO-012757/A1 (owner 2026-09-14): the ADD was TRANSPORTATION CHARGES, a
     bare code the catalogue files as SERVICE. Judged by its code alone it read
     as goods, so approving it would raise a PO amendment against every PO
     bound to the order — an ADD keeps them all as candidates. */
  it('adding a BARE-code service line (catalogue category SERVICE) raises no PO amendment', async () => {
    const store = baseStore();
    store.mfg_products = [{ code: 'TRANSPORTATION CHARGES', category: 'SERVICE', company_id: 1 }];
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'TRANSPORTATION CHARGES', new_qty: 1, new_unit_price_sen: 15000 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  it('the catalogue is read in the order\'s company — another company\'s SERVICE row does not count', async () => {
    const store = baseStore();
    store.mfg_products = [{ code: 'TRANSPORTATION CHARGES', category: 'SERVICE', company_id: 2 }];
    // Treated as goods here, so it escalates the one bound PO whose supplier can make it.
    store.supplier_material_bindings = [binding('TRANSPORTATION CHARGES', SUP_A)];
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'TRANSPORTATION CHARGES', new_qty: 1 })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber)).toEqual([PO_A_NO]);
  });

  it('removing a SERVICE line raises no PO amendment (identity from the snapshot)', async () => {
    const store = baseStore();
    // A REMOVE hard-deletes the SO row, so only the snapshot still knows it.
    store.mfg_sales_order_items = store.mfg_sales_order_items!.filter((r) => r.id !== 'soi-svc');
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-svc', change_type: 'REMOVE' })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  it('a SPEC edit swapping a SERVICE SKU for real goods warns instead of revising every bound PO', async () => {
    // soi-svc has no PO line, and reviseBoundPo re-applies a line only when its id
    // is NEW — a pre-existing line is never placed at confirm — so fanning it out
    // to every bound PO only ever raised empty follow-ups. It is warned so a fresh
    // PO can be raised for the new goods.
    const store = baseStore();
    store.supplier_material_bindings = [binding('TRION-(Q)', SUP_A)];
    store.so_amendment_lines = [amendLine({
      sales_order_item_id: 'soi-svc', change_type: 'SPEC', new_item_code: 'TRION-(Q)',
    })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes('TRION-(Q)'))).toBe(true);
  });
});

describe('raisePoFollowUps — only the PO that hosts a changed line', () => {
  it('a change on PO A leaves PO B alone', async () => {
    const store = baseStore();
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-a', new_qty: 2 })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber)).toEqual([PO_A_NO]);
    expect(store.po_amendments).toHaveLength(1);
    expect(store.po_amendment_lines).toHaveLength(1);
    expect(store.po_amendment_lines![0]!.purchase_order_item_id).toBe('poi-a');
  });

  it('changing a line on each PO raises one follow-up per PO', async () => {
    const store = baseStore();
    store.so_amendment_lines = [
      amendLine({ sales_order_item_id: 'soi-a', new_qty: 2 }),
      amendLine({ sales_order_item_id: 'soi-b', new_qty: 3 }),
    ];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber).sort()).toEqual([PO_A_NO, PO_B_NO]);
  });

  it('an ADD escalates only the bound PO whose supplier can make the new line', async () => {
    const store = baseStore();
    store.supplier_material_bindings = [binding('TRION-(Q)', SUP_A)];
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'TRION-(Q)', new_qty: 1 })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber)).toEqual([PO_A_NO]);
    // the ADD preview is attached on that matching PO, not on the sibling
    expect(store.po_amendment_lines).toHaveLength(1);
    expect(store.po_amendment_lines![0]!.change_type).toBe('ADD');
    expect(store.po_amendment_lines![0]!.new_item_code).toBe('TRION-(Q)');
  });

  it('an ADD whose supplier makes none of the bound POs warns, never revising the wrong PO', async () => {
    // The reported bug: a mattress (supplier DIGLANT) added to an order whose only
    // PO is a bedframe PO (supplier OHANA) must not raise a revision on that PO —
    // reviseBoundPo can place it on no line there, so the _R would bump for nothing.
    const store = baseStore();
    store.supplier_material_bindings = [binding('AKEMI EQUINOX MATT (Q)', 'sup-diglant')];
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'AKEMI EQUINOX MATT (Q)', new_qty: 1 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
    expect(res.warnings.some((w) => w.includes('AKEMI EQUINOX MATT (Q)') && w.includes('separate PO'))).toBe(true);
  });

  it('a mixed amendment escalates only the touched PO, carrying only the goods change', async () => {
    const store = baseStore();
    store.so_amendment_lines = [
      amendLine({ sales_order_item_id: 'soi-svc', new_qty: 10 }),
      amendLine({ sales_order_item_id: 'soi-a', change_type: 'SPEC', new_variants: { colour: 'GREY' } }),
    ];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber)).toEqual([PO_A_NO]);
    expect(store.po_amendment_lines).toHaveLength(1);
    expect(store.po_amendment_lines![0]!.purchase_order_item_id).toBe('poi-a');
  });

  it('a changed EXISTING line with no PO home is not fanned out to unrelated POs', async () => {
    // poi-a is gone, so soi-a hosts no changed line and reviseBoundPo cannot
    // re-apply it (its id is not new). With no supplier binding (a stock line) it
    // is left silent rather than raising a revision on the sibling PO that only
    // carries soi-b.
    const store = baseStore();
    store.purchase_order_items = store.purchase_order_items!.filter((r) => r.id !== 'poi-a');
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-a', new_qty: 2 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  it('no bound PO at all warns instead of raising', async () => {
    const store = baseStore();
    store.purchase_order_items = [];
    store.so_revisions![0]!.snapshot.poLinks = {};
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-a', new_qty: 2 })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(res.warnings).toEqual(['No purchase order is bound to this Sales Order yet, so there is nothing to revise on the purchasing side.']);
    expect(store.po_amendments).toHaveLength(0);
  });
});
