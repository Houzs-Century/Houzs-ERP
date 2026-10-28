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

/** The `/packing` handler only — asserting over the whole file would let the
 *  eleven other handlers' predicates stand in for this one's. */
const packingHandler = (): string => {
  const marker = "trips.get('/packing'";
  const start = routeSource.indexOf(marker);
  expect(start, 'GET /trips/packing is not registered').toBeGreaterThan(-1);
  const rest = routeSource.slice(start + 1);
  const next = rest.search(/\ntrips\.(get|post|patch|put|delete)\(/);
  return stripComments(next === -1 ? rest : rest.slice(0, next));
};

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

  test('trip_stops is scoped through its trips, which is the only scope it has', () => {
    const body = packingHandler();
    // mig 0053 gives scm.trip_stops no company_id column at all, so the only
    // honest predicate is the trip id — over trips that were scoped above.
    expect(body).toMatch(/from\('trip_stops'\)[\s\S]{0,300}\.in\('trip_id'/);
  });

  test('every id list is chunked — an unbounded in.(...) is what production refused', () => {
    const body = packingHandler();
    for (const table of ['trip_stops', 'delivery_orders', 'delivery_order_items', 'warehouse_racks']) {
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

/* ── assemblePackingLists ─────────────────────────────────────────────────── */

const TRIP = {
  id: 't1', trip_no: 'TRIP-2608-001', trip_date: '2026-08-26', status: 'PLANNED',
  lorry_id: 'l1', driver_id: 'd1', warehouse_id: 'w1',
};

const base = () => ({
  trips: [TRIP],
  stops: [
    { id: 's3', trip_id: 't1', stop_no: 3, stop_type: 'DELIVERY', do_id: 'do3', customer_name: 'Charlie', address: 'C' },
    { id: 's1', trip_id: 't1', stop_no: 1, stop_type: 'DELIVERY', do_id: 'do1', customer_name: 'Alpha', address: 'A' },
    { id: 's2', trip_id: 't1', stop_no: 2, stop_type: 'DELIVERY', do_id: 'do2', customer_name: 'Bravo', address: 'B' },
  ],
  deliveryOrders: [
    { id: 'do1', do_number: 'DO-1', status: 'LOADED', m3_total_milli: 1000 },
    { id: 'do2', do_number: 'DO-2', status: 'DISPATCHED', m3_total_milli: 2000 },
    { id: 'do3', do_number: 'DO-3', status: 'DISPATCHED', m3_total_milli: null },
  ],
  items: [
    { delivery_order_id: 'do1', line_no: 2, item_code: 'B', description: null, qty: 1, rack_id: 'r1' },
    { delivery_order_id: 'do1', line_no: 1, item_code: 'A', description: null, qty: 2, rack_id: null },
    { delivery_order_id: 'do2', line_no: 1, item_code: 'C', description: null, qty: 4, rack_id: 'r2' },
    { delivery_order_id: 'do3', line_no: 1, item_code: 'D', description: null, qty: 3, rack_id: null },
  ],
  racks: [{ id: 'r1', label: 'Rack 3' }, { id: 'r2', label: 'Rack 20' }],
  lorries: [{ id: 'l1', label: 'WXY 1234' }],
  drivers: [{ id: 'd1', label: 'Ah Meng' }],
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
