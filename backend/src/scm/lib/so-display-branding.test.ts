import { describe, expect, test } from 'vitest';

import { deriveBranding } from './so-display-branding';
import { CATEGORY_SOURCES } from '../shared/so-branding-label';
import { normCategory } from './so-readiness';

describe('deriveBranding', () => {
  test('a sofa and a bedframe are fixed strings, whatever the line says its brand is', () => {
    expect(deriveBranding('SOFA', null)).toBe('2990s Sofa');
    expect(deriveBranding('SOFA', 'HAPPISLEEP')).toBe('2990s Sofa');
    expect(deriveBranding('BEDFRAME', 'ANYTHING')).toBe('Bedframe');
  });

  test('a mattress shows the brand it was handed — its SKU\'s', () => {
    expect(deriveBranding('MATTRESS', 'Happi.S Mattress')).toBe('Happi.S Mattress');
    expect(deriveBranding('MATTRESS', 'Carres Mattress')).toBe('Carres Mattress');
    expect(deriveBranding('MATTRESS', '2990s Mattress')).toBe('2990s Mattress');
  });

  test('a mattress whose SKU carries no brand names the category (owner 2026-08-18)', () => {
    expect(deriveBranding('MATTRESS', null)).toBe('Mattress');
    expect(deriveBranding('MATTRESS', '   ')).toBe('Mattress');
    expect(deriveBranding('MATTRESS', null)).not.toBe('2990 Mattress');
  });

  test('a stored brand passes through verbatim — there is no normalisation table', () => {
    for (const stored of ['2990 PLUS', 'NOT2990', '2990', '2990s']) {
      expect(deriveBranding('MATTRESS', stored), `stored as ${JSON.stringify(stored)}`)
        .toBe(stored);
    }
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

  test('PROPERTY: no category the system can produce ever renders blank', () => {
    const categories: Array<string | null | undefined> = [
      ...CATEGORY_SOURCES.categoryNouns,
      'FABRIC_ACCESSORY', 'NEW_GROUP',
      ...CATEGORY_SOURCES.normBuckets,
      'BEDFRAME - DIVAN', 'sofa set', ' Mattress  ', 'ACCESSORIES', 'DELIVERY SERVICE',
      'PILLOW', 'BEDFRAME + MATTRESS SET',
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
    expect(normCategory('BEDFRAME + MATTRESS SET')).toBe('BEDFRAME');
  });
});
