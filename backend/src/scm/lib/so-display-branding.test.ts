/* The Branding column, pinned.

   Three surfaces render it and must agree — the SO list, Delivery Planning and
   Consignment Orders — and until 2026-08-15 they agreed only because someone
   kept three copies in step by hand, under a comment that literally said "keep
   in lock-step with the SO list". These tests are what that comment was asking
   for. */
import { describe, expect, test } from 'vitest';

import { deriveBranding } from './so-display-branding';
import { normCategory } from './so-readiness';

describe('deriveBranding', () => {
  test('a sofa and a bedframe are fixed strings, whatever the line says its brand is', () => {
    expect(deriveBranding('SOFA', null)).toBe('2990 Sofa');
    expect(deriveBranding('SOFA', 'HAPPISLEEP')).toBe('2990 Sofa');
    expect(deriveBranding('BEDFRAME', 'ANYTHING')).toBe('Bedframe');
  });

  test('a mattress shows its OWN brand', () => {
    expect(deriveBranding('MATTRESS', 'HAPPISLEEP')).toBe('HAPPISLEEP');
    expect(deriveBranding('MATTRESS', 'CARRES')).toBe('CARRES');
  });

  test('the house brand displays as "2990 Mattress", in every spelling it is stored in', () => {
    for (const stored of ['2990', "2990's", '2990s', '  2990  ', "2990'S"]) {
      expect(deriveBranding('MATTRESS', stored), `stored as ${JSON.stringify(stored)}`)
        .toBe('2990 Mattress');
    }
  });

  test('a mattress with no recorded brand is ours, not blank', () => {
    expect(deriveBranding('MATTRESS', null)).toBe('2990 Mattress');
    expect(deriveBranding('MATTRESS', '   ')).toBe('2990 Mattress');
  });

  test('a brand that merely CONTAINS 2990 is not the house brand', () => {
    expect(deriveBranding('MATTRESS', '2990 PLUS')).toBe('2990 PLUS');
    expect(deriveBranding('MATTRESS', 'NOT2990')).toBe('NOT2990');
  });

  test('everything else renders empty — the column shows a dash', () => {
    for (const cat of ['ACCESSORY', 'SERVICE', 'OTHERS']) {
      expect(deriveBranding(cat, 'HAPPISLEEP'), cat).toBe('');
    }
  });

  test('an order with no items has no category and no branding', () => {
    expect(deriveBranding(null, 'HAPPISLEEP')).toBe('');
  });
});

describe('normCategory — the shared bucket rule the three surfaces now share', () => {
  test('matches on a SUBSTRING, so real item_group text lands correctly', () => {
    expect(normCategory('BEDFRAME - DIVAN')).toBe('BEDFRAME');
    expect(normCategory('sofa set')).toBe('SOFA');
    expect(normCategory(' Mattress  ')).toBe('MATTRESS');
  });

  test('ACCESSOR is a prefix on purpose — accessory and accessories both bucket', () => {
    expect(normCategory('ACCESSORY')).toBe('ACCESSORY');
    expect(normCategory('ACCESSORIES')).toBe('ACCESSORY');
  });

  test('SERVICE is its OWN bucket, not OTHERS', () => {
    /* One of the six hand-written copies of this function — the one in
       consignment-orders.ts — omits this branch and returns OTHERS. It feeds
       `item_categories`, which nothing currently reads, so it is latent rather
       than live; this assertion is what the consolidated version has to keep. */
    expect(normCategory('SERVICE')).toBe('SERVICE');
    expect(normCategory('DELIVERY SERVICE')).toBe('SERVICE');
  });

  test('anything unrecognised, blank or null falls to OTHERS', () => {
    expect(normCategory('PILLOW')).toBe('OTHERS');
    expect(normCategory('')).toBe('OTHERS');
    expect(normCategory(null)).toBe('OTHERS');
    expect(normCategory(undefined)).toBe('OTHERS');
  });

  test('BEDFRAME is tested FIRST, so a group naming both wins for bedframe', () => {
    /* Not decoration: the branch order is the rule. A "BEDFRAME + MATTRESS SET"
       line buckets as BEDFRAME, and the Branding column therefore reads
       "Bedframe" rather than following a mattress brand. */
    expect(normCategory('BEDFRAME + MATTRESS SET')).toBe('BEDFRAME');
  });
});
