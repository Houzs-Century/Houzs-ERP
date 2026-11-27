/* The packing list — the assembly rules, and the five company predicates.
 *
 * A packing list is a TRIP, RENDERED: one lorry, one day. There is no
 * packing_lists table and there must not be one — scm.trips already carries
 * trip_date + lorry_id, and scm.trip_stops already carries the ordered drops.
 *
 * TWO KINDS OF TEST HERE, on purpose.
 *
 *   assemblePackingLists is pure, so its rules are ordinary unit tests: the
 *   delivery ORDER it emits (the print reverses it, frontend-side), the
 *   per-delivery-order de-duplication of the totals, and the two places it
 *   refuses to fabricate a zero.
 *
 *   The COMPANY PREDICATES are a SOURCE SCAN, because the compiler cannot help.
 *   The SCM client is service-role and mig 0061 enabled RLS with no policies —
 *   the predicate in the statement is the entire tenant boundary, and a missing
 *   one type-checks perfectly. This route reads exactly the two tables the
 *   ledger has already been burned on: another company's delivery orders
 *   (docs/bugs/0496) and another company's RACKS (docs/bugs/0497, where a 2990
 *   delivery could empty a Houzs bay). check-company-scope.mjs acquits a whole
 *   handler once any scoped call appears in it, which is precisely how 0497
 *   escaped, so the scan below is per-STATEMENT.
 */
import { describe, expect, test } from 'vitest';
import { assemblePackingLists } from '../src/scm/lib/packing-list-view';

const sources = import.meta.glob('../src/scm/routes/trips.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const routeSource = Object.values(sources)[0] ?? '';

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const sliceFrom = (marker: string, end: RegExp): string => {
  const start = routeSource.indexOf(marker);
  expect(start, `${marker} is not in trips.ts`).toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(end);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

/** The two loaders both packing handlers read through — asserting over the
 *  whole file would let the other handlers' predicates stand in for these. */
const packingHandler = (): string =>
  sliceFrom('async function loadPackingDay(', /\r?\n\}\r?\n/)
  + sliceFrom('async function loadPackLines(', /\r?\n\}\r?\n/);
const handlerSource = (path: string): string => sliceFrom(`trips.get('${path}',`, /\r?\n\}\);\r?\n/);

/* scm.do_status, verbatim (docs/bugs/0530). Any status-shaped literal this
   handler sends must be a member: comparing the enum against a label it does
   not define is a 22P02, not an empty match, and it 500s the whole response. */
const DO_STATUS = ['DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED'];
/* scm.trip_status (mig 0053). */
const TRIP_STATUS = ['PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

describe('GET /trips/packing — the source loaded', () => {
  test('a silent empty glob must not pass', () => {
    expect(routeSource.length).toBeGreaterThan(1000);
    expect(routeSource).toContain("trips.get('/packing'");
  });

  test('it is registered BEFORE /:id, which would otherwise swallow it', () => {
    expect(routeSource.indexOf("trips.get('/packing'"))
      .toBeLessThan(routeSource.indexOf("trips.get('/:id'"));
  });
});

describe('every read carries the company predicate — the predicate IS the boundary', () => {
  /* One assertion per TABLE, each matched on the `.from('<table>')` statement
     itself rather than on the handler containing one somewhere. */
  const scopedFrom = (table: string): boolean => {
    const body = packingHandler();
    const idx = body.indexOf(`from('${table}')`);
    expect(idx, `the handler never reads ${table}`).toBeGreaterThan(-1);
    // The wrapper sits in front of the builder, so look back far enough to see
    // it, and forward to the end of the statement.
    const window = body.slice(Math.max(0, idx - 260), idx + 400);
    return window.includes('scopeToAllowedCompanies');
  };

  test('trips', () => expect(scopedFrom('trips')).toBe(true));
  test('delivery_orders (docs/bugs/0496)', () => expect(scopedFrom('delivery_orders')).toBe(true));
  test('delivery_order_items', () => expect(scopedFrom('delivery_order_items')).toBe(true));
  test('warehouse_racks (docs/bugs/0497)', () => expect(scopedFrom('warehouse_racks')).toBe(true));
  test('mfg_sales_order_items (SO line order)', () => expect(scopedFrom('mfg_sales_order_items')).toBe(true));

  test('helpers are looked up by the ids on the scoped trips, never as a whole table', () => {
    expect(packingHandler()).toMatch(/from\('helpers'\)\.select\('id, name, contact'\)\.in\('id', helperIds\)/);
  });

  test('trip_stops is scoped through its trips, which is the only scope it has', () => {
    const body = packingHandler();
    // mig 0053 gives scm.trip_stops no company_id column at all, so the only
    // honest predicate is the trip id — over trips that were scoped above.
    expect(body).toMatch(/from\('trip_stops'\)[\s\S]{0,300}\.in\('trip_id'/);
  });

  test('every id list is chunked — an unbounded in.(...) is what production refused', () => {
    const body = packingHandler();
    for (const table of ['trip_stops', 'delivery_orders', 'delivery_order_items', 'warehouse_racks', 'mfg_sales_order_items']) {
      const idx = body.indexOf(`from('${table}')`);
      expect(body.slice(Math.max(0, idx - 300), idx), table).toContain('chunkIn');
    }
  });

  test('every status literal it sends is a member of the enum it is compared against', () => {
    const body = packingHandler();
    for (const m of body.matchAll(/'([A-Z][A-Z_]{2,})'/g)) {
      const literal = m[1];
      if (DO_STATUS.includes(literal) || TRIP_STATUS.includes(literal)) continue;
      // Not a status word at all — the scan is deliberately narrow.
      expect(/^(YYYY|MM|DD)/.test(literal), `unexpected shouty literal ${literal}`).toBe(false);
    }
    // And the one it actually sends is real.
    expect(body).toContain("neq('status', 'CANCELLED')");
    expect(TRIP_STATUS).toContain('CANCELLED');
  });
});

describe('the day loader — DOs by date and by board crew, every read scoped', () => {
  const statements = (table: string): string[] => {
    const src = packingHandler();
    const out: string[] = [];
    let at = src.indexOf(`from('${table}')`);
    while (at > -1) {
      out.push(src.slice(Math.max(0, at - 260), at + 400));
      at = src.indexOf(`from('${table}')`, at + 1);
    }
    return out;
  };

  test('both routes are registered BEFORE /:id and read through the one loader', () => {
    for (const path of ['/packing', '/packing-regions']) {
      expect(routeSource.indexOf(`trips.get('${path}',`), path).toBeGreaterThan(-1);
      expect(routeSource.indexOf(`trips.get('${path}',`), path).toBeLessThan(routeSource.indexOf("trips.get('/:id'"));
      expect(handlerSource(path), path).toContain('loadPackingDay(');
    }
  });

  for (const table of ['trips', 'delivery_orders', 'delivery_order_crew', 'delivery_order_items', 'warehouse_racks', 'mfg_sales_order_items', 'mfg_sales_orders']) {
    test(`every ${table} read is scoped`, () => {
      const found = statements(table);
      expect(found.length, `never reads ${table}`).toBeGreaterThan(0);
      for (const w of found) expect(w).toContain('scopeToAllowedCompanies');
    });
  }

  test('the crew is read by the ids of DOs already read under the predicate, chunked', () => {
    expect(packingHandler()).toMatch(/chunkIn<.+?>\(allDoIds,[\s\S]{0,160}from\('delivery_order_crew'\)[\s\S]{0,260}\.in\('do_id', batch\)/);
  });

  test('the day is the DO\'s own Delivery Date, plus the stops on that day\'s trips', () => {
    expect(packingHandler()).toContain(".eq('customer_delivery_date', date)");
    expect(packingHandler()).toContain(".eq('trip_date', date)");
  });

  test('cancelled DOs and trips are excluded in the statement', () => {
    for (const w of [...statements('trips'), ...statements('delivery_orders')]) {
      expect(w).toContain("neq('status', 'CANCELLED')");
    }
  });

  /* Production 2026-11-28: 25 DOs going out that day carried the old SO date in
     customer_delivery_date; their Sales Orders' board Delivery Date (amended) was
     the real day. The day therefore also takes the open DOs of SOs dated that day. */
  test('the day also takes open DOs of Sales Orders whose board Delivery Date is the date', () => {
    const src = packingHandler();
    expect(src).toContain('amended_delivery_date.eq.${date},and(amended_delivery_date.is.null,customer_delivery_date.eq.${date})');
    expect(src).toMatch(/chunkIn<.+?>\(soDocs,[\s\S]{0,200}from\('delivery_orders'\)[\s\S]{0,200}\.in\('so_doc_no', batch\)\.neq\('status', 'CANCELLED'\)/);
    expect(src).toContain('keep(bySo.filter((r) => !arrived.has(');
  });
});

/* ── assemblePackingLists ─────────────────────────────────────────────────── */

const TRIP = {
  id: 't1', trip_no: 'TRIP-2608-001', trip_date: '2026-08-26', status: 'PLANNED',
  lorry_id: 'l1', driver_id: 'd1', helper_1_id: 'h1', helper_2_id: null as string | null, warehouse_id: 'w1',
};

const doRow = (id: string, do_number: string, status: string, m3_total_milli: number | null) =>
  ({ id, do_number, status, m3_total_milli, so_doc_no: null as string | null, phone: null as string | null, time_range: null as string | null });

const line = (delivery_order_id: string, line_no: number, item_code: string, qty: number, rack_id: string | null) => ({
  delivery_order_id, line_no, item_code, description: null as string | null, qty, rack_id,
  shipped_from: null as unknown, item_group: null as string | null, variants: null as Record<string, unknown> | null,
  description2: null as string | null, so_item_id: null as string | null, committed_po_batch_no: null as string | null,
});

const base = () => ({
  trips: [TRIP],
  stops: [
    { id: 's3', trip_id: 't1', stop_no: 3, stop_type: 'DELIVERY', do_id: 'do3', customer_name: 'Charlie', address: 'C' },
    { id: 's1', trip_id: 't1', stop_no: 1, stop_type: 'DELIVERY', do_id: 'do1', customer_name: 'Alpha', address: 'A' },
    { id: 's2', trip_id: 't1', stop_no: 2, stop_type: 'DELIVERY', do_id: 'do2', customer_name: 'Bravo', address: 'B' },
  ],
  deliveryOrders: [
    doRow('do1', 'DO-1', 'LOADED', 1000),
    doRow('do2', 'DO-2', 'DISPATCHED', 2000),
    doRow('do3', 'DO-3', 'DISPATCHED', null),
  ],
  items: [
    line('do1', 2, 'B', 1, 'r1'),
    line('do1', 1, 'A', 2, null),
    line('do2', 1, 'C', 4, 'r2'),
    line('do3', 1, 'D', 3, null),
  ],
  racks: [{ id: 'r1', label: 'Rack 3' }, { id: 'r2', label: 'Rack 20' }],
  soItems: [] as Array<{ id: string; doc_no: string | null; line_no: number | null }>,
  lorries: [{ id: 'l1', label: 'WXY 1234' }],
  drivers: [{ id: 'd1', name: 'Ah Meng', phone: '+60123884410' }],
  helpers: [{ id: 'h1', name: 'Raju', phone: null }, { id: 'h2', name: 'Kumar', phone: null }],
  warehouses: [{ id: 'w1', label: 'Main Depot' }],
});

describe('assemblePackingLists', () => {
  test('emits stops in DELIVERY order — the print is what reverses them', () => {
    const [list] = assemblePackingLists(base());
    expect(list.stops.map((s) => s.stop_no)).toEqual([1, 2, 3]);
    expect(list.stops.map((s) => s.customer_name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  test('resolves the header the loader reads off the masters', () => {
    const [list] = assemblePackingLists(base());
    expect(list.lorry_plate).toBe('WXY 1234');
    expect(list.driver_name).toBe('Ah Meng');
    expect(list.driver_phone).toBe('+60123884410');
    expect(list.helper_1_name).toBe('Raju');
    expect(list.helper_2_name).toBeNull();
    expect(list.warehouse_name).toBe('Main Depot');
    expect(list.stop_count).toBe(3);
    expect(list.do_count).toBe(3);
    expect(list.units).toBe(10);
  });

  test('orders each stop\'s lines by line_no and names the rack only when one was picked', () => {
    const [list] = assemblePackingLists(base());
    const first = list.stops[0];
    expect(first.items.map((i) => i.item_code)).toEqual(['A', 'B']);
    expect(first.items[0].rack).toBeNull();      // no explicit pick — dispatch auto-picks
    expect(first.items[1].rack).toBe('Rack 3');
  });

  test('a shipped line prints the rack(s) locked at dispatch before any pick (owner 2026-11-10)', () => {
    const input = base();
    const stamp = { v: 1, item_code: 'B', pos: [], racks: [{ rack_id: 'r9', label: 'Rack L8.2', qty: 1 }, { rack_id: 'r8', label: 'Rack L9.1', qty: 1 }] };
    input.items[0].shipped_from = stamp;
    input.items[1].shipped_from = { ...stamp, item_code: 'OTHER' };
    const [list] = assemblePackingLists(input);
    const [a, b] = list.stops[0].items;
    expect(b).toMatchObject({ rack: 'Rack L8.2, Rack L9.1', rack_locked: true });
    expect(a).toMatchObject({ rack: null, rack_locked: false }); // a stamp for another item is ignored
  });

  test('counts a delivery order ONCE even when it sits on two stops', () => {
    const input = base();
    input.stops.push({ id: 's4', trip_id: 't1', stop_no: 4, stop_type: 'DELIVERY', do_id: 'do1', customer_name: 'Alpha again', address: 'A' });
    const [list] = assemblePackingLists(input);
    expect(list.do_count).toBe(3);
    expect(list.units).toBe(10); // not 13
    expect(list.stop_count).toBe(4);
  });

  test('sums volume over the DISTINCT delivery orders that carry one', () => {
    const [list] = assemblePackingLists(base());
    expect(list.m3_milli).toBe(3000); // do3 carries none and contributes nothing
  });

  test('answers NULL volume — never 0 — when not one delivery order carries a figure', () => {
    const input = base();
    input.deliveryOrders = input.deliveryOrders.map((d) => ({ ...d, m3_total_milli: null }));
    const [list] = assemblePackingLists(input);
    expect(list.m3_milli).toBeNull();
  });

  test('marks a stop whose delivery order the company predicate filtered out', () => {
    const input = base();
    input.deliveryOrders = input.deliveryOrders.filter((d) => d.id !== 'do2');
    input.items = input.items.filter((i) => i.delivery_order_id !== 'do2');
    const [list] = assemblePackingLists(input);
    const hidden = list.stops.find((s) => s.stop_no === 2)!;
    expect(hidden.do_missing).toBe(true);
    expect(hidden.do_number).toBeNull();
    expect(hidden.items).toEqual([]);
    // ...and it is not silently counted as a delivered-nothing stop.
    expect(list.do_count).toBe(2);
    expect(list.units).toBe(6);
  });

  test('is stable when a day was never sequenced and every stop_no defaulted to 1', () => {
    const input = base();
    input.stops = input.stops.map((s) => ({ ...s, stop_no: 1 }));
    const a = assemblePackingLists(input)[0].stops.map((s) => s.customer_name);
    const b = assemblePackingLists(input)[0].stops.map((s) => s.customer_name);
    expect(a).toEqual(b);
  });

  test('PO: the stamped PO(s) first, else the committed PO batch, else null (never a guess)', () => {
    const input = base();
    input.items[0].shipped_from = { v: 1, item_code: 'B', pos: [{ po: 'PO-9', qty: 1 }, { po: 'PO-9', qty: 1 }, { po: 'PO-7', qty: 1 }], racks: [] };
    input.items[0].committed_po_batch_no = 'PO-IGNORED';
    input.items[1].committed_po_batch_no = 'PO-3';
    const [list] = assemblePackingLists(input);
    const [a, b] = list.stops[0].items;
    expect(b).toMatchObject({ po: 'PO-9, PO-7', po_locked: true });
    expect(a).toMatchObject({ po: 'PO-3', po_locked: false });
    expect(list.stops[1].items[0].po).toBeNull();
  });

  test('a customer\'s lines follow the SALES ORDER line order, then the DO line_no', () => {
    const input = base();
    input.items = [
      { ...line('do1', 1, 'FIRST-ON-DO', 1, null), so_item_id: 'si-3' },
      { ...line('do1', 2, 'SECOND-ON-DO', 1, null), so_item_id: 'si-1' },
      { ...line('do1', 3, 'NO-SO-LINE', 1, null) },
      { ...line('do1', 4, 'THIRD-ON-DO', 1, null), so_item_id: 'si-2' },
    ];
    input.soItems = [
      { id: 'si-1', doc_no: 'SO-1', line_no: 1 },
      { id: 'si-2', doc_no: 'SO-1', line_no: 2 },
      { id: 'si-3', doc_no: 'SO-1', line_no: 3 },
    ];
    const [list] = assemblePackingLists(input);
    expect(list.stops[0].items.map((i) => i.item_code)).toEqual(['SECOND-ON-DO', 'THIRD-ON-DO', 'FIRST-ON-DO', 'NO-SO-LINE']);
    expect(list.stops[0].items.map((i) => i.so_line_no)).toEqual([1, 2, 3, null]);
    // The DO header names no SO, so the SO line's doc_no stands in.
    expect(list.stops[0].so_doc_no).toBe('SO-1');
  });

  test('an SO line from another company (filtered by the predicate) leaves no order behind', () => {
    const input = base();
    input.items = [{ ...line('do1', 2, 'X', 1, null), so_item_id: 'foreign' }, line('do1', 1, 'Y', 1, null)];
    input.soItems = [];
    const [list] = assemblePackingLists(input);
    expect(list.stops[0].items.map((i) => i.item_code)).toEqual(['Y', 'X']);
    expect(list.stops[0].so_doc_no).toBeNull();
  });

  test('carries the stop details Part B prints: phone, time slot, SO no, variants', () => {
    const input = base();
    input.deliveryOrders[0] = { ...input.deliveryOrders[0], so_doc_no: 'HC-SO-1', phone: '+60167571285', time_range: ' 9am - 11am ' };
    input.items[0] = { ...input.items[0], item_group: 'bedframe', variants: { size: 'Q' }, description2: 'Queen' };
    const [list] = assemblePackingLists(input);
    expect(list.stops[0]).toMatchObject({ so_doc_no: 'HC-SO-1', phone: '+60167571285', time_range: '9am - 11am' });
    expect(list.stops[0].items[1]).toMatchObject({ item_group: 'bedframe', variants: { size: 'Q' }, description2: 'Queen' });
  });

  test('service lines are neither picked, loaded nor counted', () => {
    const input = base();
    input.items.push({ ...line('do1', 9, 'SVC-DELIVERY', 1, null), item_group: 'service' });
    input.items.push({ ...line('do1', 10, 'SVC-LIFT-CARRY-F3', 1, null) });
    const [list] = assemblePackingLists(input);
    expect(list.stops[0].items.map((i) => i.item_code)).toEqual(['A', 'B']);
    expect(list.units).toBe(10);
  });

  test('a trip with no stops is a list with nothing on it, not a crash', () => {
    const input = base();
    input.stops = [];
    const [list] = assemblePackingLists(input);
    expect(list.stops).toEqual([]);
    expect(list.units).toBe(0);
    expect(list.do_count).toBe(0);
    expect(list.m3_milli).toBeNull();
  });
});
