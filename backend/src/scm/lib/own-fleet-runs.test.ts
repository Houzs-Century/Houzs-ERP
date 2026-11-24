import { describe, expect, test } from 'vitest';
import {
  buildOwnRuns, customerKeyOf, lorryKeyOf, ownFleetCardChoice, ownFleetMonths, ownFleetWindow, priceOwnRuns,
  type OwnDo, type OwnTrip, type PricingCard,
} from './own-fleet-runs';
import { doFacts } from './threepl-do-charge';
import type { RateCardSpec } from './delivery-rate-card';

/* Made-up prices: RM 30 the 1st set of a trip, RM 20 the 2nd, RM 15 each after;
   RM 50 once for a trip into Johor; RM 25 a supplier pickup; no setup price. */
const card: PricingCard = {
  id: 'card-own', name: 'Own fleet',
  spec: {
    basis: 'SET', aggregation: 'UNIT',
    rules: [
      { ruleType: 'POSITIONAL_TIER', tierPosition: 1, amountSen: 3000 },
      { ruleType: 'POSITIONAL_TIER', tierPosition: 2, amountSen: 2000 },
      { ruleType: 'POSITIONAL_TIER', tierPosition: 3, amountSen: 1500 },
      { ruleType: 'OUTSTATION', zone: 'JOHOR', amountSen: 5000 },
      { ruleType: 'SUPPLIER_PICKUP', amountSen: 2500 },
    ],
  } satisfies RateCardSpec,
};
const zoneOf = () => null;

const twoSets = doFacts([{ category: 'BEDFRAME', qty: 2 }, { category: 'MATTRESS', qty: 2 }], 'KL', 'JALAN AMPANG KUALA LUMPUR');
const oneSetJohor = doFacts([{ category: 'BEDFRAME', qty: 1 }, { category: 'MATTRESS', qty: 1 }], 'JOHOR', 'TAMAN MOLEK JOHOR BAHRU');
const ownDo = (p: Partial<OwnDo> & { doId: string }): OwnDo => ({
  doNumber: `DO-${p.doId}`, companyId: 1, runDate: '2026-11-10', lorryId: 'lorry-a', plate: 'TST1234', tripId: null,
  facts: twoSets, customerKey: `cust-${p.doId}`, ...p,
});
const trip = (p: Partial<OwnTrip> & { tripId: string }): OwnTrip => ({
  tripNo: `TRIP-${p.tripId}`, tripDate: '2026-11-10', lorryId: 'lorry-a', plate: 'TST1234', stops: [], ...p,
});
const stop = (stopType: string, doId: string | null = null) => ({ stopType, doId, assrCaseId: null, address: 'SOMEWHERE' });

describe('a trip is one lorry on one day', () => {
  test('the orders a lorry ran that day and its Delivery Planning jobs are one trip', () => {
    const runs = buildOwnRuns(
      [ownDo({ doId: '1' }), ownDo({ doId: '2', companyId: 2, facts: oneSetJohor })],
      [trip({ tripId: 't1', stops: [stop('SUPPLIER_PICKUP'), stop('SETUP')] })],
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dos.map((d) => d.doId)).toEqual(['1', '2']);
    expect(runs[0]!.tripNos).toEqual(['TRIP-t1']);
    expect(runs[0]!.stops).toHaveLength(2);
  });

  test('another day, or another lorry, is another trip; an order is counted once', () => {
    const runs = buildOwnRuns(
      [ownDo({ doId: '1' }), ownDo({ doId: '1' }), ownDo({ doId: '3', runDate: '2026-11-11' }), ownDo({ doId: '4', lorryId: 'lorry-b', plate: 'TST9999' })],
      [],
    );
    expect(runs.map((r) => [r.runDate, r.plate, r.dos.map((d) => d.doId)])).toEqual([
      ['2026-11-11', 'TST1234', ['3']],
      ['2026-11-10', 'TST1234', ['1']],
      ['2026-11-10', 'TST9999', ['4']],
    ]);
  });

  test('a lorry known only by its typed plate is keyed by the plate, however it was spaced', () => {
    expect(lorryKeyOf(null, 'tst 1234', 'x')).toBe('plate:TST1234');
    expect(lorryKeyOf('lorry-a', 'TST 1234', 'x')).toBe('lorry:lorry-a');
    expect(lorryKeyOf(null, null, 'trip:t9')).toBe('trip:t9');
    const runs = buildOwnRuns([ownDo({ doId: '1', lorryId: null, plate: 'TST 1234' }), ownDo({ doId: '2', lorryId: null, plate: 'tst1234' })], []);
    expect(runs).toHaveLength(1);
  });

  test("a trip with no lorry keeps its own orders with it", () => {
    const runs = buildOwnRuns(
      [ownDo({ doId: '1', lorryId: null, plate: '', tripId: 't9' }), ownDo({ doId: '2', lorryId: null, plate: '' })],
      [trip({ tripId: 't9', lorryId: null, plate: null, stops: [stop('DELIVERY', '1'), stop('TRANSFER')] })],
    );
    expect(runs.find((r) => r.tripNos.includes('TRIP-t9'))?.dos.map((d) => d.doId)).toEqual(['1']);
    expect(runs.find((r) => r.tripNos.length === 0)?.dos.map((d) => d.doId)).toEqual(['2']);
  });

  test('the same buyer at the same doorstep is one customer', () => {
    const a = customerKeyOf({ doc_no: 'SO-1', debtor_code: 'C-01', address1: 'No 1  Jalan Satu', postcode: '50000' });
    const b = customerKeyOf({ doc_no: 'SO-2', debtor_code: 'C-01', address1: 'NO 1 JALAN SATU', postcode: '50000' });
    expect(a).toBe(b);
    expect(customerKeyOf({ doc_no: 'SO-3', debtor_code: 'C-01', address1: 'No 2 Jalan Dua', postcode: '50000' })).not.toBe(a);
  });
});

describe('a trip priced once, like a 3PL trip', () => {
  test('the sets of all its orders climb one ladder, the farthest zone is charged once, each other job once', () => {
    const [run] = priceOwnRuns(
      buildOwnRuns(
        [ownDo({ doId: '1' }), ownDo({ doId: '2', facts: oneSetJohor })],
        [trip({ tripId: 't1', stops: [stop('SUPPLIER_PICKUP'), stop('SETUP'), stop('LORRY_SERVICE'), stop('DELIVERY', '1')] })],
      ),
      () => card,
      zoneOf,
    );
    // 3 sets: 30 + 20 + 15; Johor once: 50; one supplier pickup: 25; setup has no price on this card: 0.
    expect(run!.costSen).toBe(3000 + 2000 + 1500 + 5000 + 2500);
    expect(run!.otherJobsSen).toBe(2500);
    expect(run!.setCount).toBe(3);
    expect(run!.zones).toEqual(['KL', 'JOHOR']);
    expect(run!.jobs).toEqual({ SUPPLIER_PICKUP: 1, SETUP: 1 });
    expect(run!.card).toEqual({ id: 'card-own', name: 'Own fleet' });
  });

  test('two orders on one trip climb one ladder, not two', () => {
    const [together] = priceOwnRuns(buildOwnRuns([ownDo({ doId: '1' }), ownDo({ doId: '2' })], []), () => card, zoneOf);
    // 4 sets on the trip: 30 + 20 + 15 + 15, where two orders priced apart would be (30 + 20) x 2.
    expect(together!.costSen).toBe(3000 + 2000 + 1500 + 1500);
  });

  test('no card for the lorry: no cost, never a made-up zero', () => {
    const [run] = priceOwnRuns(buildOwnRuns([ownDo({ doId: '1' })], []), () => null, zoneOf);
    expect(run!.costSen).toBeNull();
    expect(run!.otherJobsSen).toBeNull();
    expect(run!.card).toBeNull();
    expect(run!.setCount).toBe(2);
  });
});

describe('which own fleet card prices which lorry', () => {
  test('one card for the whole fleet', () => {
    const c = ownFleetCardChoice([{ id: 'a', carrierLorryId: null }]);
    expect(c.fleet?.id).toBe('a');
    expect(c.several).toEqual([]);
  });

  test('two whole-fleet cards active: neither prices until one is left', () => {
    const c = ownFleetCardChoice([{ id: 'a', carrierLorryId: null }, { id: 'b', carrierLorryId: null }]);
    expect(c.fleet).toBeNull();
    expect(c.several.map((x) => x.id)).toEqual(['a', 'b']);
  });

  test("a lorry's own card is kept apart from the fleet card", () => {
    const c = ownFleetCardChoice([{ id: 'a', carrierLorryId: null }, { id: 'l', carrierLorryId: 'lorry-a' }]);
    expect(c.fleet?.id).toBe('a');
    expect(c.byLorry.get('lorry-a')?.id).toBe('l');
  });
});

describe('month by month, beside the 3PL bills', () => {
  test('trips, orders, cost and the cost without the other jobs; 3PL billed and its own cards', () => {
    const priced = priceOwnRuns(
      buildOwnRuns(
        [ownDo({ doId: '1' }), ownDo({ doId: '2', runDate: '2026-10-30' })],
        [trip({ tripId: 't1', stops: [stop('SUPPLIER_PICKUP')] })],
      ),
      () => card,
      zoneOf,
    );
    const months = ownFleetMonths(priced, [
      { doId: 'x', runDate: '2026-11-02', setCount: 1, billedSen: 9000, expectedSen: 8000 },
      { doId: 'y', runDate: '2026-11-03', setCount: 2, billedSen: 7000, expectedSen: null },
    ]);
    expect(months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    expect(months[0]).toMatchObject({ trips: 1, dos: 1, pricedDos: 1, costSen: 5000, deliveryCostSen: 5000, threePlDos: 0 });
    expect(months[1]).toMatchObject({
      trips: 1, dos: 1, sets: 2, pricedTrips: 1, costSen: 7500, deliveryCostSen: 5000,
      threePlDos: 2, threePlSets: 3, threePlBilledSen: 16000, threePlPricedDos: 1, threePlBilledPricedSen: 9000, threePlCardSen: 8000,
    });
  });

  test('trips with no card count as trips, not as cost', () => {
    const months = ownFleetMonths(priceOwnRuns(buildOwnRuns([ownDo({ doId: '1' })], []), () => null, zoneOf), []);
    expect(months[0]).toMatchObject({ trips: 1, dos: 1, pricedTrips: 0, pricedDos: 0, costSen: 0 });
  });
});

describe('the window one read covers', () => {
  test('both dates, in order, at most 186 days', () => {
    expect(ownFleetWindow('2026-09-01', '2026-11-30')).toEqual({ ok: true, from: '2026-09-01', to: '2026-11-30' });
    expect(ownFleetWindow('', '2026-11-30').ok).toBe(false);
    expect(ownFleetWindow('2026-11-31x', '2026-11-30').ok).toBe(false);
    expect(ownFleetWindow('2026-12-01', '2026-11-30')).toEqual({ ok: false, reason: 'From must be on or before To.' });
    expect(ownFleetWindow('2026-01-01', '2026-07-05').ok).toBe(true);
    expect(ownFleetWindow('2026-01-01', '2026-07-06').ok).toBe(false);
  });
});
