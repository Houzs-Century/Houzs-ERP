import { describe, expect, it } from 'vitest';
import type { Rack, RackItem, RackStatus } from './warehouse-queries';
import {
  buildBanks,
  compareRackLabels,
  distinctCustomers,
  distinctProducts,
  isFiltering,
  matchSlot,
  parseRackLabel,
  rackKeyOf,
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

const rack = (label: string, status: RackStatus = 'EMPTY', items: RackItem[] = []): Rack => ({
  id: `id-${label}`,
  warehouse_id: 'wh',
  rack: label,
  position: null,
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

describe('buildBanks', () => {
  // Two-bank mixed set given out of order — L bank (2 racks) + R bank (1 rack).
  const slots = ['R1.2', 'L2.1', 'L1.1', 'L1.2', 'R1.1', 'L2.2'].map((l) =>
    toSlot(rack(l, l === 'L1.1' ? 'OCCUPIED' : 'EMPTY', l === 'L1.1' ? [item()] : [])),
  );
  const banks = buildBanks(slots);

  it('splits into L and R banks in zone order, with placeholder labels', () => {
    expect(banks.map((b) => b.prefix)).toEqual(['L', 'R']);
    expect(banks.map((b) => b.label)).toEqual(['BANK A', 'BANK B']);
    expect(banks[0].aisle?.name).toBe('AISLE 01');
    expect(banks[1].aisle).toBeUndefined();
  });
  it('builds rack columns in natural order, each with its two levels', () => {
    expect(banks[0].racks.map((r) => r.key)).toEqual(['L1', 'L2']);
    expect(banks[0].racks[0].slots.map((s) => s.id)).toEqual(['L1.1', 'L1.2']);
  });
  it('computes utilisation and range per bank', () => {
    expect(banks[0]).toMatchObject({ used: 1, total: 4, utilPct: 25, range: 'L1 – L2' });
    expect(banks[1]).toMatchObject({ used: 0, total: 2, range: 'R1 – R1' });
  });
  it('appends an unconfigured prefix as its own trailing bank', () => {
    const extra = buildBanks([...slots, toSlot(rack('Z9.1'))]);
    expect(extra.map((b) => b.prefix)).toEqual(['L', 'R', 'Z']);
    expect(extra[2].label).toBe('Z');
  });
});
