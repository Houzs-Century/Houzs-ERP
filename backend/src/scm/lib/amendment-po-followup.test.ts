// Unit tests for raisePoFollowUps — the PO leg of an approved LINES-lane SO
// amendment — driven through a minimal fake PostgREST client (same shape as the
// applyPoAmendment suite; scm routes cannot be exercised end to end here).
//
// Two contracts are pinned:
//   · a SERVICE-line change (storage / disposal / delivery) never escalates,
//     because a SERVICE line is not goods and never becomes a PO line — the
//     supplier has nothing to follow;
//   · a follow-up is raised only against the PO that actually HOSTS a changed
//     line, not against every PO bound to the Sales Order — as long as EVERY
//     changed line has a PO home. A changed line with none (an ADD, or a line
//     that was never ordered) may still need one, so there the full bound set
//     stays in play and reviseBoundPo matches the supplier at confirm.
import { describe, it, expect } from 'vitest';
import { raisePoFollowUps } from './amendment-po-followup';

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
  order() { return this; }
  limit() { return this; }
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
    { id: PO_A, po_number: PO_A_NO, status: 'RECEIVED' },
    { id: PO_B, po_number: PO_B_NO, status: 'CONFIRMED' },
  ],
  po_amendments: [],
  po_amendment_lines: [],
  so_amendment_lines: [],
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

  it('removing a SERVICE line raises no PO amendment (identity from the snapshot)', async () => {
    const store = baseStore();
    // A REMOVE hard-deletes the SO row, so only the snapshot still knows it.
    store.mfg_sales_order_items = store.mfg_sales_order_items!.filter((r) => r.id !== 'soi-svc');
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-svc', change_type: 'REMOVE' })];

    const res = await run(store);

    expect(res.followUps).toEqual([]);
    expect(store.po_amendments).toHaveLength(0);
  });

  it('a SPEC edit swapping a SERVICE SKU for real goods still escalates', async () => {
    // And it is new goods with no PO home, so every bound PO stays a candidate
    // — reviseBoundPo does the supplier matching at confirm.
    const store = baseStore();
    store.so_amendment_lines = [amendLine({
      sales_order_item_id: 'soi-svc', change_type: 'SPEC', new_item_code: 'TRION-(Q)',
    })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber).sort()).toEqual([PO_A_NO, PO_B_NO]);
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

  it('an ADD keeps every bound PO as a candidate — a new line has no link yet', async () => {
    const store = baseStore();
    store.so_amendment_lines = [amendLine({ change_type: 'ADD', new_item_code: 'TRION-(Q)', new_qty: 1 })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber).sort()).toEqual([PO_A_NO, PO_B_NO]);
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

  it('a changed line with no PO home keeps every bound PO as a candidate', async () => {
    // It may still need a home — narrowing applies only when every changed
    // line already sits on a PO.
    const store = baseStore();
    store.purchase_order_items = store.purchase_order_items!.filter((r) => r.id !== 'poi-a');
    store.so_amendment_lines = [amendLine({ sales_order_item_id: 'soi-a', new_qty: 2 })];

    const res = await run(store);

    expect(res.followUps.map((f) => f.poNumber)).toEqual([PO_B_NO]);
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
