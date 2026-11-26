import { describe, it, expect } from 'vitest';
import {
  recomputeFromSnapshot,
  recomputeOneLine,
  type MfgItemForRecompute,
  type ProductRowLite,
} from './mfg-pricing-recompute';

const product: ProductRowLite = {
  code: 'ACC-1', category: 'ACCESSORY',
  base_price_sen: 10000, price1_sen: null, cost_price_sen: 3000,
  seat_height_prices: null, base_model: null, sell_price_sen: 10000,
};
const item = (clientSen: number): MfgItemForRecompute => ({
  itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: clientSen, variants: {},
});
const trusted = (clientSen: number) =>
  recomputeFromSnapshot(item(clientSen), product, null, null, null, null, null, null, null, null, null, null, null, null, true);

describe('recomputeFromSnapshot — trustOperatorSelling (owner ruling 2026-07)', () => {
  it('DEFAULT (POS / untrusted): a catalog line persists the AUTHORITATIVE price + flags drift', () => {
    const r = recomputeFromSnapshot(item(5000), product, null, null);
    expect(r.unit_price_sen).toBe(10000);
    expect(r.drift).toBe(true);
  });

  it('TRUSTED non-POS author: the catalog line persists the OPERATOR hand-typed price', () => {
    expect(trusted(5000).unit_price_sen).toBe(5000);
  });

  it('TRUSTED but no price entered (client 0 = "not provided"): keep the authoritative fill', () => {
    expect(trusted(0).unit_price_sen).toBe(10000);
  });

  it('TRUSTED does NOT touch cost (server snapshot stays authoritative)', () => {
    const r = trusted(5000);
    expect(r.unit_price_sen).toBe(5000);
    expect(typeof r.unit_cost_sen).toBe('number');
  });
});

const includingZero = (clientSen: number) =>
  recomputeFromSnapshot(item(clientSen), product, null, null, null, null, null, null, null, null, null, null, null, null, 'including-zero');

describe("recomputeFromSnapshot — trustOperatorSelling 'including-zero' (migrated documents)", () => {
  it('a stored 0 is a REAL price and survives — the migrated sofa sibling case', () => {
    expect(includingZero(0).unit_price_sen).toBe(0);
    expect(trusted(0).unit_price_sen).toBe(10000);
  });

  it('a non-zero stored price behaves exactly like plain trust', () => {
    expect(includingZero(5000).unit_price_sen).toBe(5000);
  });

  it('cost is still a server snapshot — trusting a 0 SELL never zeroes COST', () => {
    const untrusted = recomputeFromSnapshot(item(0), product, null, null);
    expect(includingZero(0).unit_cost_sen).toBe(untrusted.unit_cost_sen);
    expect(includingZero(0).unit_price_sen).toBe(0);
    expect(untrusted.unit_price_sen).toBe(10000);
  });
});

type StubRow = Record<string, unknown> | null;
function stubSb(rowsByTable: Record<string, StubRow | StubRow[]>) {
  const builder = (table: string): Record<string, unknown> => {
    const row = rowsByTable[table];
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
      not: () => chain, gt: () => chain, lte: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: Array.isArray(row) ? (row[0] ?? null) : (row ?? null), error: null }),
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: Array.isArray(row) ? row : (row ? [row] : []), error: null }),
    };
    return chain;
  };
  return { from: (t: string) => builder(t) };
}

describe('recomputeOneLine — forwards the trust option (guards the dropped-argument bug)', () => {
  const sb = stubSb({ mfg_products: { ...product, pwp_price_sen: null, model_id: null, size_code: null, branding: null, default_free_gifts: null } });
  const line: MfgItemForRecompute = { itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceSen: 5000, variants: {} };

  it('NO option: the authoritative catalogue price wins (today\'s default, unchanged)', async () => {
    const r = await recomputeOneLine(sb, line, null, 1);
    expect(r.unit_price_sen).toBe(10000);
  });

  it('trustOperatorSelling: true reaches recomputeFromSnapshot', async () => {
    const r = await recomputeOneLine(sb, line, null, 1, { trustOperatorSelling: true });
    expect(r.unit_price_sen).toBe(5000);
  });

  it("trustOperatorSelling: 'including-zero' reaches it too — a migrated 0 survives", async () => {
    const r = await recomputeOneLine(sb, { ...line, unitPriceSen: 0 }, null, 1, { trustOperatorSelling: 'including-zero' });
    expect(r.unit_price_sen).toBe(0);
  });
});
