// The one rule that decides whether a column states the sofa piece its ITEM
// CODE states — shared by the sweep (repair-sofa-line-shown-vs-code.mjs), the
// compartment-corrections applier and the in-place rename tool, so all three
// move the same set of columns. docs/bugs/0822.
//
// Both regressions this matcher has already produced are pinned below as named
// cases, because each one was a CHECKER THAT COULD NOT MATCH reporting a clean
// (or catastrophically dirty) run — the trap CLAUDE.md names.
import { describe, it, expect } from 'vitest';
import {
  FIXTURES, assertMatcherSane, disagrees, movePieceTo, namesAPiece, norm, pieceOf,
} from '../scripts/lib/sofa-piece-token.mjs';

describe('pieceOf — the code is model-piece, split on the FIRST dash', () => {
  it('takes everything after the first dash', () => {
    expect(pieceOf('9058-2A(RHF)')).toBe('2A(RHF)');
    expect(pieceOf('8050-1A(R)(LHF)')).toBe('1A(R)(LHF)');   // recliner: two parentheticals
    expect(pieceOf('2990 ANGGN-FIRM MATT (K)')).toBe('FIRM MATT (K)');
  });
  it('answers the whole string when there is no dash', () => {
    expect(pieceOf('SQUARE PILLOW')).toBe('SQUARE PILLOW');
  });
});

describe('namesAPiece — a text that states none is the supplier own product name', () => {
  it('is false for the supplier own model names, which must be left alone', () => {
    for (const s of ['HOK SOFA - 5536', 'AMN SOFA - SF9058', 'DSL SOFA - 8030', 'HOK-5540 SOFA']) {
      expect(namesAPiece(s)).toBe(false);
    }
  });
  it('is true for every piece vocabulary the catalogue mints', () => {
    for (const s of ['SOFA VERANO 2A(LHF)', 'SOFA SOFFIO 1S', 'SOFA MAYBATCH 1NA',
      'SOFA NOVA L(RHF)', 'SOFA X CNR', 'SOFA X CONSOLE', 'SOFA X STOOL']) {
      expect(namesAPiece(s)).toBe(true);
    }
  });
  it('REGRESSION: a token ending in ")" has no word boundary after it', () => {
    // A `\b` after the paren matched nothing, so the first version of this
    // matcher reported 0 findings on 17 real ones.
    expect(namesAPiece('SOFA VERANO 2A(LHF)')).toBe(true);
  });
});

describe('disagrees — names a piece, and not ours', () => {
  it('agrees on every fixture that agrees', () => {
    for (const [code, shown] of FIXTURES.agree) expect(disagrees(code, shown)).toBe(false);
  });
  it('flags every fixture that differs', () => {
    for (const [code, shown] of FIXTURES.differ) expect(disagrees(code, shown)).toBe(true);
  });
  it('REGRESSION: the delimiter test must not run on squashed text', () => {
    // Squashing whitespace deletes the space that separates the model word from
    // the piece, so "SOFA LAZIO 1A(R)(LHF)" reads as undelimited and a recliner
    // code appears to disagree with its own name. 67 false positives on the
    // sales-order arm of the 2026-09-11 census came from exactly this.
    expect(disagrees('8050-1A(R)(LHF)', 'SOFA LAZIO 1A(R)(LHF)')).toBe(false);
    expect(norm('SOFA  LAZIO   1A(R)(LHF)')).toBe('SOFA LAZIO 1A(R)(LHF)');
  });
  it('does not flag an undelimited coincidence', () => {
    // `1A(LHF)` sitting inside `21A(LHF)` is a different piece, not ours.
    expect(disagrees('9058-1A(LHF)', 'SOFA X 21A(LHF)')).toBe(true);
  });
  it('an empty or missing value is not a disagreement', () => {
    for (const v of ['', null, undefined]) expect(disagrees('9058-1A(LHF)', v)).toBe(false);
  });
});

describe('movePieceTo — ONLY the piece token moves', () => {
  it('corrects each differing fixture to exactly the expected text', () => {
    for (const [code, shown, want] of FIXTURES.differ) {
      expect(movePieceTo(shown, pieceOf(code))).toBe(want);
    }
  });
  it('keeps the SUPPLIER own spelling of the model', () => {
    // A document is a snapshot of what was sent: the model word must not be
    // replaced from a master row whose spelling has since changed.
    expect(movePieceTo('HOK-5540 SOFA 2A(LHF)', '1A(LHF)')).toBe('HOK-5540 SOFA 1A(LHF)');
    expect(movePieceTo('5540-L(LHF)', '1A(LHF)')).toBe('5540-1A(LHF)');
  });
  it('is convergent — a corrected value is not selected again', () => {
    for (const [code, shown] of FIXTURES.differ) {
      const once = movePieceTo(shown, pieceOf(code));
      expect(disagrees(code, once)).toBe(false);
      expect(movePieceTo(once, pieceOf(code))).toBe(once);
    }
  });
});

describe('assertMatcherSane — a verdict computed over nothing must not read as a pass', () => {
  it('passes on the shipped matcher', () => {
    expect(() => assertMatcherSane()).not.toThrow();
  });
});
