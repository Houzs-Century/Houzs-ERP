// The worked-out Source PO / Rack of a DO line (do-line-worked-out-sources.ts):
// the one rule the DO detail and the packing list share. The DO detail's own
// wire output is pinned in delivery-orders-mfg.read-pin.test.ts; this suite pins
// the rule's branches, the company predicate on the one read the caller scopes,
// and that a whole packing day costs a bounded number of statements.
import { describe, expect, test } from 'vitest';
import { resolveWorkedOutSources, type WorkedOutDo, type WorkedOutLineInput } from '../src/scm/lib/do-line-worked-out-sources';
import { computeVariantKey } from '../src/scm/shared';
import { loadPackingDay } from '../src/scm/routes/trips';

type Row = Record<string, unknown>;

/** A PostgREST-shaped fake that filters for real and counts one statement per `from()`. */
function countingSb(tables: Record<string, Row[]>) {
  const calls: string[] = [];
  const from = (table: string) => {
    calls.push(table);
    const preds: Array<(r: Row) => boolean> = [];
    let win: [number, number] | null = null;
    let lim: number | null = null;
    let single = false;
    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (win) rows = rows.slice(win[0], win[1] + 1);
      if (lim != null) rows = rows.slice(0, lim);
      return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
    };
    const cmp = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chainable fake
    const q: any = {
      select: () => q,
      order: () => q,
      or: () => q,
      eq: (c: string, v: unknown) => { preds.push((r) => String(r[c]) === String(v)); return q; },
      neq: (c: string, v: unknown) => { preds.push((r) => String(r[c]) !== String(v)); return q; },
      in: (c: string, v: unknown[]) => { const s = new Set(v.map(String)); preds.push((r) => s.has(String(r[c]))); return q; },
      filter: (c: string, _op: string, list: string) => {
        const s = new Set(list.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
        preds.push((r) => s.has(String(r[c])));
        return q;
      },
      is: (c: string, v: unknown) => { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return q; },
      not: (c: string, op: string, v: unknown) => { preds.push((r) => (op === 'is' && v === null ? r[c] != null : String(r[c]) !== String(v))); return q; },
      gt: (c: string, v: unknown) => { preds.push((r) => r[c] != null && (typeof r[c] === 'number' ? (r[c] as number) > Number(v) : cmp(r[c], v) > 0)); return q; },
      range: (a: number, b: number) => { win = [a, b]; return q; },
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: () => { single = true; return q; },
      single: () => { single = true; return q; },
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve().then(run).then(ok, ko),
    };
    return q;
  };
  return { sb: { from, rpc: async () => ({ data: null, error: null }) }, calls };
}

const vk = (group: string) => computeVariantKey(group, {});

/** One DO per index, five lines each: ledger PO, bound PO + GRN rack, a picked rack,
 *  a rack the DO left from, and a line nothing is known about. */
function dayWorld(n: number) {
  const dos: WorkedOutDo[] = [];
  const lines: WorkedOutLineInput[] = [];
  const t: Record<string, Row[]> = {
    mfg_sales_order_items: [], inventory_movements: [], inventory_lot_consumptions: [], purchase_order_items: [],
    purchase_orders: [{ id: 'po-b', po_number: 'HC-PO-2610-050', status: 'RECEIVED', expected_at: '2026-10-01' }],
    warehouse_racks: [
      { id: 'r-grn', rack: 'L3.2', warehouse_id: 'wh-1', company_id: 1 },
      { id: 'r-pick', rack: 'L7.4', warehouse_id: 'wh-1', company_id: 1 },
    ],
    warehouse_rack_items: [{ id: 'wri-1', rack_id: 'r-grn', item_code: 'PIL-1', source_grn_id: 'grn-1' }],
    grn_items: [{ id: 'gi-1', grn_id: 'grn-1', item_code: 'PIL-1', rack_id: 'r-grn', purchase_order_item_id: 'poi-0' }],
    grns: [{ id: 'grn-1', purchase_order_id: 'po-b' }],
    warehouse_rack_movements: [],
    delivery_orders: [],
    delivery_order_items: [],
    warehouses: [{ id: 'wh-1', is_default: true, company_id: 1, code: 'MAIN' }],
  };
  for (let i = 0; i < n; i += 1) {
    const doId = `do-${i}`;
    const doNo = `HC-DO-2611-${String(i).padStart(3, '0')}`;
    dos.push({ id: doId, do_number: doNo, warehouse_id: 'wh-1', company_id: 1 });
    t.delivery_orders!.push({ id: doId, company_id: 2 });
    const l = (k: number, code: string, group: string, so: string | null, rack: string | null = null): WorkedOutLineInput =>
      ({ id: `${doId}-l${k}`, delivery_order_id: doId, item_code: code, item_group: group, variants: {}, so_item_id: so, rack_id: rack });
    lines.push(l(1, 'MAT-1', 'MATTRESS', null), l(2, 'PIL-1', 'ACCESSORY', `si-${i}`), l(3, 'BOL-1', 'ACCESSORY', null, 'r-pick'),
      l(4, 'TOP-1', 'ACCESSORY', null), l(5, 'NONE-1', 'ACCESSORY', null));
    t.mfg_sales_order_items!.push({ id: `si-${i}`, warehouse_id: null });
    t.inventory_movements!.push({ source_doc_type: 'DO', movement_type: 'OUT', source_doc_id: doId, item_code: 'MAT-1', variant_key: vk('MATTRESS'), batch_no: 'HC-PO-2609-229' });
    t.purchase_order_items!.push({ id: `poi-${i}`, so_item_id: `si-${i}`, purchase_order_id: 'po-b', item_code: 'PIL-1', received_qty: 1, created_at: '2026-10-01' });
    t.warehouse_rack_movements!.push({ id: `wrm-${i}`, source_doc_no: doNo, movement_type: 'STOCK_OUT', item_code: 'TOP-1', rack_label: 'L9.1', company_id: 1 });
  }
  return { dos, lines, tables: t };
}

const scoped = (sb: { from: (t: string) => { select: (c: string) => { eq: (c: string, v: unknown) => unknown } } }) =>
  () => sb.from('warehouse_rack_movements').select('source_doc_no, item_code, rack_label').eq('company_id', 1);

describe('resolveWorkedOutSources', () => {
  test('ledger trace, bound PO, picked rack, rack left from, GRN rack, and nothing -> empty', async () => {
    const w = dayWorld(1);
    const { sb } = countingSb(w.tables);
    const out = await resolveWorkedOutSources(sb, w.dos, w.lines, scoped(sb as never));
    const get = (k: number) => out.byLine.get(`do-0-l${k}`);
    expect(get(1)).toEqual({ source_pos: ['HC-PO-2609-229'], source_adj: false, racks: [] });
    expect(get(2)).toEqual({ source_pos: ['HC-PO-2610-050'], source_adj: false, racks: ['L3.2'] });
    expect(get(3)).toEqual({ source_pos: [], source_adj: false, racks: ['L7.4'] });
    expect(get(4)).toEqual({ source_pos: [], source_adj: false, racks: ['L9.1'] });
    expect(get(5)).toEqual({ source_pos: [], source_adj: false, racks: [] });
    expect(out.lineWh.get('do-0-l2')).toBe('wh-1');
  });

  test('the ledger trace wins over the bound PO', async () => {
    const w = dayWorld(1);
    w.tables.inventory_movements!.push({ source_doc_type: 'DO', movement_type: 'OUT', source_doc_id: 'do-0', item_code: 'PIL-1', variant_key: vk('ACCESSORY'), batch_no: 'HC-PO-LEDGER' });
    const { sb } = countingSb(w.tables);
    const out = await resolveWorkedOutSources(sb, w.dos, w.lines, scoped(sb as never));
    expect(out.byLine.get('do-0-l2')!.source_pos).toEqual(['HC-PO-LEDGER']);
  });

  test("the rack-left read goes through the caller's company predicate", async () => {
    const w = dayWorld(1);
    w.tables.warehouse_rack_movements!.push({ id: 'wrm-x', source_doc_no: 'HC-DO-2611-000', movement_type: 'STOCK_OUT', item_code: 'NONE-1', rack_label: 'OTHER-CO', company_id: 2 });
    const { sb } = countingSb(w.tables);
    const out = await resolveWorkedOutSources(sb, w.dos, w.lines, scoped(sb as never));
    expect(out.byLine.get('do-0-l5')!.racks).toEqual([]);
  });

  test('a 40-DO, 200-line day costs a bounded number of statements, not one set per DO', async () => {
    const count = async (n: number) => {
      const w = dayWorld(n);
      const { sb, calls } = countingSb(w.tables);
      const out = await resolveWorkedOutSources(sb, w.dos, w.lines, scoped(sb as never));
      expect(out.byLine.size).toBe(n * 5);
      expect(out.byLine.get(`do-${n - 1}-l2`)!.source_pos).toEqual(['HC-PO-2610-050']);
      return calls.length;
    };
    const one = await count(1);
    const forty = await count(40);
    // Measured 2026-11-28: 13 statements for 1 DO and 13 for 40 DOs / 200 lines.
    expect(forty).toBe(one);
    expect(forty).toBe(13);
  });
});

/* The packing day loader: a line with no dispatch stamp prints what the resolver works out and
   carries worked_out; a stamped line keeps its stamp. The whole day's statement count is pinned. */
describe('loadPackingDay — PO and Rack of lines with no dispatch stamp', () => {
  const DATE = '2026-11-28';
  const packingWorld = (n: number) => {
    const w = dayWorld(n);
    const t = w.tables;
    t.delivery_orders = w.dos.map((d) => ({
      id: d.id, company_id: 1, do_number: d.do_number, status: 'LOADED', so_doc_no: null, debtor_name: `CUST ${d.id}`,
      customer_delivery_date: DATE, warehouse_id: 'wh-1', m3_total_milli: 100,
    }));
    t.delivery_order_crew = w.dos.map((d) => ({ do_id: d.id, company_id: 1, lorry_plate: 'VPC9058' }));
    t.delivery_order_items = w.lines.map((l, i) => ({
      ...l, company_id: 1, line_no: (i % 5) + 1, description: l.item_code, description2: null, qty: 1,
      committed_po_batch_no: null,
      shipped_from: l.item_code === 'NONE-1' && l.delivery_order_id === 'do-0'
        ? { v: 1, item_code: 'NONE-1', pos: [{ po: 'HC-PO-2609-229', qty: 1 }], racks: [{ rack_id: 'r-s', label: 'L16.1', qty: 1 }] }
        : null,
    }));
    t.trips = []; t.trip_stops = []; t.mfg_sales_orders = [];
    t.lorries = []; t.drivers = []; t.helpers = [];
    return t;
  };
  const ctx = { get: (k: string) => ({ allowedCompanyIds: [1], companyId: 1, houzsUser: { id: 9, permissions_set: new Set(['*']) } } as Record<string, unknown>)[k] };

  const load = async (n: number) => {
    const { sb, calls } = countingSb(packingWorld(n));
    const day = await loadPackingDay(sb, ctx, DATE, null);
    if ('error' in day) throw new Error(day.error);
    return { day, calls };
  };

  test('worked-out PO / rack with the flag; the stamp still wins; nothing known stays a dash', async () => {
    const { day } = await load(2);
    const items = (doId: string) => day.dayDos.find((d) => d.do_id === doId)!.items;
    const byCode = (doId: string, code: string) => items(doId).find((i) => i.item_code === code)!;
    expect(byCode('do-1', 'MAT-1')).toMatchObject({ po: 'HC-PO-2609-229', po_locked: false, rack: null, worked_out: true });
    expect(byCode('do-1', 'PIL-1')).toMatchObject({ po: 'HC-PO-2610-050', rack: 'L3.2', rack_locked: false, worked_out: true });
    expect(byCode('do-1', 'TOP-1')).toMatchObject({ po: null, rack: 'L9.1', worked_out: true });
    expect(byCode('do-1', 'NONE-1')).toMatchObject({ po: null, rack: null, worked_out: false });
    expect(byCode('do-0', 'NONE-1')).toMatchObject({ po: 'HC-PO-2609-229', po_locked: true, rack: 'L16.1', rack_locked: true, worked_out: false });
  });

  test('a 40-DO day: the statement count does not grow with the DOs', async () => {
    const five = await load(5);
    const forty = await load(40);
    expect(forty.day.dayDos).toHaveLength(40);
    expect(forty.day.dayDos.flatMap((d) => d.items)).toHaveLength(200);
    // Measured 2026-11-28: 24 statements for the whole 40-DO / 200-line day (13 of them the resolver), the same as for 5 DOs.
    expect(forty.calls.length).toBe(five.calls.length);
    expect(forty.calls.length).toBe(24);
  });
});
