import { describe, expect, it } from 'vitest';
import { lorryHomes } from '../src/scm/lib/lorry-depots';

describe("a lorry's home warehouse", () => {
  it('is its home warehouse, else the first it serves, keyed by the plate as the map spells it', () => {
    const homes = lorryHomes([
      { plate: 'VQE 9058', warehouse_id: 'kl', warehouse_ids: ['kl'] },
      { plate: 'W1591T', warehouse_id: null, warehouse_ids: ['pg', 'kl'] },
      { plate: 'BLH5106', warehouse_id: null, warehouse_ids: [] },
    ]);
    expect([...homes]).toEqual([['VQE9058', 'kl'], ['W1591T', 'pg']]);
  });
});
