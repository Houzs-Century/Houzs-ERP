import { describe, it, expect } from 'vitest';
import { findNearestSku, normaliseSkuCode } from './sku-nearest-match';

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
    expect(findNearestSku('BOOQIT', CATALOG).sku).toBeNull();
  });

  it('absorbs a single misread character', () => {
    const r = findNearestSku('BOOQIT-CNS', CATALOG);
    expect(r.sku?.code).toBe('BOOQIT-CNR');
    expect(r.source).toBe('distance');
  });

  it('REFUSES when two catalog codes are equally close', () => {
    expect(findNearestSku('BOOQITXA(XHF)', CATALOG).sku).toBeNull();
  });

  it('REFUSES a short code that is merely close', () => {
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
