// Unit tests for applyPoAmendment — the Approve engine for a Purchase Order
// amendment — driven through the same minimal fake PostgREST client the
// reviseBoundPo suite uses. Route-level coverage is not possible in this repo's
// harness (scm rides Supabase Postgres; the harness rebuilds only the D1 side),
// so these pin the contract the money + stock paths depend on:
//   • approve SNAPSHOTS the current PO into po_revisions and BUMPS the revision;
//   • a QTY / PRICE diff rewrites the line and rolls the PO subtotal + total;
//   • an ADD inserts a line and lifts the total; a REMOVE deletes it and drops it;
//   • a REMOVE of an already-received line is PRESERVED and warned, not deleted;
//   • a surviving line revised below its received qty ABORTS (received floor);
//   • one AMENDMENT_PO_APPROVED row lands on entity_audit_log.
import { describe, it, expect } from 'vitest';
import { applyPoAmendment, ReceivedFloorError } from './po-revision';

type Row = Record<string, any>;

class Query {
  private op: 'select' | 'update' | 'delete' | 'insert' | 'upsert' = 'select';
  private filters: Array<{ kind: 'eq' | 'in'; col: string; val: any }> = [];
  private payload: any = null;
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } | null = null;
  private wantSingle = false;
  private done = false;
  private result: { data: any; error: null } | null = null;

  constructor(private store: Record<string, Row[]>, private table: string, private ids: { n: number }) {}

  select() { return this; }
  eq(col: string, val: any) { this.filters.push({ kind: 'eq', col, val }); return this; }
  in(col: string, val: any[]) { this.filters.push({ kind: 'in', col, val }); return this; }
  order() { return this; }
  limit() { return this; }
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
    return (this.result = { data: this.wantSingle ? (filtered[0] ?? null) : filtered, error: null });
  }

  then<T>(onF: (v: { data: any; error: null }) => T, onR?: (e: unknown) => T) {
    return Promise.resolve(this.exec()).then(onF, onR);
  }
}

function fakeSb(store: Record<string, Row[]>) {
  const ids = { n: 0 };
  return { from: (table: string) => new Query(store, table, ids) };
}

const AMD = 'poamd-1';
const POID = 'PO-uuid-1';
const PONO = 'PO-2607-001';

// Base fixture: PO with two lines, each qty 1. Amendment lines are set per test.
function baseStore(): Record<string, Row[]> {
  return {
    po_amendments: [{ id: AMD, po_id: POID, po_number: PONO, header_changes: null, old_header_snapshot: null }],
    po_amendment_lines: [],
    purchase_orders: [{
      id: POID, po_number: PONO, supplier_id: 'S1', expected_at: null, notes: null,
      subtotal_centi: 3000, tax_centi: 0, total_centi: 3000, revision: 1, company_id: 1, status: 'SUBMITTED',
    }],
    purchase_order_items: [
      { id: 'POI-1', purchase_order_id: POID, material_code: 'BF-1', material_name: 'Bed One', qty: 1, unit_price_centi: 1000, discount_centi: 0, line_total_centi: 1000, received_qty: 0, variants: null, delivery_date: null, company_id: 1 },
      { id: 'POI-2', purchase_order_id: POID, material_code: 'BF-2', material_name: 'Bed Two', qty: 1, unit_price_centi: 2000, discount_centi: 0, line_total_centi: 2000, received_qty: 0, variants: null, delivery_date: null, company_id: 1 },
    ],
    po_revisions: [],
    entity_audit_log: [],
    staff: [],
  };
}

describe('applyPoAmendment — snapshot + revision + audit', () => {
  it('snapshots the PO, bumps the revision, and writes ONE audit row', async () => {
    const store = baseStore();
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-1', change_type: 'QTY', new_qty: 3, new_unit_price_centi: null, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: { qty: 1 } },
    ];

    const res = await applyPoAmendment(fakeSb(store), AMD, 'user-1');

    // Snapshot of the PRE-amendment revision (1) is frozen into po_revisions.
    expect(store.po_revisions).toHaveLength(1);
    expect(store.po_revisions[0]).toMatchObject({ po_id: POID, revision: 1, amendment_id: AMD });
    // Revision bumped to 2.
    expect(store.purchase_orders[0].revision).toBe(2);
    expect(res.revision).toBe(2);
    // Exactly one AMENDMENT_PO_APPROVED audit row for this PO.
    const audits = store.entity_audit_log.filter((a) => a.action === 'AMENDMENT_PO_APPROVED');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entity_type: 'PURCHASE_ORDER', entity_id: POID, entity_doc_no: PONO });
  });

  it('QTY diff rewrites the line and rolls the PO total', async () => {
    const store = baseStore();
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-1', change_type: 'QTY', new_qty: 3, new_unit_price_centi: null, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: { qty: 1 } },
    ];
    const res = await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    const line = store.purchase_order_items.find((i) => i.id === 'POI-1')!;
    expect(line.qty).toBe(3);
    expect(line.line_total_centi).toBe(3000);           // 3 * 1000
    expect(store.purchase_orders[0].subtotal_centi).toBe(3000 + 2000);
    expect(store.purchase_orders[0].total_centi).toBe(5000);
    expect(res.linesUpdated).toBe(1);
  });

  it('PRICE diff rewrites the unit price', async () => {
    const store = baseStore();
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-2', change_type: 'PRICE', new_qty: null, new_unit_price_centi: 2500, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: {} },
    ];
    await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    const line = store.purchase_order_items.find((i) => i.id === 'POI-2')!;
    expect(line.unit_price_centi).toBe(2500);
    expect(line.line_total_centi).toBe(2500);
    expect(store.purchase_orders[0].subtotal_centi).toBe(1000 + 2500);
  });

  it('ADD inserts a line and lifts the total', async () => {
    const store = baseStore();
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: null, change_type: 'ADD', new_qty: 2, new_unit_price_centi: 1500, new_material_code: 'BF-3', new_material_name: 'Bed Three', new_variants: null, new_delivery_date: '2026-08-01', old_snapshot: null },
    ];
    const res = await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    const added = store.purchase_order_items.find((i) => i.material_code === 'BF-3')!;
    expect(added).toMatchObject({ qty: 2, unit_price_centi: 1500, line_total_centi: 3000, purchase_order_id: POID, delivery_date: '2026-08-01' });
    expect(store.purchase_orders[0].subtotal_centi).toBe(1000 + 2000 + 3000);
    expect(res.linesAdded).toBe(1);
  });

  it('REMOVE deletes the line and drops it from the total', async () => {
    const store = baseStore();
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-2', change_type: 'REMOVE', new_qty: null, new_unit_price_centi: null, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: { qty: 1 } },
    ];
    const res = await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    expect(store.purchase_order_items.find((i) => i.id === 'POI-2')).toBeUndefined();
    expect(store.purchase_orders[0].subtotal_centi).toBe(1000);
    expect(res.linesRemoved).toBe(1);
  });

  it('PRESERVES an already-received REMOVE line and warns instead of deleting', async () => {
    const store = baseStore();
    store.purchase_order_items.find((i) => i.id === 'POI-2')!.received_qty = 1;
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-2', change_type: 'REMOVE', new_qty: null, new_unit_price_centi: null, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: { qty: 1 } },
    ];
    const res = await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    expect(store.purchase_order_items.find((i) => i.id === 'POI-2')).toBeDefined();  // preserved
    expect(res.linesRemoved).toBe(0);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('Bed Two');
    expect(res.warnings[0].toLowerCase()).toContain('already received');
    // Plain language: no codes / keys / jargon.
    expect(res.warnings[0]).not.toMatch(/_centi|uuid|received_qty/i);
  });

  it('aborts (received floor) when a surviving line drops below received qty, changing nothing', async () => {
    const store = baseStore();
    store.purchase_order_items.find((i) => i.id === 'POI-1')!.received_qty = 3;
    store.po_amendment_lines = [
      { id: 'AL-1', amendment_id: AMD, purchase_order_item_id: 'POI-1', change_type: 'QTY', new_qty: 1, new_unit_price_centi: null, new_material_code: null, new_material_name: null, new_variants: null, new_delivery_date: null, old_snapshot: { qty: 3 } },
    ];
    await expect(applyPoAmendment(fakeSb(store), AMD, 'user-1')).rejects.toBeInstanceOf(ReceivedFloorError);
    // Nothing changed — no snapshot, no revision bump.
    expect(store.po_revisions).toHaveLength(0);
    expect(store.purchase_orders[0].revision).toBe(1);
    expect(store.purchase_order_items.find((i) => i.id === 'POI-1')!.qty).toBe(1);  // unchanged fixture qty
  });

  it('applies a header supplier change and records it', async () => {
    const store = baseStore();
    store.po_amendments[0].header_changes = { supplier_id: 'S2' };
    store.po_amendments[0].old_header_snapshot = { supplier_id: 'S1' };
    await applyPoAmendment(fakeSb(store), AMD, 'user-1');
    expect(store.purchase_orders[0].supplier_id).toBe('S2');
    const audit = store.entity_audit_log.find((a) => a.action === 'AMENDMENT_PO_APPROVED')!;
    expect(JSON.stringify(audit.field_changes)).toContain('supplier_id');
  });
});
