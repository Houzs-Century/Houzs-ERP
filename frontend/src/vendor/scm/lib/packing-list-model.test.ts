/* The two rules a packing list exists FOR, and one refusal.
 *
 * 1. THE REVERSAL. This is the whole feature. Stops are sequenced 1..N for
 *    DELIVERY; loading runs N..1 so the last drop sits deepest in the lorry.
 *    The first test below is written so that "fixing" `loadingOrder` to
 *    ascending fails it — a sorted-looking output is exactly what a well-meant
 *    edit would produce, so the assertion names the stop numbers in the order
 *    they must come out, not merely that the array was reordered.
 *
 * 2. THE ROLLUP REFUSES TO ANSWER OVER NOTHING. `Delivered 0/0` is the failure
 *    this repo keeps paying for: a company predicate that matched nothing looks
 *    identical to a run with nothing on it. Null is the honest answer and the
 *    caller renders a dash.
 *
 * 3. EVERY STATUS LITERAL IS A MEMBER OF scm.do_status. A string the enum does
 *    not define is a 22P02, not an empty match — it took the Delivery Orders
 *    page down twice (docs/bugs/0530). Asserted against the enum's membership
 *    so a new rung cannot be invented here.
 */
import { describe, it, expect } from 'vitest';
import {
  loadingOrder,
  rollupDeliveryStatus,
  rollupLabel,
  compareRackLabels,
  formatRacksCompact,
  fmtM3,
  DO_RUNG,
} from './packing-list-model';
import { packingListsPath } from './packing-list-queries';

/** scm.do_status, verbatim (mig 0053 + docs/bugs/0530's enum listing). */
const DO_STATUS_MEMBERS = [
  'DRAFT', 'LOADED', 'DISPATCHED', 'IN_TRANSIT', 'SIGNED', 'DELIVERED', 'INVOICED', 'CANCELLED',
];

const stop = (stop_no: number, do_id: string | null, do_status: string | null) =>
  ({ stop_no, do_id, do_status });

describe('loadingOrder — the sheet is the reverse of the route', () => {
  it('puts the LAST delivery first, because it is loaded deepest', () => {
    const out = loadingOrder([stop(1, 'a', null), stop(2, 'b', null), stop(3, 'c', null)]);
    // Numbered 1,2,3 by LOADING order...
    expect(out.map((s) => s.load_no)).toEqual([1, 2, 3]);
    // ...over the stops taken in DESCENDING delivery order. Flip the function
    // to ascending and this line is what fails.
    expect(out.map((s) => s.stop.stop_no)).toEqual([3, 2, 1]);
    expect(out[0].stop.stop_no).toBe(3);
    expect(out[0].stop.stop_no).not.toBe(1);
  });

  it('sorts into delivery order first, so an out-of-order input still reverses correctly', () => {
    const out = loadingOrder([stop(3, 'c', null), stop(1, 'a', null), stop(2, 'b', null)]);
    expect(out.map((s) => s.stop.stop_no)).toEqual([3, 2, 1]);
  });

  it('does not mutate the caller — the screen still shows delivery order', () => {
    const rows = [stop(1, 'a', null), stop(2, 'b', null)];
    loadingOrder(rows);
    expect(rows.map((r) => r.stop_no)).toEqual([1, 2]);
  });

  it('is total: one stop, and none at all', () => {
    expect(loadingOrder([stop(7, 'a', null)])).toEqual([{ load_no: 1, stop: stop(7, 'a', null) }]);
    expect(loadingOrder([])).toEqual([]);
  });
});

describe('rollupDeliveryStatus — the owner ladder over the member delivery orders', () => {
  it('names the furthest rung reached and counts how many got there', () => {
    const r = rollupDeliveryStatus([
      stop(1, 'a', 'DISPATCHED'),
      stop(2, 'b', 'DISPATCHED'),
      stop(3, 'c', 'LOADED'),
    ]);
    expect(rollupLabel(r)).toBe('Loaded 2/3');
  });

  it('uses the owner words, not the enum keys', () => {
    expect(rollupLabel(rollupDeliveryStatus([stop(1, 'a', 'LOADED')]))).toBe('Confirmed 1/1');
    expect(rollupLabel(rollupDeliveryStatus([stop(1, 'a', 'IN_TRANSIT')]))).toBe('In Transit 1/1');
    expect(rollupLabel(rollupDeliveryStatus([stop(1, 'a', 'DELIVERED')]))).toBe('Delivered 1/1');
    // SIGNED and INVOICED are past the ladder's last rung and read as Delivered.
    expect(rollupLabel(rollupDeliveryStatus([stop(1, 'a', 'SIGNED')]))).toBe('Delivered 1/1');
    expect(rollupLabel(rollupDeliveryStatus([stop(1, 'a', 'INVOICED')]))).toBe('Delivered 1/1');
  });

  it('counts ONE delivery order once, even when it is on two stops', () => {
    const r = rollupDeliveryStatus([stop(1, 'a', 'LOADED'), stop(2, 'a', 'LOADED')]);
    expect(r).toEqual({ label: 'Confirmed', reached: 1, total: 1, cancelled: 0 });
  });

  it('REFUSES over nothing rather than printing a confident zero', () => {
    expect(rollupDeliveryStatus([])).toBeNull();
    // A stop whose delivery order the company predicate filtered out.
    expect(rollupDeliveryStatus([stop(1, 'a', null)])).toBeNull();
    expect(rollupLabel(null)).toBeNull();
  });

  it('keeps cancelled delivery orders out of the ladder, and says how many there were', () => {
    const r = rollupDeliveryStatus([stop(1, 'a', 'CANCELLED'), stop(2, 'b', 'LOADED')]);
    expect(r).toEqual({ label: 'Confirmed', reached: 1, total: 1, cancelled: 1 });
    // Every member cancelled is still nothing to roll up.
    expect(rollupDeliveryStatus([stop(1, 'a', 'CANCELLED')])).toBeNull();
  });

  it('leaves an unrecognised status out of BOTH halves of the fraction', () => {
    const r = rollupDeliveryStatus([stop(1, 'a', 'COMPLETED'), stop(2, 'b', 'LOADED')]);
    expect(r).toEqual({ label: 'Confirmed', reached: 1, total: 1, cancelled: 0 });
  });

  it('names only statuses scm.do_status actually defines', () => {
    for (const key of Object.keys(DO_RUNG)) expect(DO_STATUS_MEMBERS).toContain(key);
  });
});

describe('racks', () => {
  it('sorts numerically, so Rack 3 comes before Rack 20', () => {
    expect(['Rack 20', 'Rack 3'].sort(compareRackLabels)).toEqual(['Rack 3', 'Rack 20']);
  });

  it('prints the word once and dedupes', () => {
    expect(formatRacksCompact(['Rack 4', 'Rack 3', 'Rack 4'])).toBe('Rack 3, 4');
    expect(formatRacksCompact(['19'])).toBe('Rack 19');
  });

  it('answers empty when nothing resolved, so the caller prints a dash', () => {
    expect(formatRacksCompact([])).toBe('');
    expect(formatRacksCompact([null, undefined, '  '])).toBe('');
  });
});

describe('fmtM3', () => {
  it('converts milli-m3 to two decimals', () => {
    expect(fmtM3(3400)).toBe('3.40 m³');
  });

  it('is NULL when nothing carried a figure — never "0.00 m³"', () => {
    expect(fmtM3(null)).toBeNull();
    expect(fmtM3(undefined)).toBeNull();
    // A real, stored zero is still a figure and prints as one.
    expect(fmtM3(0)).toBe('0.00 m³');
  });
});

describe('packingListsPath', () => {
  it('asks for the day, and narrows to a depot only when one is picked', () => {
    expect(packingListsPath('2026-08-26', null)).toBe('/trips/packing?date=2026-08-26');
    expect(packingListsPath('2026-08-26', 'wh-1')).toBe('/trips/packing?date=2026-08-26&warehouseId=wh-1');
  });
});
