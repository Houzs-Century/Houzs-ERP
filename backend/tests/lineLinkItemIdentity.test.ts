/* The RULE behind docs/bugs/0672 site 15's twelve guards.
 *
 * `keyWithoutIdentityGuards.test.mjs` pins that each call site APPLIES the
 * rule — a call-site population is what a unit test cannot see. This file pins
 * that the rule is RIGHT: what it accepts, what it refuses, and (the two that
 * actually matter) that it refuses rather than shrugs when identity cannot be
 * established at all.
 */
import { describe, expect, it } from 'vitest';
import { lineLinkItemMismatch, normLinkItemCode } from '../src/scm/lib/line-link-item-identity';

const src = (pairs: Array<[string, string | null]>) => new Map<string, string | null>(pairs);
const LBL = { source: 'Delivery Order line' };

describe('normLinkItemCode — the same normalisation as soLinkItemMismatch and normItemCode', () => {
  it('trims, upper-cases and collapses inner whitespace', () => {
    expect(normLinkItemCode('  regal-2s  ')).toBe('REGAL-2S');
    expect(normLinkItemCode('REGAL   2S')).toBe('REGAL 2S');
  });

  it('maps null, undefined and blank to the same empty string', () => {
    expect(normLinkItemCode(null)).toBe('');
    expect(normLinkItemCode(undefined)).toBe('');
    expect(normLinkItemCode('   ')).toBe('');
  });
});

describe('lineLinkItemMismatch', () => {
  it('accepts a link whose two sides name the same product', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    )).toBeNull();
  });

  it('accepts a difference that is only formatting', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: ' regal-2s ' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    )).toBeNull();
  });

  /* The real shape of the bug: REGAL bound to TRION. Both rows exist, the
     foreign key is valid, nothing dangles. */
  it('refuses a link whose source names a different product', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'TRION-2S']]),
      LBL,
    );
    expect(out?.error).toBe('link_material_mismatch');
    expect(out?.itemCode).toBe('REGAL-2S');
    expect(out?.sourceItemCode).toBe('TRION-2S');
    expect(out?.linkId).toBe('do-1');
  });

  it('names both products and the source document type in the reason', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }],
      src([['do-1', 'TRION-2S']]),
      { source: 'Goods Receipt line' },
    );
    expect(out?.reason).toContain('REGAL-2S');
    expect(out?.reason).toContain('TRION-2S');
    expect(out?.reason).toContain('Goods Receipt line');
  });

  it('ignores an unlinked line — a manual line is not this rule\'s business', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: '', itemCode: 'ANYTHING' }],
      src([]),
      LBL,
    )).toBeNull();
  });

  /* THE TWO THAT MATTER. "I could not establish identity" must not be spelled
     the same way as "identity is fine" — that is the false negative the whole
     bug class is made of. */
  it('REFUSES a link whose source row is not in the map at all', () => {
    const out = lineLinkItemMismatch(
      [{ linkId: 'do-ghost', itemCode: 'REGAL-2S' }],
      src([['do-1', 'REGAL-2S']]),
      LBL,
    );
    expect(out?.error).toBe('link_material_mismatch');
    expect(out?.sourceItemCode).toBeNull();
    expect(out?.reason).toContain('could not be read back');
  });

  it('REFUSES when either side carries a blank item code', () => {
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: 'REGAL-2S' }], src([['do-1', null]]), LBL,
    )?.error).toBe('link_material_mismatch');
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: null }], src([['do-1', 'REGAL-2S']]), LBL,
    )?.error).toBe('link_material_mismatch');
    expect(lineLinkItemMismatch(
      [{ linkId: 'do-1', itemCode: '  ' }], src([['do-1', '  ']]), LBL,
    )?.error).toBe('link_material_mismatch');
  });

  it('reports the FIRST offender and does not stop at the first good line', () => {
    const out = lineLinkItemMismatch(
      [
        { linkId: 'do-1', itemCode: 'REGAL-2S' },
        { linkId: 'do-2', itemCode: 'REGAL-3S' },
        { linkId: 'do-3', itemCode: 'REGAL-CNR' },
      ],
      src([['do-1', 'REGAL-2S'], ['do-2', 'TRION-3S'], ['do-3', 'ELSE']]),
      LBL,
    );
    expect(out?.linkId).toBe('do-2');
  });

  /* A sofa is one model decomposed into compartments, each its own ERP line
     with its own code. The rule compares the LINE's code, so the compartments
     of one order pass individually and a compartment bound to another model's
     compartment does not. */
  it('accepts a sofa\'s compartments and refuses one crossed with another model', () => {
    expect(lineLinkItemMismatch(
      [
        { linkId: 'so-1', itemCode: 'PC151-1S' },
        { linkId: 'so-2', itemCode: 'PC151-CNR' },
      ],
      src([['so-1', 'PC151-1S'], ['so-2', 'PC151-CNR']]),
      { source: 'Sales Order line' },
    )).toBeNull();

    expect(lineLinkItemMismatch(
      [{ linkId: 'so-2', itemCode: 'PC151-CNR' }],
      src([['so-2', 'PC160-CNR']]),
      { source: 'Sales Order line' },
    )?.error).toBe('link_material_mismatch');
  });
});
