import { describe, expect, test } from 'vitest';
// @ts-expect-error - plain .mjs, shared with the stock reconcile script
import { sofaModelOf, makeModelMatcher, foldSofaPieces } from '../scripts/lib/sofa-piece-fold.mjs';

/* The fold that makes AutoCount's whole sofas and the ERP's compartments
   comparable (owner ruling 2026-09-07: 「把我们的件数折回成整张沙发再比」).

   These tests exist because a fold that cannot match reports a clean run: if the
   model matcher silently returned null, every ERP sofa cell would fold to zero
   and the comparison would read "AutoCount has 76 sofas the ERP does not" — a
   gap invented by the matcher rather than found by it. That is the same failure
   docs/stock-reconciliation.md §4 records for the sofa exclusion itself.

   A vitest file rather than node:test on purpose — the coverage ratchet reads
   vitest reports only, and a module it cannot see it reports as untested. */

const row = (model: string, warehouseId: string, batchNo: string | null, itemCode: string, qty: number) =>
  ({ model, warehouseId, batchNo, itemCode, qty });

describe('sofaModelOf', () => {
  test('strips the binding target suffix, not the first dash', () => {
    expect(sofaModelOf('9028-1S')).toBe('9028');
    expect(sofaModelOf('5015A-1S')).toBe('5015A');
    // the one binding row whose model contains its own dash
    expect(sofaModelOf('SOFA-333 44-1S')).toBe('SOFA-333 44');
  });
  test('refuses anything that is not a -1S binding target', () => {
    expect(sofaModelOf('9028-CNR')).toBeNull();
    expect(sofaModelOf('')).toBeNull();
  });
});

describe('makeModelMatcher', () => {
  const match = makeModelMatcher(['9028', 'SOFA', 'SOFA-333 44', '5015', '5015A']);
  test('maps a compartment code to its model', () => {
    expect(match('9028-1A(LHF)')).toBe('9028');
    expect(match('9028-CNR')).toBe('9028');
  });
  test('LONGEST prefix wins — SOFA-333 44 is not the model SOFA', () => {
    expect(match('SOFA-333 44-CNR')).toBe('SOFA-333 44');
    expect(match('SOFA-1A')).toBe('SOFA');
  });
  test('a dash is required, so 5015A is never read as 5015', () => {
    expect(match('5015A-CNR')).toBe('5015A');
    expect(match('5015-CNR')).toBe('5015');
  });
  test('an unknown code is null, never guessed into a model', () => {
    expect(match('KETTA-L(LHF)')).toBeNull();
  });
});

describe('foldSofaPieces', () => {
  test('one build, three compartments, all present: one whole sofa', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 1),
      row('9028', 'w1', 'PO-1', '9028-CNR', 1),
      row('9028', 'w1', 'PO-1', '9028-2A(RHF)', 1),
    ]);
    expect(out.get('9028|w1')).toMatchObject({ whole: 1, ceiling: 1, builds: 1, incomplete: 0 });
  });

  test('a build of TWO sofas carries the count on every piece', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 2),
      row('9028', 'w1', 'PO-1', '9028-CNR', 2),
    ]);
    expect(out.get('9028|w1')!.whole).toBe(2);
  });

  test('a build with a piece shipped is NOT a whole sofa — min, not max', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 1),
      row('9028', 'w1', 'PO-1', '9028-CNR', 0),
    ]);
    const cell = out.get('9028|w1')!;
    expect(cell.whole).toBe(0);
    expect(cell.ceiling).toBe(1);
    expect(cell.incomplete).toBe(1);
  });

  test('two builds of the same model at one warehouse add up', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 1),
      row('9028', 'w1', 'PO-1', '9028-CNR', 1),
      row('9028', 'w1', 'PO-2', '9028-1A(LHF)', 1),
      row('9028', 'w1', 'PO-2', '9028-CNR', 1),
    ]);
    expect(out.get('9028|w1')).toMatchObject({ whole: 2, builds: 2 });
  });

  test('the same batch at two warehouses stays two cells', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-CNR', 1),
      row('9028', 'w2', 'PO-1', '9028-CNR', 1),
    ]);
    expect(out.get('9028|w1')!.whole).toBe(1);
    expect(out.get('9028|w2')!.whole).toBe(1);
  });

  test('two variant rows of ONE compartment in ONE build are that build\'s one piece', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-CNR', 1),
      row('9028', 'w1', 'PO-1', '9028-CNR', 1),
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 2),
    ]);
    expect(out.get('9028|w1')!.whole).toBe(2);
  });

  test('rows with no batch fold as one pseudo-build and are COUNTED as such', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', null, '9028-1A(LHF)', 3),
      row('9028', 'w1', '', '9028-CNR', 3),
    ]);
    expect(out.get('9028|w1')).toMatchObject({ whole: 3, builds: 1, noBatch: 1 });
  });

  test('a negative piece is reported, not clamped away', () => {
    const out = foldSofaPieces([
      row('9028', 'w1', 'PO-1', '9028-CNR', -2),
      row('9028', 'w1', 'PO-1', '9028-1A(LHF)', 1),
    ]);
    expect(out.get('9028|w1')).toMatchObject({ whole: -2, negative: 1 });
  });

  test('a row the matcher could not name a model for is dropped, never bucketed', () => {
    const out = foldSofaPieces([row(null as unknown as string, 'w1', 'PO-1', 'KETTA-CNR', 5)]);
    expect(out.size).toBe(0);
  });
});
