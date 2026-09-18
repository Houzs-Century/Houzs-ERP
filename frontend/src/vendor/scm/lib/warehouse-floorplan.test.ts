import { describe, expect, it } from 'vitest';
import type { Rack, RackItem, RackStatus } from './warehouse-queries';
import {
  buildZones,
  compareRackLabels,
  distinctCustomers,
  distinctProducts,
  isFiltering,
  matchSlot,
  parseRackLabel,
  rackKeyOf,
  resolvedZoneLabel,
  statusCounts,
  toSlot,
  EMPTY_FILTERS,
} from './warehouse-floorplan';

/* A backend `Rack` row = one slot; only the fields the floor plan reads matter,
   the rest are filled with inert defaults. */
const item = (over: Partial<RackItem> = {}): RackItem => ({
  id: `it-${Math.random().toString(36).slice(2)}`,
  rack_id: 'r',
  item_code: 'BF-1013',
  product_name: 'Bedframe',
  size_label: null,
  customer_name: null,
  source_doc_no: null,
  qty: 1,
  stocked_in_date: '2026-07-01',
  notes: null,
  ...over,
});

const rack = (label: string, status: RackStatus = 'EMPTY', items: RackItem[] = [], zone: string | null = null): Rack => ({
  id: `id-${label}`,
  warehouse_id: 'wh',
  rack: label,
  position: null,
  zone,
  status,
  reserved: status === 'RESERVED',
  notes: null,
  items,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
});

describe('parseRackLabel', () => {
  it('splits prefix, rackNo and level', () => {
    expect(parseRackLabel('L1.1')).toMatchObject({ prefix: 'L', rackNo: 1, level: 1, parsed: true });
    expect(parseRackLabel('R17.2')).toMatchObject({ prefix: 'R', rackNo: 17, level: 2, parsed: true });
  });
  it('reads the real "Rack L1.1" label — leading word ignored (the vertical-list bug)', () => {
    expect(parseRackLabel('Rack L1.1')).toMatchObject({ prefix: 'L', rackNo: 1, level: 1, parsed: true });
    expect(parseRackLabel('Rack R17.2')).toMatchObject({ prefix: 'R', rackNo: 17, level: 2, parsed: true });
    expect(rackKeyOf('Rack L10.2')).toBe('L10');
  });
  it('uppercases the prefix and tolerates bare / alt-separator labels', () => {
    expect(parseRackLabel('l3')).toMatchObject({ prefix: 'L', rackNo: 3, level: null });
    expect(parseRackLabel('L1-2')).toMatchObject({ prefix: 'L', rackNo: 1, level: 2 });
    expect(parseRackLabel('12.1')).toMatchObject({ prefix: '', rackNo: 12, level: 1 });
  });
  it('marks a number-less label unparsed', () => {
    expect(parseRackLabel('DOCK').parsed).toBe(false);
    expect(Number.isNaN(parseRackLabel('DOCK').rackNo)).toBe(true);
  });
  it('shares a rack key across levels', () => {
    expect(rackKeyOf('L1.1')).toBe('L1');
    expect(rackKeyOf('L1.2')).toBe('L1');
    expect(rackKeyOf('R17.2')).toBe('R17');
  });
});

describe('compareRackLabels — the L1/L10/L2 natural-sort fix', () => {
  it('orders rackNo numerically, not lexicographically', () => {
    const labels = ['L1.1', 'L10.1', 'L2.1', 'L21.1', 'L3.1'];
    expect([...labels].sort(compareRackLabels)).toEqual(['L1.1', 'L2.1', 'L3.1', 'L10.1', 'L21.1']);
  });
  it('orders level within a rack', () => {
    expect(['L2.2', 'L1.2', 'L1.1', 'L2.1'].sort(compareRackLabels)).toEqual(['L1.1', 'L1.2', 'L2.1', 'L2.2']);
  });
  it('keeps L before R and interleaves both banks correctly', () => {
    const labels = ['R2.1', 'L10.1', 'R10.1', 'L2.1', 'R1.1', 'L1.1'];
    expect([...labels].sort(compareRackLabels)).toEqual(['L1.1', 'L2.1', 'L10.1', 'R1.1', 'R2.1', 'R10.1']);
  });
  it('sinks unparseable labels to the bottom', () => {
    expect(['L2.1', 'DOCK', 'L1.1'].sort(compareRackLabels)).toEqual(['L1.1', 'L2.1', 'DOCK']);
  });
});

describe('toSlot', () => {
  it('maps status and reads a single item', () => {
    const s = toSlot(rack('L3.1', 'OCCUPIED', [item({ product_name: 'Sofa', customer_name: 'Lim', qty: 4, source_doc_no: 'GRN-1' })]));
    expect(s).toMatchObject({ status: 'occupied', rackKey: 'L3', rackName: 'L3', level: 1, itemCount: 1, qty: 4, customer: 'Lim', doc: 'GRN-1' });
    expect(s.productLabel).toBe('Sofa');
  });
  it('aggregates a multi-item slot: summed qty, earliest in-date, "N items"', () => {
    const s = toSlot(
      rack('L4.1', 'OCCUPIED', [
        item({ product_name: 'Sofa', customer_name: 'Lim', qty: 2, stocked_in_date: '2026-07-10', source_doc_no: 'GRN-2' }),
        item({ product_name: 'Bedframe', customer_name: 'Wan', qty: 3, stocked_in_date: '2026-07-02', source_doc_no: 'GRN-3' }),
      ]),
    );
    expect(s.itemCount).toBe(2);
    expect(s.qty).toBe(5);
    expect(s.inDate).toBe('2026-07-02');
    expect(s.productLabel).toBe('2 items');
    expect(s.customer).toBe('Lim, Wan');
  });
  it('leaves an empty slot blank', () => {
    const s = toSlot(rack('L5.1', 'EMPTY'));
    expect(s).toMatchObject({ status: 'empty', itemCount: 0, qty: 0, productLabel: '', customer: '', inDate: '' });
  });
});

describe('matchSlot + filter helpers', () => {
  const slots = [
    toSlot(rack('L1.1', 'OCCUPIED', [item({ product_name: 'Sofa', customer_name: 'Lim', source_doc_no: 'GRN-100', stocked_in_date: '2026-07-05' })])),
    toSlot(rack('L1.2', 'RESERVED')),
    toSlot(rack('L2.1', 'OCCUPIED', [item({ product_name: 'Bedframe', customer_name: 'Wan', source_doc_no: 'GRN-200', stocked_in_date: '2026-08-20' })])),
    toSlot(rack('L2.2', 'EMPTY')),
  ];

  it('EMPTY_FILTERS matches everything and is not "filtering"', () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
    expect(slots.every((s) => matchSlot(s, EMPTY_FILTERS))).toBe(true);
  });
  it('filters by status, product, customer and free text', () => {
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, status: 'reserved' })).map((s) => s.id)).toEqual(['L1.2']);
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, product: 'Sofa' })).map((s) => s.id)).toEqual(['L1.1']);
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, customer: 'Wan' })).map((s) => s.id)).toEqual(['L2.1']);
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, q: 'grn-200' })).map((s) => s.id)).toEqual(['L2.1']);
  });
  it('filters by in-date range (earliest in-date of the slot)', () => {
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, from: '2026-08-01' })).map((s) => s.id)).toEqual(['L2.1']);
    expect(slots.filter((s) => matchSlot(s, { ...EMPTY_FILTERS, to: '2026-07-31' })).map((s) => s.id)).toEqual(['L1.1']);
  });
  it('derives distinct products, customers and status counts', () => {
    expect(distinctProducts(slots)).toEqual(['Bedframe', 'Sofa']);
    expect(distinctCustomers(slots)).toEqual(['Lim', 'Wan']);
    expect(statusCounts(slots)).toEqual({ occupied: 2, reserved: 1, empty: 1 });
  });
});

describe('buildZones', () => {
  // Real "Rack …" labels spanning both zones and both series, out of order.
  const labels = ['Rack R1.1', 'Rack L2.1', 'Rack L1.1', 'Rack L1.2', 'Rack L10.1', 'Rack R9.1'];
  const slots = labels.map((l) =>
    toSlot(rack(l, l === 'Rack L1.1' ? 'OCCUPIED' : 'EMPTY', l === 'Rack L1.1' ? [item()] : [])),
  );
  const zones = buildZones(slots);

  it('lists ZONE A (loading-bay/L1 end) before ZONE B (entrance/L21 end), each an L bank then an R bank', () => {
    expect(zones.map((z) => z.label)).toEqual(['ZONE A', 'ZONE B']);
    expect(zones[0].banks.map((b) => b.prefix)).toEqual(['L', 'R']);
    expect(zones[0].aisle?.name).toBe('AISLE 01');
  });
  it('routes racks by number range: 1–8 to ZONE A, 9+ to ZONE B', () => {
    expect(zones[0].banks[0].racks.map((r) => r.key)).toEqual(['L1', 'L2']);
    expect(zones[0].banks[1].racks.map((r) => r.key)).toEqual(['R1']);
    expect(zones[1].banks[0].racks.map((r) => r.key)).toEqual(['L10']);
    expect(zones[1].banks[1].racks.map((r) => r.key)).toEqual(['R9']);
  });
  it('parses the real "Rack L1.1" label and orders levels within a column', () => {
    expect(zones[0].banks[0].racks[0].name).toBe('L1');
    expect(zones[0].banks[0].racks[0].slots.map((s) => s.id)).toEqual(['Rack L1.1', 'Rack L1.2']);
  });
  it('computes utilisation per zone and a range label per bank', () => {
    expect(zones[0]).toMatchObject({ used: 1, total: 4 });
    expect(zones[0].banks[0].label).toBe('L1 – L2');
  });
  it('puts an out-of-zone rack under a trailing UNZONED zone', () => {
    const extra = buildZones([...slots, toSlot(rack('Rack Z9.1'))]);
    expect(extra.map((z) => z.label)).toEqual(['ZONE A', 'ZONE B', 'UNZONED']);
  });
});

describe('resolvedZoneLabel — manual zone override', () => {
  it('derives from the number range when there is no override', () => {
    expect(resolvedZoneLabel(toSlot(rack('Rack L3.1')))).toBe('ZONE A');
    expect(resolvedZoneLabel(toSlot(rack('Rack L10.1')))).toBe('ZONE B');
    expect(resolvedZoneLabel(toSlot(rack('Rack R9.1')))).toBe('ZONE B');
  });
  it('honours a valid override, even against the number rule', () => {
    expect(resolvedZoneLabel(toSlot(rack('Rack L3.1', 'EMPTY', [], 'ZONE B')))).toBe('ZONE B');
    expect(resolvedZoneLabel(toSlot(rack('Rack L10.1', 'EMPTY', [], 'ZONE A')))).toBe('ZONE A');
  });
  it('ignores an override that names no configured zone (falls back to the range)', () => {
    expect(resolvedZoneLabel(toSlot(rack('Rack L3.1', 'EMPTY', [], 'ZONE Q')))).toBe('ZONE A');
  });
  it('returns null for an out-of-range / unparseable rack with no override', () => {
    expect(resolvedZoneLabel(toSlot(rack('Rack Z9.1')))).toBeNull();
    expect(resolvedZoneLabel(toSlot(rack('DOCK')))).toBeNull();
  });
});

describe('buildZones — manual override moves a rack between zones', () => {
  it('moves an L10 rack (default ZONE B) into ZONE A and out of ZONE B', () => {
    const slots = [
      toSlot(rack('Rack L1.1')),
      toSlot(rack('Rack L10.1', 'EMPTY', [], 'ZONE A')),
      toSlot(rack('Rack L10.2', 'EMPTY', [], 'ZONE A')),
    ];
    const zones = buildZones(slots);
    const zoneA = zones.find((z) => z.label === 'ZONE A');
    // L10 now sorts in after L1 inside ZONE A's L bank; ZONE B has no L rack left.
    expect(zoneA?.banks[0].racks.map((r) => r.key)).toEqual(['L1', 'L10']);
    expect(zones.find((z) => z.label === 'ZONE B')).toBeUndefined();
  });
  it('keeps the two levels of a reassigned rack together in one column', () => {
    const zoneA = buildZones([
      toSlot(rack('Rack L10.2', 'EMPTY', [], 'ZONE A')),
      toSlot(rack('Rack L10.1', 'EMPTY', [], 'ZONE A')),
    ]).find((z) => z.label === 'ZONE A');
    expect(zoneA?.banks[0].racks).toHaveLength(1);
    expect(zoneA?.banks[0].racks[0].slots.map((s) => s.id)).toEqual(['Rack L10.1', 'Rack L10.2']);
  });
});
