/* The Branding column, pinned.

   Three surfaces render it and must agree — the SO list, Delivery Planning and
   Consignment Orders — and until 2026-08-15 they agreed only because someone
   kept three copies in step by hand, under a comment that literally said "keep
   in lock-step with the SO list". These tests are what that comment was asking
   for.

   2026-08-17 — the rule itself moved to ../shared/so-branding-label.ts, which is
   MIRRORED into the frontend and enforced identical by check-shared-mirrors, so
   ConsignmentOrders.tsx no longer holds a second copy to keep in step. What
   stays here is this file's original job: pinning the label every caller of
   `deriveBranding` sees. Its own suite lives beside it in
   ../shared/so-branding-label.test.ts. */
import { describe, expect, test } from 'vitest';

import { deriveBranding } from './so-display-branding';
import { CATEGORY_SOURCES } from '../shared/so-branding-label';
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

  /* WAS: "everything else renders empty — the column shows a dash", asserting
     '' for ACCESSORY / SERVICE / OTHERS. That assertion was the bug, written
     down. Owner 2026-08-17: "如果他没有东西的话，只是 service 的话，他也会 mention
     service 的不是吗？… 所以 by right 不应该会有空的 branding 的。" */
  test('a service order says Service, an accessory order says Accessory', () => {
    expect(deriveBranding('SERVICE', null)).toBe('Service');
    expect(deriveBranding('ACCESSORY', null)).toBe('Accessory');
    expect(deriveBranding('OTHERS', null)).toBe('Other');
  });

  test('an order with no readable line says so, rather than saying nothing', () => {
    expect(deriveBranding(null, 'HAPPISLEEP')).toBe('No Items');
  });

  /* THE PROPERTY. Not "these seven cases are non-blank" — the whole point of
     the bug was a category nobody had listed. The domain is derived from
     source (CATEGORY_SOURCES: the mfg_product_category enum + its four
     migrations, and normCategory's six buckets) and crossed with every brand
     shape a line can carry.

     THIS TEST FAILED BEFORE THE FIX, which is the only reason it is worth
     having: ACCESSORY, SERVICE, OTHERS, DINING, BEDLINES, DIFFUSER, CARPET and
     the no-items case all returned ''. */
  test('PROPERTY: no category the system can produce ever renders blank', () => {
    const categories: Array<string | null | undefined> = [
      ...CATEGORY_SOURCES.productEnum,
      ...CATEGORY_SOURCES.normBuckets,
      /* item_group is free TEXT, so the raw shapes really do arrive here. */
      'BEDFRAME - DIVAN', 'sofa set', ' Mattress  ', 'ACCESSORIES', 'DELIVERY SERVICE',
      'PILLOW', 'BEDFRAME + MATTRESS SET',
      /* and the absences */
      null, undefined, '', '   ',
    ];
    const brands: Array<string | null | undefined> = [
      null, undefined, '', '   ', '2990', "2990's", '2990 PLUS', 'HAPPISLEEP', 'AKEMI',
    ];
    const blanks: string[] = [];
    for (const cat of categories) {
      for (const brand of brands) {
        const label = deriveBranding(cat, brand);
        if (typeof label !== 'string' || label.trim() === '') {
          blanks.push(`category=${JSON.stringify(cat)} branding=${JSON.stringify(brand)} -> ${JSON.stringify(label)}`);
        }
      }
    }
    expect(blanks, `${blanks.length} blank labels:\n  ${blanks.join('\n  ')}`).toEqual([]);
  });

  /* Every value the PRODUCT MASTER can hold gets a label that names it, not a
     generic bucket — the four enum members added for Houzs SKUs (DINING /
     BEDLINES / DIFFUSER / CARPET) are precisely the ones normCategory folds
     into OTHERS, and folding is what made them blank. */
  test('the four categories added after the old rule was written name themselves', () => {
    expect(deriveBranding('DINING', null)).toBe('Dining');
    expect(deriveBranding('BEDLINES', null)).toBe('Bedlines');
    expect(deriveBranding('DIFFUSER', null)).toBe('Diffuser');
    expect(deriveBranding('CARPET', null)).toBe('Carpet');
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
