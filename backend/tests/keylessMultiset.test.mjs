/* A document whose lines cannot be PAIRED can still be VERIFIED — as a multiset.
 *
 * `check-ac-erp-reconcile.mjs` refuses to line-match a document when no ERP line
 * carries an AutoCount line key and the counts differ. The refusal is right:
 * pairing by POSITION produced transposed pairs five separate times on
 * 2026-09-07/08. But a refusal is not an answer, and it was three times
 * reported as one. These tests pin the answer that replaces it, and — more
 * importantly — pin the two ways it could quietly become a lie:
 *
 *   1. a bag comparison that calls a REORDERING a difference (it must not), and
 *   2. a sofa fold that STATES a quantity it cannot know (it must say so).
 */
import { describe, it, expect } from 'vitest';
import { bagOf, compareBags, printableBag, isSofaCode } from '../scripts/lib/keyless-multiset.mjs';

const bookRow = (code, qty, rm) => ({ code, rawCode: code, qty, sen: Math.round(rm * 100) });
const erpRow = (code, qty, rmUnit, suffixed = false) => ({
  code, qty, sen: Math.round(qty * rmUnit * 100), suffixed,
});
const cmp = (b, e, compareMoney = true) =>
  compareBags({ book: bagOf(b, 'book'), erp: bagOf(e, 'erp'), compareMoney });

describe('order is not part of the answer', () => {
  it('calls a pure reordering IDENTICAL', () => {
    const book = [bookRow('AAA', 1, 100), bookRow('BBB', 2, 50), bookRow('CCC', 1, 75)];
    const erp = [erpRow('CCC', 1, 75), erpRow('AAA', 1, 100), erpRow('BBB', 2, 25)];
    expect(cmp(book, erp).verdict).toBe('IDENTICAL');
  });

  it('is IDENTICAL even when the LINE COUNTS differ, if the bags agree', () => {
    /* This is the whole population: the counts differ, which is why the
       reconcile gave up. Two book lines of the same code against one merged ERP
       line is the same bag. */
    const book = [bookRow('AAA', 1, 100), bookRow('AAA', 1, 100)];
    const erp = [erpRow('AAA', 2, 100)];
    expect(cmp(book, erp).verdict).toBe('IDENTICAL');
  });
});

describe('a real difference survives, and names itself', () => {
  it('reports a MISSING item with the book quantity', () => {
    const book = [bookRow('AAA', 1, 100), bookRow('SQUARE PILLOW', 4, 20)];
    const erp = [erpRow('AAA', 1, 100)];
    const r = cmp(book, erp);
    expect(r.verdict).toBe('DIFFERS');
    expect(r.differences.join(' ')).toContain('SQUARE PILLOW');
    expect(r.differences.join(' ')).toContain('we have NO such line');
  });

  it('reports an EXTRA item our side carries and the book does not', () => {
    const r = cmp([bookRow('AAA', 1, 100)], [erpRow('AAA', 1, 100), erpRow('ZZZ', 1, 10)]);
    expect(r.verdict).toBe('DIFFERS');
    expect(r.differences.join(' ')).toContain('the book has no such item');
  });

  it('reports a QUANTITY difference on a code both sides carry', () => {
    const r = cmp([bookRow('AAA', 3, 300)], [erpRow('AAA', 2, 100)]);
    expect(r.verdict).toBe('DIFFERS');
    expect(r.differences[0]).toContain('book qty 3 vs ours 2');
  });

  it('reports money only where the type copies it from the book', () => {
    const book = [bookRow('AAA', 1, 100)];
    const erp = [erpRow('AAA', 1, 80)];
    expect(cmp(book, erp, true).verdict).toBe('DIFFERS');
    /* On a goods receipt the price is taken from the PURCHASE ORDER by design,
       and on a migrated delivery order the ERP holds none at all. Comparing it
       there measures our own derivation, not the book. */
    expect(cmp(book, erp, false).verdict).toBe('IDENTICAL');
  });

  it('excuses the free line the book bills at RM 0.00 and we do not carry', () => {
    const book = [bookRow('AAA', 1, 100), bookRow('AK-SLEEP ESSENTIAL 7 HOLES', 1, 0)];
    expect(cmp(book, [erpRow('AAA', 1, 100)]).verdict).toBe('IDENTICAL');
  });
});

describe('the sofa fold', () => {
  it('folds one book sofa line against our compartment rows', () => {
    /* One AutoCount line, three ERP rows, price riding the lead piece. */
    const book = [bookRow('DSL-8030 SOFA', 1, 1930)];
    const erp = [
      erpRow('8030-1A(LHF)', 1, 1930), erpRow('8030-CNR', 1, 0), erpRow('8030-2A(RHF)', 1, 0),
    ];
    expect(cmp(book, erp).verdict).toBe('IDENTICAL');
  });

  it('folds the ALIAS: the floor writes 5540 for the same sofa as 8030', () => {
    const book = [bookRow('HOK-5540 SOFA', 1, 1930)];
    const erp = [erpRow('8030-1A(LHF)', 1, 1930), erpRow('8030-2A(RHF)', 1, 0)];
    expect(cmp(book, erp).verdict).toBe('IDENTICAL');
  });

  it('NEVER folds 5535 — it is its own model, and folding it would clean a real finding', () => {
    const book = [bookRow('HOK-5535 SOFA', 1, 1930)];
    const erp = [erpRow('8030-1A(LHF)', 1, 1930), erpRow('8030-2A(RHF)', 1, 0)];
    const r = cmp(book, erp);
    expect(r.verdict).toBe('DIFFERS');
    expect(r.differences.join(' ')).toContain('SOFA 5535');
  });

  it('catches a WRONG MODEL under the fold', () => {
    const book = [bookRow('DSL-8030 SOFA', 1, 1930)];
    const erp = [erpRow('9058-1A(LHF)', 1, 1930), erpRow('9058-2A(RHF)', 1, 0)];
    expect(cmp(book, erp).verdict).toBe('DIFFERS');
  });

  it('does NOT fold an accessory whose NAME merely contains the word', () => {
    /* "AMN-SOFA PILLOW" takes the /SOFA/ branch but yields no model, so it is
       compared as the plain code it is — byte-identical on both sides. */
    expect(isSofaCode('AMN-SOFA PILLOW')).toBe(true);
    const r = cmp([bookRow('AMN-SOFA PILLOW', 2, 40)], [erpRow('AMN-SOFA PILLOW', 2, 20)]);
    expect(r.verdict).toBe('IDENTICAL');
  });

  it('says AMBIGUOUS — never a number — when the compartments are UNEVEN', () => {
    /* Two sofas' worth of one piece and one of another: the fold cannot state
       how many whole sofas that is. Both sides are returned for a person. */
    const book = [bookRow('DSL-8030 SOFA', 2, 3860)];
    const erp = [erpRow('8030-1A(LHF)', 2, 1930), erpRow('8030-2A(RHF)', 1, 0)];
    const r = cmp(book, erp);
    expect(r.verdict).toBe('AMBIGUOUS');
    expect(r.differences).toHaveLength(0);
    expect(r.ambiguities[0]).toContain('between 1 and 2');
  });

  it('uses MIN, not MAX, so an uneven fold can never overstate what is whole', () => {
    const bag = bagOf([erpRow('8030-1A(LHF)', 5, 100), erpRow('8030-CNR', 2, 0)], 'erp');
    expect(bag.get('SOFA 8030').qty).toBe(2);
    expect(bag.get('SOFA 8030').ceiling).toBe(5);
  });

  it('a DIFFERENCE outranks an ambiguity — the document is not called undecidable', () => {
    const book = [bookRow('DSL-8030 SOFA', 2, 3860), bookRow('SQUARE PILLOW', 4, 80)];
    const erp = [erpRow('8030-1A(LHF)', 2, 1930), erpRow('8030-2A(RHF)', 1, 0)];
    const r = cmp(book, erp);
    expect(r.verdict).toBe('DIFFERS');
    expect(r.differences.join(' ')).toContain('SQUARE PILLOW');
  });
});

describe('printableBag', () => {
  it('prints an uneven sofa as a RANGE, so no reader takes a folded number as fact', () => {
    const bag = bagOf([erpRow('8030-1A(LHF)', 2, 1930), erpRow('8030-2A(RHF)', 1, 0)], 'erp');
    expect(printableBag(bag)).toBe('SOFA 8030 x1..2 @ RM 3860.00');
  });

  it('says so rather than printing nothing when a side has no lines', () => {
    expect(printableBag(bagOf([], 'erp'))).toBe('(no lines)');
  });
});
