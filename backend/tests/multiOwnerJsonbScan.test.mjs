// ---------------------------------------------------------------------------
// multiOwnerJsonbScan.test.mjs — the checker's own proof.
//
// A guard that has never been shown to fail is not known to work, so the
// scanner behind `npm run audit:multi-owner-jsonb` is exercised here against
// the REAL shapes of both times this class landed in production — the shape
// that caused the damage and the shape that fixed it, transcribed from the
// actual files — plus the mentions it must stay silent about, because a gate
// that cries on a type declaration is a gate people learn to ignore.
//
// The CLI walks the filesystem; this file does not. Everything below is a
// fixture string through the pure scanner.
// ---------------------------------------------------------------------------

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { COLUMNS, MUTATION_WINDOW, findWrite, scanSource } from '../scripts/lib/multi-owner-jsonb-scan.mjs';

const seat = (src) => findWrite(src, 'seat_height_prices');

// -- the two shapes that actually destroyed money ---------------------------

test('flags the outright assignment auto-derive used (2026-09-16, writeProductCost)', () => {
  /* sofaSeatRowsFromMatrix emits {height, tier, priceSen} and nothing else, so
     this one line deleted 193 of 2990's retail prices across 82 SKUs. */
  const src = `
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.seat_height_prices !== undefined) update.seat_height_prices = patch.seat_height_prices;
    await sb.from('mfg_products').update(update).eq('id', productId);
  `;
  assert.equal(seat(src), 3);
});

test('flags a key inside a mutation payload, a few lines under the call', () => {
  /* The other spelling: no assignment anywhere, the column named straight into
     .update({...}). The payload is usually a few lines below the call. */
  const src = `
    await supabase
      .from('mfg_products')
      .update({
        updated_at: new Date().toISOString(),
        seat_height_prices: rows,
      })
      .eq('code', code);
  `;
  assert.equal(seat(src), 6);
});

test('flags the bulk import replacing one tier of the grid (mfg-products.ts)', () => {
  const src = `
    const kept = existingSeat.filter((e) => !incomingTiers.has(tierOf(e)));
    row.seat_height_prices = [...kept, ...incomingSeat];
  `;
  assert.equal(seat(src), 3);
});

test('flags raw SQL that SETs the column', () => {
  assert.equal(seat("await sql`UPDATE scm.mfg_products SET seat_height_prices = ${grid} WHERE id = ${id}`;"), 1);
});

// -- the mentions that must stay silent -------------------------------------

test('does NOT flag a type declaration, which is read-side and everywhere', () => {
  // The first cut of this scanner matched `col:` anywhere and reported all
  // eight of these. A gate with that hit rate is one nobody reads.
  const src = `
    type ProductRow = {
      seat_height_prices?: ProductSeatCost[] | null;
      prices_by_height: Record<string, number>;
    };
  `;
  assert.deepEqual(scanSource(src), []);
});

test('does NOT flag a select list, a read, or a comment', () => {
  const src = `
    // the seat_height_prices cost grid is pushed one way onto the SKU
    const { data } = await sb.from('mfg_products').select('id, seat_height_prices').eq('code', code);
    const seatRaw = (r.seatHeightPrices ?? r.seat_height_prices) as unknown;
  `;
  assert.deepEqual(scanSource(src), []);
});

test('does NOT flag an object literal far below its mutation call', () => {
  // The look-ahead is a window, not the rest of the file: a key this far down
  // belongs to something else, and claiming it would be a false report.
  const src = ['await sb.from("x").update({', ...Array(MUTATION_WINDOW + 5).fill('  a: 1,'), '  seat_height_prices: v,', '});'].join(
    '\n',
  );
  assert.equal(seat(src), 0);
});

test('does NOT flag equality against the column', () => {
  assert.equal(seat('if (row.seat_height_prices === next.seat_height_prices) return;'), 0);
});

// -- the scanner covers every shared column, not only the sofa grid ---------

test('every registered column is scanned, and a hit names the column it found', () => {
  assert.ok(COLUMNS.includes('seat_height_prices'));
  const hits = scanSource(`
    combo.prices_by_height = derived;
    combo.selling_prices_by_height = retail;
  `);
  assert.deepEqual(
    hits.map((h) => h.col).sort(),
    ['prices_by_height', 'selling_prices_by_height'],
  );
});

test('the first write wins, so the reported line is one a human can open', () => {
  const src = `
    a.seat_height_prices = one;
    b.seat_height_prices = two;
  `;
  assert.equal(seat(src), 2);
});
