/* deriveHeaderBrandingFromLines — the brand a NEW sales order's header is
   stamped with at create.

   The defect this pins (measured on production 2026-09-14, backfill plan run
   34829253673): HC-SO-2609-065, -071 and -072 were created in the ERP with a
   NULL header while the SO list shows them as ZANOTTI. Their representative
   line is a sofa whose SKU carries no branding, and the create stamp read ONLY
   the SKU — while the list's label rule reads the company's house sofa brand
   for every sofa (owner 2026-08-18,「houzs sofa=zanotti」). So each new such order
   re-opened the gap the header backfill closes, and could not be found by the
   Branding filter. */
import { describe, expect, it } from 'vitest';
import { deriveHeaderBrandingFromLines } from './derive-line-branding';

type Prod = { code: string; branding: string | null; category: string | null; company_id: number };

function fakeSb(products: Prod[]) {
  const query = () => {
    let rows = products.slice();
    const q = {
      select: () => q,
      in: (col: string, values: readonly string[]) => { rows = rows.filter((r) => values.includes(String((r as Record<string, unknown>)[col]))); return q; },
      filter: () => { throw new Error('unexpected filter'); },
      eq: (col: string, v: unknown) => { rows = rows.filter((r) => (r as Record<string, unknown>)[col] === v); return q; },
      then: (resolve: (v: { data: Prod[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  };
  const sb = { from: (t: string) => { if (t !== 'mfg_products') throw new Error(t); return query(); } };
  return sb as unknown as Parameters<typeof deriveHeaderBrandingFromLines>[0];
}

const HOUZS_BRANDS = ['AKEMI', 'AKEMI C&C', 'BEDFRAME', 'Carres', 'DUNLOPILLO', 'ERGOTEX', 'MY SOFA FACTORY', 'MYLATEX', 'NONE', 'OTHERS', 'SERVICE', 'ZANOTTI'];
const B2990_BRANDS = ['2990s Mattress', '2990s Sofa', 'Accessories', 'Bedframe', 'Carres Mattress', 'Happi.S Mattress', 'Service'];

describe('deriveHeaderBrandingFromLines', () => {
  it('a Houzs sofa whose SKU has no branding is stamped with the brand the list shows (ZANOTTI), not left blank', async () => {
    const sb = fakeSb([{ code: '5526-2A', branding: null, category: 'SOFA', company_id: 1 }]);
    const brand = await deriveHeaderBrandingFromLines(sb,
      [{ item_code: '5526-2A', item_group: 'SOFA', branding: null, company_id: 1 }], 1,
      { companyCode: 'HOUZS', brands: HOUZS_BRANDS });
    expect(brand).toBe('ZANOTTI');
  });

  it('a 2990 sofa with an unbranded SKU reads 2990s Sofa', async () => {
    const sb = fakeSb([{ code: 'S1', branding: '', category: 'SOFA', company_id: 2 }]);
    expect(await deriveHeaderBrandingFromLines(sb,
      [{ item_code: 'S1', item_group: 'SOFA', branding: null, company_id: 2 }], 2,
      { companyCode: '2990', brands: B2990_BRANDS })).toBe('2990s Sofa');
  });

  it('the SKU branding still wins whenever the SKU has one — the fallback only fills a null', async () => {
    const sb = fakeSb([{ code: 'M1', branding: 'DUNLOPILLO', category: 'MATTRESS', company_id: 1 }]);
    expect(await deriveHeaderBrandingFromLines(sb,
      [{ item_code: 'M1', item_group: 'MATTRESS', branding: null, company_id: 1 }], 1,
      { companyCode: 'HOUZS', brands: HOUZS_BRANDS })).toBe('DUNLOPILLO');
  });

  it('a label that is a category noun, not a maintained brand, stays null — never guessed', async () => {
    const sb = fakeSb([{ code: 'A1', branding: null, category: 'ACCESSORY', company_id: 1 }]);
    expect(await deriveHeaderBrandingFromLines(sb,
      [{ item_code: 'A1', item_group: 'ACCESSORY', branding: null, company_id: 1 }], 1,
      { companyCode: 'HOUZS', brands: HOUZS_BRANDS })).toBeNull();
  });

  it('a bedframe-only order is written in the brand list spelling (BEDFRAME for Houzs)', async () => {
    const sb = fakeSb([{ code: 'B1', branding: null, category: 'BEDFRAME', company_id: 1 }]);
    expect(await deriveHeaderBrandingFromLines(sb,
      [{ item_code: 'B1', item_group: 'BEDFRAME', branding: null, company_id: 1 }], 1,
      { companyCode: 'HOUZS', brands: HOUZS_BRANDS })).toBe('BEDFRAME');
  });

  it('with no brand list (an unreadable pool) the old SKU-only answer stands', async () => {
    const sb = fakeSb([{ code: '5526-2A', branding: null, category: 'SOFA', company_id: 1 }]);
    expect(await deriveHeaderBrandingFromLines(sb,
      [{ item_code: '5526-2A', item_group: 'SOFA', branding: null, company_id: 1 }], 1, null)).toBeNull();
  });
});
