import { describe, expect, it } from 'vitest';
import { siblingWarehouses } from './rack-sibling-warehouses';

const HC_KL = { id: 'hc-kl', code: 'KL WAREHOUSE', company_id: 1 };
const HC_PG = { id: 'hc-pg', code: 'PG WAREHOUSE', company_id: 1 };
const S2990_KL = { id: '2990-kl', code: 'KL WAREHOUSE', company_id: 2 };
const S2990_PG = { id: '2990-pg', code: 'PG WAREHOUSE', company_id: 2 };
const S2990_PJ = { id: '2990-pj', code: 'PJ SHOWROOM', company_id: 2 };
const POOL = [HC_KL, HC_PG, S2990_KL, S2990_PG, S2990_PJ];

describe('siblingWarehouses — the other company\'s record of the same building', () => {
  it('finds the other company\'s warehouse with the same code', () => {
    expect(siblingWarehouses([S2990_KL], POOL, 2)).toEqual([HC_KL]);
  });

  it('fans every chosen target out, once each, and never the active company\'s own records', () => {
    expect(siblingWarehouses([HC_KL, HC_PG], POOL, 1)).toEqual([S2990_KL, S2990_PG]);
  });

  it('matches the code loosely, so a stray space or case does not split one building in two', () => {
    const pool = [{ id: 'x', code: ' kl warehouse ', company_id: 1 }];
    expect(siblingWarehouses([S2990_KL], pool, 2)).toEqual(pool);
  });

  it('returns nothing when no other company has that code, or the record cannot be stamped', () => {
    expect(siblingWarehouses([S2990_PJ], POOL, 2)).toEqual([]);
    expect(siblingWarehouses([S2990_KL], [{ id: 'orphan', code: 'KL WAREHOUSE', company_id: null }], 2)).toEqual([]);
  });

  it('does not re-add a target the caller already chose', () => {
    expect(siblingWarehouses([S2990_KL, HC_KL], POOL, 2)).toEqual([]);
  });
});
