import { describe, expect, it } from 'vitest';
import { soDeliverableRemaining } from '../routes/delivery-orders-mfg';
import { MRP_DELIVERED_EMBED, compareDelivered, deliveredBySoItemFrom, readUnlinkedDoLines, soListingOrder, type MrpDemandLine } from './mrp-delivered';

/* HC-0002: MRP's delivered-per-SO-line now comes from DO lines embedded in its
   demand read plus one read of the unlinked DO lines, instead of
   soDeliverableRemaining batched over every open order. Both run here over ONE
   set of rows — the old path against a PostgREST fake that resolves the same
   embeds the real server does — and must give the same number for every line. */

type Row = Record<string, unknown>;

const SO_LINES: Row[] = [
  // SO-A: a bedframe delivered across DO states; two lines of SKU X whose LISTING
  // order (line_no) is the reverse of their id order; a null line_no last.
  { id: 'a-bf', doc_no: 'SO-A', item_code: 'BF-1', item_group: 'bedframe', variants: null, qty: 4, line_no: 1, created_at: '2026-10-01T00:00:00+00:00', cancelled: false },
  { id: 'a-x2', doc_no: 'SO-A', item_code: 'X', item_group: 'accessory', variants: null, qty: 1, line_no: 3, created_at: '2026-10-01T00:00:00+00:00', cancelled: false },
  { id: 'a-x1', doc_no: 'SO-A', item_code: 'x ', item_group: 'accessory', variants: null, qty: 2, line_no: 2, created_at: '2026-10-01T00:00:00+00:00', cancelled: false },
  { id: 'a-nul', doc_no: 'SO-A', item_code: 'X', item_group: 'accessory', variants: null, qty: 5, line_no: null, created_at: '2026-09-30T00:00:00+00:00', cancelled: false },
  { id: 'a-svc', doc_no: 'SO-A', item_code: 'DELIVERY', item_group: 'service', variants: null, qty: 1, line_no: 4, created_at: '2026-10-01T00:00:00+00:00', cancelled: false },
  // SO-B: a sofa build whose module rows are walked left-to-right (x), and a
  // mattress whose unlinked shipment is bigger than what the line has open.
  { id: 'b-s2', doc_no: 'SO-B', item_code: 'SF-2A', item_group: 'sofa', variants: { buildKey: 'build-1', x: 80, y: 0, cellIndex: 0 }, qty: 1, line_no: 1, created_at: '2026-10-02T00:00:00+00:00', cancelled: false },
  { id: 'b-s1', doc_no: 'SO-B', item_code: 'SF-2A', item_group: 'sofa', variants: { buildKey: 'build-1', x: 0, y: 0, cellIndex: 1 }, qty: 1, line_no: 2, created_at: '2026-10-02T00:00:00+00:00', cancelled: false },
  { id: 'b-mt', doc_no: 'SO-B', item_code: 'MT-1', item_group: 'mattress', variants: null, qty: 2, line_no: 3, created_at: '2026-10-02T00:00:00+00:00', cancelled: false },
  { id: 'b-cx', doc_no: 'SO-B', item_code: 'MT-1', item_group: 'mattress', variants: null, qty: 9, line_no: 4, created_at: '2026-10-02T00:00:00+00:00', cancelled: true },
  // SO-C is not open: its shipments must not reach SO-A / SO-B.
  { id: 'c-x', doc_no: 'SO-C', item_code: 'X', item_group: 'accessory', variants: null, qty: 3, line_no: 1, created_at: '2026-10-03T00:00:00+00:00', cancelled: false },
];

const TABLES: Record<string, Row[]> = {
  mfg_sales_order_items: SO_LINES,
  mfg_sales_orders: [
    { doc_no: 'SO-A', debtor_code: 'D1', debtor_name: 'ALICE' },
    { doc_no: 'SO-B', debtor_code: 'D2', debtor_name: 'BOB' },
    { doc_no: 'SO-C', debtor_code: 'D3', debtor_name: 'CAROL' },
  ],
  delivery_orders: [
    { id: 'do-1', so_doc_no: 'SO-A', status: 'DELIVERED' },
    { id: 'do-2', so_doc_no: 'SO-A', status: 'DRAFT' },
    { id: 'do-3', so_doc_no: 'SO-A', status: 'LOADED' },
    { id: 'do-4', so_doc_no: 'SO-A', status: 'CANCELLED' },
    { id: 'do-5', so_doc_no: 'SO-A', status: 'signed' },
    { id: 'do-6', so_doc_no: 'SO-B', status: 'IN_TRANSIT' },
    { id: 'do-7', so_doc_no: 'SO-B', status: 'DRAFT' },
    { id: 'do-8', so_doc_no: 'SO-C', status: 'DELIVERED' },
    { id: 'do-9', so_doc_no: null, status: 'DELIVERED' },
  ],
  delivery_order_items: [
    { id: 'dl-01', delivery_order_id: 'do-1', so_item_id: 'a-bf', item_code: 'BF-1', qty: 1 },
    { id: 'dl-02', delivery_order_id: 'do-2', so_item_id: 'a-bf', item_code: 'BF-1', qty: 1 },
    { id: 'dl-03', delivery_order_id: 'do-3', so_item_id: 'a-bf', item_code: 'BF-1', qty: 1 },
    { id: 'dl-04', delivery_order_id: 'do-4', so_item_id: 'a-bf', item_code: 'BF-1', qty: 1 },
    { id: 'dl-05', delivery_order_id: 'do-5', so_item_id: 'a-bf', item_code: 'BF-1', qty: null },
    { id: 'dl-06', delivery_order_id: 'do-1', so_item_id: 'a-x1', item_code: 'X', qty: 1 },
    // Unlinked under SO-A: ONE unit of X, so the listing order decides which line takes it (a-x1).
    { id: 'dl-07', delivery_order_id: 'do-1', so_item_id: null, item_code: 'X', qty: 1 },
    { id: 'dl-08', delivery_order_id: 'do-2', so_item_id: null, item_code: 'X', qty: 4 },
    { id: 'dl-09', delivery_order_id: 'do-5', so_item_id: null, item_code: 'BF-1', qty: 9 },
    // SO-B: one sofa module ships unlinked (the walk decides which); the mattress ships unlinked, bigger than its open qty.
    { id: 'dl-11', delivery_order_id: 'do-6', so_item_id: null, item_code: 'SF-2A', qty: 1 },
    { id: 'dl-12', delivery_order_id: 'do-6', so_item_id: null, item_code: 'MT-1', qty: 5 },
    { id: 'dl-13', delivery_order_id: 'do-7', so_item_id: null, item_code: 'MT-1', qty: 1 },
    { id: 'dl-14', delivery_order_id: 'do-6', so_item_id: 'b-cx', item_code: 'MT-1', qty: 1 },
    { id: 'dl-15', delivery_order_id: 'do-8', so_item_id: null, item_code: 'X', qty: 2 },
    { id: 'dl-16', delivery_order_id: 'do-9', so_item_id: null, item_code: 'X', qty: 2 },
    { id: 'dl-17', delivery_order_id: 'do-missing', so_item_id: 'a-x2', item_code: 'X', qty: 1 },
  ],
  delivery_return_items: [{ id: 'ri-1', do_item_id: 'dl-01', qty_returned: 1, delivery_return_id: 'dr-1' }],
  delivery_returns: [{ id: 'dr-1', status: 'RECEIVED' }],
};

const byId = (t: string) => new Map(TABLES[t]!.map((r) => [String(r.id ?? r.doc_no), r]));

/** A PostgREST fake that resolves the embeds both paths ask for, filters, orders and pages. */
function fakeSb() {
  const dos = byId('delivery_orders');
  const drs = byId('delivery_returns');
  const pick = (r: Row | undefined, cols: string[]) => (r ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : null);
  class Q {
    private rows: Row[];
    private sel = '';
    private sorts: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    private win: [number, number] | null = null;
    constructor(private table: string) { this.rows = [...(TABLES[table] ?? [])]; }
    select(s: string) { this.sel = s; return this; }
    eq(c: string, v: unknown) { this.rows = this.rows.filter((r) => r[c] === v); return this; }
    in(c: string, v: unknown[]) { this.rows = this.rows.filter((r) => v.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.rows = this.rows.filter((r) => (r[c] ?? null) === v); return this; }
    order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) { this.sorts.push({ col, asc: o?.ascending ?? true, nullsFirst: o?.nullsFirst ?? false }); return this; }
    range(f: number, t: number) { this.win = [f, t]; return this; }
    private shape(r: Row): Row {
      const out: Row = { ...r };
      if (this.table === 'delivery_order_items') {
        const h = dos.get(String(r.delivery_order_id));
        if (this.sel.includes('parent:delivery_orders')) out.parent = pick(h, ['status']);
        if (this.sel.includes('delivery_order:delivery_orders')) out.delivery_order = pick(h, ['so_doc_no', 'status']);
      }
      if (this.table === 'delivery_return_items' && this.sel.includes('parent:delivery_returns')) out.parent = pick(drs.get(String(r.delivery_return_id)), ['status']);
      if (this.table === 'mfg_sales_order_items' && this.sel.includes('do_lines:delivery_order_items')) {
        out.do_lines = TABLES.delivery_order_items!.filter((d) => d.so_item_id === r.id)
          .map((d) => ({ qty: d.qty, delivery_order: pick(dos.get(String(d.delivery_order_id)), ['status']) }));
      }
      return out;
    }
    then<T>(ok: (v: { data: Row[]; error: null }) => T) {
      const sorted = [...this.rows].sort((a, b) => {
        for (const s of this.sorts) {
          const x = a[s.col] ?? null; const y = b[s.col] ?? null;
          if (x === y) continue;
          if (x === null) return s.nullsFirst ? -1 : 1;
          if (y === null) return s.nullsFirst ? 1 : -1;
          return (x < y ? -1 : 1) * (s.asc ? 1 : -1);
        }
        return 0;
      });
      const page = this.win ? sorted.slice(this.win[0], this.win[1] + 1) : sorted;
      return Promise.resolve({ data: page.map((r) => this.shape(r)), error: null }).then(ok);
    }
  }
  return { from: (t: string) => new Q(t) };
}

const DOCS = ['SO-A', 'SO-B'];
const docSet = new Set(DOCS);
const identity = <Q>(q: Q): Q => q;

async function embeddedRows(): Promise<MrpDemandLine[]> {
  const { data } = await fakeSb().from('mfg_sales_order_items').select(`id, doc_no, ${MRP_DELIVERED_EMBED}`).in('doc_no', [...DOCS, 'SO-C']).eq('cancelled', false).order('id');
  return data as unknown as MrpDemandLine[];
}

describe('MRP delivered per SO line', () => {
  it('the embedded reading gives exactly what soDeliverableRemaining gave, line for line', async () => {
    const old = await soDeliverableRemaining(fakeSb(), DOCS);
    const rows = await embeddedRows();
    const now = deliveredBySoItemFrom(rows, docSet, await readUnlinkedDoLines(fakeSb(), identity, docSet));
    const ids = SO_LINES.filter((l) => docSet.has(String(l.doc_no)) && !l.cancelled).map((l) => String(l.id));
    const check = compareDelivered(ids.map((id) => ({ id, doc_no: '', item_code: null })), (id) => old.get(id)?.delivered ?? 0, (id) => now.get(id) ?? 0);
    expect(check).toEqual({ lines: ids.length, mismatched: 0, mismatches: [] });
    // The fixture exercises the cases it claims to: DO states, listing-order fill, spill + drop, scope.
    expect(Object.fromEntries(ids.map((id) => [id, now.get(id) ?? 0]))).toEqual({
      'a-bf': 4, 'a-x1': 2, 'a-x2': 0, 'a-nul': 0, 'a-svc': 0, 'b-s2': 0, 'b-s1': 1, 'b-mt': 2,
    });
  });

  it('listing order: line_no then created_at then id, a null line_no last, services after goods, sofa modules left to right', async () => {
    const ordered = soListingOrder(await embeddedRows()).map((l) => l.id);
    expect(ordered.filter((id) => id.startsWith('a-'))).toEqual(['a-bf', 'a-x1', 'a-x2', 'a-nul', 'a-svc']);
    expect(ordered.filter((id) => id.startsWith('b-'))).toEqual(['b-s1', 'b-s2', 'b-mt']);
  });

  it('an unlinked-line read that fails degrades to link-only, as before', async () => {
    const broken = { from: () => ({ select: () => ({ is: () => ({ order: () => ({ range: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }) };
    expect(await readUnlinkedDoLines(broken, identity, docSet)).toEqual([]);
    const thrown = { from: () => { throw new Error('client gone'); } };
    expect(await readUnlinkedDoLines(thrown, identity, docSet)).toEqual([]);
  });
});
