/* check- / repair-so-header-branding.mjs judge old headers through
   scripts/lib/so-header-branding-drift.mjs. These cases run through BOTH that
   classifier and the app's deriveHeaderBrandingFromLines, so the scripts cannot
   call a header wrong that the app would stamp, or the reverse. */
import { describe, expect, it } from 'vitest';
import { deriveHeaderBrandingFromLines } from '../src/scm/lib/derive-line-branding';
// @ts-expect-error -- plain .mjs, no types
import { classifyHeaderBranding, pairCounts } from '../scripts/lib/so-header-branding-drift.mjs';

type Prod = { code: string; branding: string | null; category: string | null };
type Line = { item_code: string | null; item_group: string | null; branding: string | null };

const PRODUCTS: Prod[] = [
  { code: 'BF1', branding: 'BEDFRAME', category: 'BEDFRAME' },
  { code: 'DUN-Q', branding: 'DUNLOPILLO', category: 'MATTRESS' },
  { code: '5526-2A', branding: null, category: 'SOFA' },
  { code: 'A1', branding: null, category: 'ACCESSORY' },
];
const HOUZS = { companyCode: 'HOUZS', brands: ['AKEMI', 'BEDFRAME', 'DUNLOPILLO', 'NONE', 'OTHERS', 'SERVICE', 'ZANOTTI'] };

function fakeSb(products: Prod[]) {
  const query = () => {
    let rows = products.slice();
    const q = {
      select: () => q,
      in: (col: string, values: readonly string[]) => { rows = rows.filter((r) => values.includes(String((r as Record<string, unknown>)[col]))); return q; },
      eq: () => q,
      then: (resolve: (v: { data: Prod[]; error: null }) => unknown) => resolve({ data: rows, error: null }),
    };
    return q;
  };
  return { from: () => query() } as unknown as Parameters<typeof deriveHeaderBrandingFromLines>[0];
}

const CASES: Array<{ name: string; lines: Line[]; want: string | null }> = [
  { name: 'HC-SO-2609-336: one Dunlopillo mattress', lines: [{ item_code: 'DUN-Q', item_group: 'MATTRESS', branding: 'BEDFRAME' }], want: 'DUNLOPILLO' },
  { name: 'bedframe keyed before the mattress', lines: [{ item_code: 'BF1', item_group: 'BEDFRAME', branding: null }, { item_code: 'DUN-Q', item_group: 'MATTRESS', branding: null }], want: 'DUNLOPILLO' },
  { name: 'bedframe-only stays BEDFRAME', lines: [{ item_code: 'BF1', item_group: 'BEDFRAME', branding: null }], want: 'BEDFRAME' },
  { name: 'unbranded sofa -> house brand', lines: [{ item_code: 'BF1', item_group: 'BEDFRAME', branding: null }, { item_code: '5526-2A', item_group: 'SOFA', branding: null }], want: 'ZANOTTI' },
  { name: 'accessory only -> nothing', lines: [{ item_code: 'A1', item_group: 'ACCESSORY', branding: null }], want: null },
  { name: 'no lines -> nothing', lines: [], want: null },
  { name: 'unknown code -> nothing', lines: [{ item_code: 'ZZZ', item_group: null, branding: null }], want: null },
];

const head = (doc_no: string, branding: string | null, extra: Record<string, unknown> = {}) => ({
  doc_no, branding, status: 'CONFIRMED', linked_ac_docno: null, project_id: null, fair_match: null, so_date: '2026-09-30', ...extra,
});

describe('so-header-branding-drift agrees with deriveHeaderBrandingFromLines', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const app = await deriveHeaderBrandingFromLines(fakeSb(PRODUCTS), c.lines.map((l) => ({ ...l, company_id: 1 })), 1, HOUZS);
      expect(app).toBe(c.want);
      const r = classifyHeaderBranding({
        heads: [head('D', 'STALE')], lines: c.lines.map((l) => ({ ...l, doc_no: 'D' })),
        products: PRODUCTS, listFallback: HOUZS, downstream: new Set(),
      });
      expect(r.affected.map((h: { derived: string }) => h.derived)).toEqual(app ? [app] : []);
    });
  }
});

describe('classifyHeaderBranding applies restampHeaderBranding skips', () => {
  const mattress = (doc_no: string) => ({ doc_no, item_code: 'DUN-Q', item_group: 'MATTRESS', branding: null });
  const run = () => classifyHeaderBranding({
    heads: [
      head('OK', 'DUNLOPILLO'),
      head('FIX', 'BEDFRAME', { fair_match: 'UNMATCHED' }),
      head('FIX-LINKED-FAIR', 'BEDFRAME', { project_id: 7, fair_match: 'UNMATCHED' }),
      head('MIG', 'BEDFRAME', { linked_ac_docno: 'SO-1' }),
      head('SHIPPED', 'BEDFRAME'),
      head('GONE', 'BEDFRAME', { status: 'CANCELLED' }),
    ],
    lines: ['OK', 'FIX', 'FIX-LINKED-FAIR', 'MIG', 'SHIPPED', 'GONE'].map(mattress),
    products: PRODUCTS, listFallback: HOUZS, downstream: new Set(['SHIPPED']),
  });

  it('lists only non-migrated, non-cancelled, downstream-free drift, with the fair re-pend rule', () => {
    const r = run();
    expect(r.affected.map((h: { doc_no: string; repend: boolean }) => [h.doc_no, h.repend])).toEqual([['FIX', true], ['FIX-LINKED-FAIR', false]]);
    expect(r.skippedMigrated.map((h: { doc_no: string }) => h.doc_no)).toEqual(['MIG']);
    expect(r.skippedDownstream.map((h: { doc_no: string }) => h.doc_no)).toEqual(['SHIPPED']);
    expect(pairCounts(r.affected)).toEqual([['"BEDFRAME" -> "DUNLOPILLO"', 2]]);
  });
});
