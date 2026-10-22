import { describe, expect, it } from 'vitest';
import { inArm, poIdsForSoDocNos, soDocNosByRef, SO_REF_MATCH_CAP } from './so-ref-search';
import { filterDoList, type DoListParams } from './do-list-read';
import { filterSiList, type SiListFilters } from './si-list-read';
import { filterPoList, type PoListFilters } from './po-list-read';
import planningRaw from '../routes/delivery-planning.ts?raw';

// Owner 2026-09-25: every search finds a record by its SO's reference number.
// DO / SI copies of the ref are often empty and POs carry none, so the lists
// match the SO link (so_doc_no / PO id) resolved from the SO's own ref.

const ctx = { get: (k: string) => (k === 'companyId' ? 1 : undefined) } as { get(key: string): unknown };

function recorder() {
  const calls: Array<{ m: string; col: string; vals: unknown }> = [];
  const self: Record<string, unknown> = {};
  for (const m of ['in', 'eq', 'or', 'gte', 'lte', 'order'] as const) {
    self[m] = (col: string, vals?: unknown) => {
      calls.push({ m, col, vals });
      return self;
    };
  }
  return { self, calls };
}
const orString = (calls: Array<{ m: string; col: string }>) => calls.find((c) => c.m === 'or')?.col ?? '';

describe('inArm', () => {
  it('quotes each value so grammar characters in a doc number cannot break the filter', () => {
    expect(inArm('so_doc_no', ['HC-SO-2609-001', 'A,B'])).toEqual(['so_doc_no.in.("HC-SO-2609-001","A,B")']);
  });
  it('adds nothing when there are no matches', () => {
    expect(inArm('id', [])).toEqual([]);
  });
});

describe('list searches match the SO link resolved from the SO reference', () => {
  it('DO list', () => {
    const { self, calls } = recorder();
    const p: DoListParams = { status: null, q: 'PO-778', sort: null, from: null, to: null, debtorNames: null, currencies: null, soRefDocNos: ['HC-SO-2609-001'] };
    filterDoList(self, p, ctx, null);
    expect(orString(calls)).toContain('so_doc_no.in.("HC-SO-2609-001")');
    expect(orString(calls)).toContain('ref.ilike.%PO-778%');
  });
  it('SI list', () => {
    const { self, calls } = recorder();
    const f: SiListFilters = { status: null, q: 'PO-778', from: null, to: null, sort: null, debtorNames: null, currencies: null, soRefDocNos: ['HC-SO-2609-001'] };
    filterSiList(self, f, ctx, null);
    expect(orString(calls)).toContain('so_doc_no.in.("HC-SO-2609-001")');
  });
  it('PO list', () => {
    const { self, calls } = recorder();
    const f: PoListFilters = {
      status: null, supplierId: null, q: 'PO-778', from: null, to: null, sort: null,
      creditorNames: null, creditorCodes: null, currencies: null, docDates: null, soRefPoIds: ['po-1'],
    };
    filterPoList(self, f, ctx, new Set());
    expect(orString(calls)).toBe('po_number.ilike.%PO-778%,notes.ilike.%PO-778%,id.in.("po-1")');
  });
  it('no SO matched -> the search is exactly what it was', () => {
    const { self, calls } = recorder();
    const f: PoListFilters = {
      status: null, supplierId: null, q: 'x1', from: null, to: null, sort: null,
      creditorNames: null, creditorCodes: null, currencies: null, docDates: null, soRefPoIds: [],
    };
    filterPoList(self, f, ctx, new Set());
    expect(orString(calls)).toBe('po_number.ilike.%x1%,notes.ilike.%x1%');
  });
});

/** A fake PostgREST client: each (table, filter column) answers from `rows`. */
function fakeSb(rows: Record<string, Record<string, unknown>[]>) {
  const log: string[] = [];
  const sb = {
    from(table: string) {
      const st: { table: string; col?: string; vals?: unknown } = { table };
      const q: Record<string, unknown> = {
        select: () => q,
        or: (expr: string) => { log.push(`${table}.or(${expr})`); return q; },
        eq: (col: string, v: unknown) => { log.push(`${table}.eq(${col},${v})`); return q; },
        in: (col: string, vals: unknown) => { st.col = col; st.vals = vals; return q; },
        limit: (n: number) => { log.push(`${table}.limit(${n})`); return Promise.resolve({ data: rows[table] ?? [], error: null }); },
        range: () => Promise.resolve({ data: rows[`${table}:${st.col}`] ?? [], error: null }),
      };
      return q;
    },
  };
  return { sb: sb as unknown as Parameters<typeof soDocNosByRef>[0], log };
}

describe('soDocNosByRef', () => {
  it('searches ref and customer_so_no, company-scoped and capped', async () => {
    const { sb, log } = fakeSb({ mfg_sales_orders: [{ doc_no: 'HC-SO-1' }, { doc_no: 'HC-SO-1' }, { doc_no: 'HC-SO-2' }] });
    expect(await soDocNosByRef(sb, ctx, ' PO-778 ')).toEqual(['HC-SO-1', 'HC-SO-2']);
    expect(log).toContain('mfg_sales_orders.or(ref.ilike.%PO-778%,customer_so_no.ilike.%PO-778%)');
    expect(log).toContain('mfg_sales_orders.eq(company_id,1)');
    expect(log).toContain(`mfg_sales_orders.limit(${SO_REF_MATCH_CAP})`);
  });
  it('a blank term reads nothing', async () => {
    const { sb, log } = fakeSb({});
    expect(await soDocNosByRef(sb, ctx, '   ')).toEqual([]);
    expect(await soDocNosByRef(sb, ctx, null)).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe('poIdsForSoDocNos', () => {
  it('finds POs through the line link AND through split allocations', async () => {
    const { sb } = fakeSb({
      'mfg_sales_order_items:doc_no': [{ id: 'si-1' }, { id: 'si-2' }],
      'purchase_order_items:so_item_id': [{ purchase_order_id: 'po-1' }, { purchase_order_id: 'po-1' }],
      'purchase_order_item_allocations:so_item_id': [{ purchase_order_item_id: 'poi-9' }],
      'purchase_order_items:id': [{ purchase_order_id: 'po-2' }],
    });
    expect(await poIdsForSoDocNos(sb, ['HC-SO-1'])).toEqual(['po-1', 'po-2']);
  });
  it('no SO -> no read', async () => {
    const { sb } = fakeSb({});
    expect(await poIdsForSoDocNos(sb, [])).toEqual([]);
  });
});


describe('Delivery Planning board', () => {
  it("the board's Reference (its search field) falls back to customer_so_no like customer-ref.ts", () => {
    expect(planningRaw).toMatch(/so_ref: \(\(r\.ref as string \| null\) \|\| \(r\.customer_so_no as string \| null\)\) \?\? null/);
    expect(planningRaw).toMatch(/referral, ref, customer_so_no, delivery_message_status/);
  });
});
