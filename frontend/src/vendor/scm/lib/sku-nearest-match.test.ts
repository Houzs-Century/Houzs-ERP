import { describe, it, expect } from 'vitest';
import { findNearestSku, normaliseSkuCode } from './sku-nearest-match';

/* Shapes taken from the live 2990 catalog so the thresholds are exercised
   against real code lengths, not invented ones. */
const CATALOG = [
  { code: 'BOOQIT-1A(LHF)', name: 'SOFA BOOQIT 1A(LHF)', category: 'SOFA' },
  { code: 'BOOQIT-2A(RHF)', name: 'SOFA BOOQIT 2A(RHF)', category: 'SOFA' },
  { code: 'BOOQIT-CNR', name: 'SOFA BOOQIT CNR', category: 'SOFA' },
  { code: 'CODY-(K)', name: 'CODY BEDFRAME 6FT', category: 'BEDFRAME' },
  { code: 'FENRIR-(Q)', name: 'FENRIR BEDFRAME 5FT', category: 'BEDFRAME' },
  { code: '2990 AKKA-FIRM MATTRESS (183X190X31CM)', name: 'AKKA FIRM 6FT', category: 'MATTRESS' },
];

describe('normaliseSkuCode', () => {
  it('strips punctuation and spacing, uppercases the rest', () => {
    expect(normaliseSkuCode('booqit-1a(lhf)')).toBe('BOOQIT1ALHF');
    expect(normaliseSkuCode('BOOQIT 1A (LHF)')).toBe('BOOQIT1ALHF');
  });
});

describe('findNearestSku', () => {
  it('matches an exact code, case-insensitively', () => {
    const r = findNearestSku('booqit-cnr', CATALOG);
    expect(r.sku?.code).toBe('BOOQIT-CNR');
    expect(r.source).toBe('exact');
  });

  it('matches across spacing and bracket differences', () => {
    // The case that motivated the change: substantively the same code, read
    // with different punctuation, used to resolve to nothing.
    const r = findNearestSku('BOOQIT 1A (LHF)', CATALOG);
    expect(r.sku?.code).toBe('BOOQIT-1A(LHF)');
    expect(r.source).toBe('normalised');
  });

  it('completes a dropped suffix when exactly one code can follow', () => {
    const r = findNearestSku('FENRIR', CATALOG);
    expect(r.sku?.code).toBe('FENRIR-(Q)');
    expect(r.source).toBe('prefix');
  });

  it('REFUSES a prefix that two different products share', () => {
    // BOOQIT alone is 1A(LHF), 2A(RHF) and CNR — three different pieces of
    // furniture. Guessing one would put the wrong item on a sales order.
    expect(findNearestSku('BOOQIT', CATALOG).sku).toBeNull();
  });

  it('absorbs a single misread character', () => {
    const r = findNearestSku('BOOQIT-CNS', CATALOG);
    expect(r.sku?.code).toBe('BOOQIT-CNR');
    expect(r.source).toBe('distance');
  });

  it('REFUSES when two catalog codes are equally close', () => {
    // Equidistant from BOOQIT-1A(LHF) and BOOQIT-2A(RHF): the slip does not
    // say which, so neither may be chosen.
    expect(findNearestSku('BOOQITXA(XHF)', CATALOG).sku).toBeNull();
  });

  it('REFUSES a short code that is merely close', () => {
    // Under 5 characters the distance budget is zero — "CODY" vs "CODX" is not
    // enough signal to commit to a bedframe.
    expect(findNearestSku('CODX', CATALOG).sku).toBeNull();
  });

  it('returns nothing for empty input or an empty catalog', () => {
    expect(findNearestSku('', CATALOG).sku).toBeNull();
    expect(findNearestSku('   ', CATALOG).sku).toBeNull();
    expect(findNearestSku('BOOQIT-CNR', []).sku).toBeNull();
  });

  it('refuses when the catalog itself holds the code twice', () => {
    const dup = [...CATALOG, { code: 'booqit-cnr', name: 'dup', category: 'SOFA' }];
    expect(findNearestSku('BOOQIT-CNR', dup).sku).toBeNull();
  });

  it('does not match a genuinely different product', () => {
    expect(findNearestSku('ZZTOP-9000', CATALOG).sku).toBeNull();
  });

  it('handles a long catalog code without blowing the budget', () => {
    const r = findNearestSku('2990 AKKA-FIRM MATTRESS (183X190X31CM)', CATALOG);
    expect(r.sku?.code).toBe('2990 AKKA-FIRM MATTRESS (183X190X31CM)');
    expect(r.source).toBe('exact');
  });
});
