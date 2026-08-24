// ----------------------------------------------------------------------------
// brand-letterhead.test — the SO PDF's brand letterhead is the COMPANY's, and
// a document may never print another company's mark.
//
// THE DEFECT THIS PINS (owner, 2026-08-21, found on a real PDF). A Sales Order
// headed "2990 HOME SDN. BHD." (SSM 202501060667, doc 2990-SO-2607-026) printed
// the ZANOTTI logo. Zanotti is Houzs's house sofa brand. The rule that says so
// is the owner's own, dated 2026-08-18 and already implemented in
// shared/so-branding-label.ts for the grid LABEL:
//
//     SOFA -> the COMPANY's house sofa brand ("ZANOTTI" for Houzs,
//     "2990s Sofa" for 2990 - the line's own text is not consulted)
//
// The PDF LOGO is a separate code path and never implemented the company half:
// it hardcoded the name 'ZANOTTI' and read the brand pool with no company
// predicate. Production (run 32455140536, 2026-08-21) counted 69 existing 2990
// sales orders that resolve Houzs's Zanotti logo today.
//
// PRODUCTION FACTS these fixtures are built from, so the tests are about the
// real table and not two remembered names (same run):
//   · project_brands holds 19 rows - 12 HOUZS, 7 2990.
//   · FIVE rows carry a logo_r2_key, and ALL FIVE are HOUZS's: AKEMI,
//     DUNLOPILLO, ERGOTEX, MYLATEX, ZANOTTI.
//   · "2990s Sofa" EXISTS (id=33, company 2990, active) and has NO logo. So the
//     correct outcome for a 2990 sofa order is the COMPANY letterhead - the
//     fail-soft path that already exists. Nothing is invented to fill the gap.
// ----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import { resolveBrandLetterheadKey, normaliseBrandRows } from './brand-letterhead';

/** HOUZS's pool, exactly the five logo-bearing rows production has. */
const HOUZS_BRANDS = [
  { name: 'AKEMI', logo_r2_key: 'brands/logo-1-1783145526979.jpg' },
  { name: 'AKEMI C&C', logo_r2_key: null },
  { name: 'BEDFRAME', logo_r2_key: null },
  { name: 'Carres', logo_r2_key: null },
  { name: 'DUNLOPILLO', logo_r2_key: 'brands/logo-3-1783145521973.png' },
  { name: 'ERGOTEX', logo_r2_key: 'brands/logo-4-1783145530353.png' },
  { name: 'MY SOFA FACTORY', logo_r2_key: null },
  { name: 'MYLATEX', logo_r2_key: 'brands/logo-32-1783145538674.png' },
  { name: 'NONE', logo_r2_key: null },
  { name: 'OTHERS', logo_r2_key: null },
  { name: 'SERVICE', logo_r2_key: null },
  { name: 'ZANOTTI', logo_r2_key: 'brands/logo-2-1783145516704.png' },
];

/** 2990's pool. Seven rows, not one of them with a logo. */
const B2990_BRANDS = [
  { name: '2990s Mattress', logo_r2_key: null },
  { name: '2990s Sofa', logo_r2_key: null },
  { name: 'Accessories', logo_r2_key: null },
  { name: 'Bedframe', logo_r2_key: null },
  { name: 'Carres Mattress', logo_r2_key: null },
  { name: 'Happi.S Mattress', logo_r2_key: null },
  { name: 'Service', logo_r2_key: null },
];

describe('brand letterhead — the company half of the owner 2026-08-18 sofa rule', () => {
  it('a 2990 SOFA order does NOT print Houzs’s Zanotti logo (the reported defect)', () => {
    /* The exact shape of 2990-SO-2607-026: a 2990 order with sofa lines. The
       brand pool handed in is 2990's own, which is what a company-scoped read
       returns. "2990s Sofa" carries no logo, so the ONLY correct answer is
       null -> the 2990 HOME SDN. BHD. company letterhead. */
    expect(
      resolveBrandLetterheadKey({
        brands: B2990_BRANDS,
        itemGroups: ['SOFA', 'SOFA', 'SERVICE'],
        firstDescription: 'HAVANA 3 SEATER',
        companyCode: '2990',
      }),
    ).toBeNull();
  });

  it('a 2990 SOFA order still refuses Zanotti even if the pool leaks Houzs rows', () => {
    /* DEFENCE IN DEPTH, and the half that catches a regression in the READ.
       Scoping the SQL and resolving the company's own brand are two separate
       fixes; if the predicate is ever dropped again the rule must still not
       hand 2990 a Houzs mark. The pool here is deliberately BOTH companies'. */
    expect(
      resolveBrandLetterheadKey({
        brands: [...B2990_BRANDS, ...HOUZS_BRANDS],
        itemGroups: ['SOFA'],
        firstDescription: 'HAVANA 3 SEATER',
        companyCode: '2990',
      }),
    ).toBeNull();
  });

  it('a HOUZS sofa order keeps Zanotti — the rule’s other half must not regress', () => {
    expect(
      resolveBrandLetterheadKey({
        brands: HOUZS_BRANDS,
        itemGroups: ['SOFA'],
        firstDescription: 'ZANOTTI 5526 3 SEATER',
        companyCode: 'HOUZS',
      }),
    ).toBe('brands/logo-2-1783145516704.png');
  });

  it('2990 WOULD print its own sofa brand the day that row gets a logo', () => {
    /* The fix must resolve the company's house brand, not merely suppress
       Zanotti. Evidence is not a setting: no row was inserted in production to
       make this pass - the fixture states what happens IF the owner uploads a
       logo for the row that already exists. */
    expect(
      resolveBrandLetterheadKey({
        brands: B2990_BRANDS.map((b) =>
          b.name === '2990s Sofa' ? { ...b, logo_r2_key: 'brands/logo-33-x.png' } : b,
        ),
        itemGroups: ['SOFA'],
        firstDescription: 'HAVANA 3 SEATER',
        companyCode: '2990',
      }),
    ).toBe('brands/logo-33-x.png');
  });

  it('an unresolved company code does not fall through to Zanotti', () => {
    /* activeCompanySql degrades to NO predicate on a genuinely unresolved
       (legacy / single-company) context, so the pool can be the whole table.
       The sofa branch must not stamp a house brand it cannot attribute. */
    expect(
      resolveBrandLetterheadKey({
        brands: [...B2990_BRANDS, ...HOUZS_BRANDS],
        itemGroups: ['SOFA'],
        firstDescription: 'HAVANA 3 SEATER',
        companyCode: null,
      }),
    ).toBeNull();
  });
});

describe('brand letterhead — behaviour carried over unchanged', () => {
  it('a non-sofa order matches the LONGEST brand-name prefix of the first line', () => {
    expect(
      resolveBrandLetterheadKey({
        brands: HOUZS_BRANDS,
        itemGroups: ['MATTRESS'],
        firstDescription: 'AKEMI C&C SUPERIOR 6FT',
        companyCode: 'HOUZS',
      }),
    ).toBeNull(); // 'AKEMI C&C' wins on length and carries NO logo
  });

  it('falls back to the shorter prefix only when it is the longest MATCH', () => {
    expect(
      resolveBrandLetterheadKey({
        brands: HOUZS_BRANDS,
        itemGroups: ['MATTRESS'],
        firstDescription: 'AKEMI SUPERIOR 6FT',
        companyCode: 'HOUZS',
      }),
    ).toBe('brands/logo-1-1783145526979.jpg');
  });

  it('no match, no description and an empty pool all keep the company letterhead', () => {
    const common = { itemGroups: ['MATTRESS'], companyCode: 'HOUZS' } as const;
    expect(resolveBrandLetterheadKey({ ...common, brands: HOUZS_BRANDS, firstDescription: 'NO SUCH BRAND 6FT' })).toBeNull();
    expect(resolveBrandLetterheadKey({ ...common, brands: HOUZS_BRANDS, firstDescription: '' })).toBeNull();
    expect(resolveBrandLetterheadKey({ ...common, brands: [], firstDescription: 'AKEMI SUPERIOR' })).toBeNull();
  });

  it('reads the pg driver’s camelCased column as well as the snake_case one', () => {
    expect(normaliseBrandRows([{ name: ' ZANOTTI ', logoR2Key: ' k.png ' }])).toEqual([
      { name: 'ZANOTTI', logoKey: 'k.png' },
    ]);
    expect(normaliseBrandRows([{ name: 'X', logo_r2_key: '   ' }])).toEqual([{ name: 'X', logoKey: null }]);
    expect(normaliseBrandRows([{ name: '   ', logo_r2_key: 'k' }])).toEqual([]);
  });
});
