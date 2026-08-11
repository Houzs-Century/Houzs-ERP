import { describe, it, expect } from 'vitest';
import {
  recomputeFromSnapshot,
  recomputeOneLine,
  type MfgItemForRecompute,
  type ProductRowLite,
} from './mfg-pricing-recompute';

// A plain non-sofa catalog product with an authoritative sell price of RM 100.
const product: ProductRowLite = {
  code: 'ACC-1', category: 'ACCESSORY',
  base_price_sen: 10000, price1_sen: null, cost_price_sen: 3000,
  seat_height_prices: null, base_model: null, sell_price_sen: 10000,
};
const item = (clientCenti: number): MfgItemForRecompute => ({
  itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceCenti: clientCenti, variants: {},
});
// recomputeFromSnapshot(item, product, fabric, config, ...10 optional..., trustOperatorSelling)
const trusted = (clientCenti: number) =>
  recomputeFromSnapshot(item(clientCenti), product, null, null, null, null, null, null, null, null, null, null, null, null, true);

describe('recomputeFromSnapshot — trustOperatorSelling (owner ruling 2026-07)', () => {
  it('DEFAULT (POS / untrusted): a catalog line persists the AUTHORITATIVE price + flags drift', () => {
    const r = recomputeFromSnapshot(item(5000), product, null, null); // trust defaults false
    expect(r.unit_price_sen).toBe(10000); // catalog wins — client RM50 ignored
    expect(r.drift).toBe(true);           // 5000 vs 10000 -> drift (a POS caller would be 400'd)
  });

  it('TRUSTED non-POS author: the catalog line persists the OPERATOR hand-typed price', () => {
    expect(trusted(5000).unit_price_sen).toBe(5000); // RM50 honoured, not normalised to RM100
  });

  it('TRUSTED but no price entered (client 0 = "not provided"): keep the authoritative fill', () => {
    expect(trusted(0).unit_price_sen).toBe(10000); // filled from catalog, not persisted as 0
  });

  it('TRUSTED does NOT touch cost (server snapshot stays authoritative)', () => {
    const r = trusted(5000);
    expect(r.unit_price_sen).toBe(5000);          // sell = operator override
    expect(typeof r.unit_cost_sen).toBe('number'); // cost still a server-computed snapshot, independent of the sell
  });
});

/* ── 'including-zero' — the MIGRATED-order variant ───────────────────────────
   A migrated sofa is routinely carried as the whole-set price on ONE lead module
   line with 0 on its siblings. Plain `true` reads a stored 0 as "not provided"
   and hands the sibling a catalogue price anyway, so the set gets billed several
   times over. These are the two rows that separate the two modes. */
const includingZero = (clientCenti: number) =>
  recomputeFromSnapshot(item(clientCenti), product, null, null, null, null, null, null, null, null, null, null, null, null, 'including-zero');

describe("recomputeFromSnapshot — trustOperatorSelling 'including-zero' (migrated documents)", () => {
  it('a stored 0 is a REAL price and survives — the migrated sofa sibling case', () => {
    expect(includingZero(0).unit_price_sen).toBe(0);
    // ...where plain `true` would have handed it the catalogue RM100:
    expect(trusted(0).unit_price_sen).toBe(10000);
  });

  it('a non-zero stored price behaves exactly like plain trust', () => {
    expect(includingZero(5000).unit_price_sen).toBe(5000);
  });

  it('cost is still a server snapshot — trusting a 0 SELL never zeroes COST', () => {
    // The invariant is INDEPENDENCE, not a particular figure: the cost snapshot
    // is whatever the (product, fabric, config) inputs say, identical whether the
    // selling price was trusted or overwritten. Asserting equality against the
    // untrusted run is what actually guards "trust never leaks into cost".
    const untrusted = recomputeFromSnapshot(item(0), product, null, null);
    expect(includingZero(0).unit_cost_sen).toBe(untrusted.unit_cost_sen);
    expect(includingZero(0).unit_price_sen).toBe(0);      // sell: the migrated 0 survived
    expect(untrusted.unit_price_sen).toBe(10000);          // sell: the default still fills
  });
});

/* ── The pass-through guard ──────────────────────────────────────────────────
   THE REGRESSION THIS EXISTS FOR. recomputeOneLine used to call
   recomputeFromSnapshot with 14 positional arguments and let the 15th
   (trustOperatorSelling) default to false. It could not be passed at all, so the
   SO amendment path — recomputeOneLine's only caller — re-priced every approved
   amendment to catalogue, including migrated orders carrying the price AutoCount
   negotiated with the customer.

   A test on recomputeFromSnapshot alone would NOT have caught that: the pure
   function was always correct. The bug lived in the wrapper's argument list. So
   this drives the wrapper, and it fails if the option stops being forwarded. */
type StubRow = Record<string, unknown> | null;
/** Minimal Supabase-shaped stub: every loader in recomputeOneLine issues
 *  `.from(t).select(...).eq(...)...` and finishes with either `.maybeSingle()`
 *  or by awaiting the builder. Both resolve to `{ data }`. */
function stubSb(rowsByTable: Record<string, StubRow | StubRow[]>) {
  const builder = (table: string): Record<string, unknown> => {
    const row = rowsByTable[table];
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, in: () => chain, is: () => chain,
      not: () => chain, gt: () => chain, order: () => chain, limit: () => chain,
      maybeSingle: async () => ({ data: Array.isArray(row) ? (row[0] ?? null) : (row ?? null), error: null }),
      // Awaiting the builder itself (the list-returning loaders).
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: Array.isArray(row) ? row : (row ? [row] : []), error: null }),
    };
    return chain;
  };
  return { from: (t: string) => builder(t) };
}

describe('recomputeOneLine — forwards the trust option (guards the dropped-argument bug)', () => {
  const sb = stubSb({ mfg_products: { ...product, pwp_price_sen: null, model_id: null, size_code: null, branding: null, default_free_gifts: null } });
  const line: MfgItemForRecompute = { itemCode: 'ACC-1', itemGroup: 'accessory', qty: 1, unitPriceCenti: 5000, variants: {} };

  it('NO option: the authoritative catalogue price wins (today\'s default, unchanged)', async () => {
    const r = await recomputeOneLine(sb, line, null, 1);
    expect(r.unit_price_sen).toBe(10000);
  });

  it('trustOperatorSelling: true reaches recomputeFromSnapshot', async () => {
    const r = await recomputeOneLine(sb, line, null, 1, { trustOperatorSelling: true });
    expect(r.unit_price_sen).toBe(5000); // fails if the 15th argument is dropped again
  });

  it("trustOperatorSelling: 'including-zero' reaches it too — a migrated 0 survives", async () => {
    const r = await recomputeOneLine(sb, { ...line, unitPriceCenti: 0 }, null, 1, { trustOperatorSelling: 'including-zero' });
    expect(r.unit_price_sen).toBe(0); // fails if the 15th argument is dropped again
  });
});
