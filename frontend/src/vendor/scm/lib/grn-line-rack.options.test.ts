import { describe, expect, it } from 'vitest';
import { grnRackOptionsWithSiblingStock } from './grn-line-rack';

const OWN = [
  { id: 'own-l5-1', rack: 'Rack L5.1' },
  { id: 'own-l5-2', rack: 'Rack L5.2' },
  { id: 'own-r1-1', rack: 'Rack R1.1' },
];

const hc = (id: string, rack: string, qty: number[], warehouse_code = 'KL WAREHOUSE', company_code: string | null = 'HC') => ({
  id, rack, warehouse_code, company_code, items: qty.map((q) => ({ qty: q })),
});

describe('grnRackOptionsWithSiblingStock — what the other company has on the same shelf', () => {
  it('appends the other company\'s stock to the matching label and leaves the value alone', () => {
    const options = grnRackOptionsWithSiblingStock(OWN, 'KL WAREHOUSE', [
      hc('hc-l5-1', 'Rack L5.1', [4, 2]),
    ]);
    expect(options).toEqual([
      { value: 'own-l5-1', label: 'Rack L5.1 · HC 6 pcs' },
      { value: 'own-l5-2', label: 'Rack L5.2' },
      { value: 'own-r1-1', label: 'Rack R1.1' },
    ]);
  });

  it('ignores an empty sibling shelf, another building, and this company\'s own rows', () => {
    const options = grnRackOptionsWithSiblingStock(OWN, 'KL WAREHOUSE', [
      hc('hc-l5-2', 'Rack L5.2', []),
      hc('hc-pg-r1-1', 'Rack R1.1', [9], 'PG WAREHOUSE'),
      hc('own-l5-1', 'Rack L5.1', [3]),
    ]);
    expect(options.map((o) => o.label)).toEqual(['Rack L5.1', 'Rack L5.2', 'Rack R1.1']);
  });

  it('names each company once with its total, and matches the label loosely', () => {
    const options = grnRackOptionsWithSiblingStock(OWN, 'kl warehouse ', [
      hc('a', 'rack l5.1', [1]),
      hc('b', 'RACK L5.1 ', [2], 'KL WAREHOUSE', 'HC'),
      hc('c', 'Rack L5.1', [5], 'KL WAREHOUSE', 'SG'),
    ]);
    expect(options[0].label).toBe('Rack L5.1 · HC 3 pcs, SG 5 pcs');
  });

  it('without a warehouse code or any sibling it is the plain sorted list', () => {
    expect(grnRackOptionsWithSiblingStock(OWN, null, [hc('x', 'Rack L5.1', [1])]).map((o) => o.label))
      .toEqual(['Rack L5.1', 'Rack L5.2', 'Rack R1.1']);
    expect(grnRackOptionsWithSiblingStock(OWN, 'KL WAREHOUSE', [])).toHaveLength(3);
  });
});
