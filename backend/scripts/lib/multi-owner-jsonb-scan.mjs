// ---------------------------------------------------------------------------
// multi-owner-jsonb-scan.mjs — the pure scanner behind
// `npm run audit:multi-owner-jsonb`.
//
// Separated from the CLI so its logic can be exercised against fixture source
// strings (tests/multiOwnerJsonbScan.test.mjs) without touching the filesystem.
// A checker that has never been shown to fail is not known to work.
//
// THE CLASS. Some jsonb columns carry fields owned by DIFFERENT systems inside
// one value. scm.mfg_products.seat_height_prices is the worst of them: each
// (height, tier) slot holds `priceSen` (COST — ours) next to `sellingPriceSen`
// (RETAIL — authored only from 2990's POS SKU Master):
//
//     { height: '24', tier: 'PRICE_1', priceSen: 51975, sellingPriceSen: 99000 }
//                                      └─ COST, ours    └─ RETAIL, theirs
//
// Nothing in the column's TYPE separates them, so a writer that ASSIGNS the
// whole value deletes the other owner's fields. No compiler disagrees, no test
// disagrees, and the loss is visible only to the other team, on their screen,
// days later.
//
// It has happened twice. A cost-side edit wiped the selling prices (fixed in
// the PATCH route by merging per slot, 2026-06-20); then auto-derive's
// writeProductCost() assigned the derived cost-only array and erased 193 of
// 2990's retail prices across 82 SKUs (2026-09-16 → 09-20).
//
// WHAT IS FLAGGED: a WRITE, not a mention. Two shapes, because `col:` alone
// also matches a TypeScript member (`prices_by_height: Record<string, number>`),
// which is a read-side type and not interesting:
//
//   1. a property assignment   update.seat_height_prices = …   SET col = …
//   2. an object-literal key inside a mutation call
//        .update({ seat_height_prices: … })  .insert(…)  .upsert(…)
//      with a short look-ahead, because the payload is usually a few lines
//      below the call.
//
// WHAT IT CANNOT SEE, stated so nobody mistakes a pass for a proof: a column
// name built at runtime, a spread that happens to carry the key, raw SQL more
// than MUTATION_WINDOW lines under its call. Passing means no write site
// appeared without anyone noticing — not that a listed site merges correctly.
// The merge rule itself is tested in auto-derive-cost.test.ts and enforced for
// company 2 by trg_mfg_products_retail_price_lock.
// ---------------------------------------------------------------------------

/** Columns whose value carries more than one owner's money. */
export const COLUMNS = ['seat_height_prices', 'selling_prices_by_height', 'prices_by_height'];

/** The registered writers, and why each is allowed to write a shared column.
 *  Adding a line here IS the review. Removing a site is always safe. */
export const REGISTERED = new Map([
  ['src/scm/lib/auto-derive-cost.ts', 'merges the retail dimension across (mergeRetailOntoDerivedSeatGrid)'],
  [
    'src/scm/lib/derive-product-cost-from-suppliers.ts',
    'assigns an in-memory COST patch object; auto-derive-cost.ts merges before it reaches the row',
  ],
  [
    'src/scm/routes/mfg-products.ts',
    'PATCH merges per (height, tier) and re-appends dropped retail slots; the bulk import replaces a tier through mergeRetailOntoDerivedSeatGrid',
  ],
  ['src/scm/routes/sofa-combos.ts', 'combo cost derive writes prices_by_height only, never selling_prices_by_height'],
]);

const MUTATION_CALL = /\.(?:update|insert|upsert)\s*\(/;
/** How far below a `.update(`/`.insert(`/`.upsert(` an object key still counts
 *  as part of that call's payload. Long enough for the multi-line payloads this
 *  repo writes, short enough that an unrelated key further down is not claimed. */
export const MUTATION_WINDOW = 25;

const assignPattern = (col) => new RegExp(`(?:\\.${col}\\s*=(?!=)|\\bSET\\s+${col}\\s*=)`);
const literalKeyPattern = (col) => new RegExp(`['"\`]?${col}['"\`]?\\s*:`);

/** First 1-based line of `text` that WRITES `col`, else 0. */
export function findWrite(text, col) {
  const lines = text.split(/\r?\n/);
  const assign = assignPattern(col);
  const key = literalKeyPattern(col);
  let window = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (assign.test(line)) return i + 1;
    if (MUTATION_CALL.test(line)) window = MUTATION_WINDOW;
    else if (window > 0) window--;
    if (window > 0 && key.test(line)) return i + 1;
  }
  return 0;
}

/** Every shared column `text` writes, as [{ col, line }]. */
export function scanSource(text) {
  const hits = [];
  for (const col of COLUMNS) {
    if (!text.includes(col)) continue;
    const line = findWrite(text, col);
    if (line > 0) hits.push({ col, line });
  }
  return hits;
}
