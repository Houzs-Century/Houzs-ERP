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
import { clientHeaderBranding, deriveHeaderBrandingFromLines, restampHeaderBranding } from './derive-line-branding';
import soRevision from './so-revision.ts?raw';

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

/* BUG-115 (Syu, 13 Oct): HC-SO-2609-336 sells one Dunlopillo mattress and its
   header says BEDFRAME. HC-0094 (Chew, 13 Oct): a scanned order's branding
   "will pop to bedframe, accessories" instead of Akemi / Dunlopillo / Zanotti /
   My Latex, and a manual edit never fixes it. */
describe('header branding is a brand, not a category word (BUG-115, HC-0094)', () => {
  const HOUZS = { companyCode: 'HOUZS', brands: HOUZS_BRANDS };

  it('a bedframe keyed before a Dunlopillo mattress stamps DUNLOPILLO, not BEDFRAME', async () => {
    const sb = fakeSb([
      { code: 'BF1', branding: 'BEDFRAME', category: 'BEDFRAME', company_id: 1 },
      { code: 'DUN-Q', branding: 'DUNLOPILLO', category: 'MATTRESS', company_id: 1 },
    ]);
    expect(await deriveHeaderBrandingFromLines(sb, [
      { item_code: 'BF1', item_group: 'BEDFRAME', branding: null, company_id: 1 },
      { item_code: 'DUN-Q', item_group: 'MATTRESS', branding: null, company_id: 1 },
    ], 1, HOUZS)).toBe('DUNLOPILLO');
  });

  it('a bedframe with an unbranded Houzs sofa stamps the house sofa brand', async () => {
    const sb = fakeSb([
      { code: 'BF1', branding: 'BEDFRAME', category: 'BEDFRAME', company_id: 1 },
      { code: '5526-2A', branding: null, category: 'SOFA', company_id: 1 },
    ]);
    expect(await deriveHeaderBrandingFromLines(sb, [
      { item_code: 'BF1', item_group: 'BEDFRAME', branding: null, company_id: 1 },
      { item_code: '5526-2A', item_group: 'SOFA', branding: null, company_id: 1 },
    ], 1, HOUZS)).toBe('ZANOTTI');
  });

  it('a client-sent category word or placeholder is not a brand; a real brand is kept', () => {
    for (const v of ['BEDFRAME', 'Bedframe', 'Accessories', 'ACCESSORY', 'Mattress', 'SERVICE', 'OTHERS', 'NONE', '', '  ', null, undefined, 42]) {
      expect(clientHeaderBranding(v)).toBeNull();
    }
    expect(clientHeaderBranding(' DUNLOPILLO ')).toBe('DUNLOPILLO');
    expect(clientHeaderBranding('2990s Mattress')).toBe('2990s Mattress');
    expect(clientHeaderBranding('Happi.S Mattress')).toBe('Happi.S Mattress');
  });
});

/* restampHeaderBranding — the re-derive every line add / edit / delete ends in
   (free-gift-reconcile). HC-SO-2609-336's shape: header BEDFRAME, the only live
   line a Dunlopillo mattress. */
describe('restampHeaderBranding', () => {
  type Head = { branding: string | null; linked_ac_docno: string | null; project_id: number | null; fair_match: string | null; venue?: string | null; so_date?: string | null };
  type Fair = { id: number; venue: string; organizer: string | null; brand: string; startdate: string; enddate: string | null; status: string | null };
  function world(head: Head, liveDos = 0, fairs: Fair[] = []) {
    const updates: Array<Record<string, unknown>> = [];
    const products: Prod[] = [
      { code: 'BF1', branding: 'BEDFRAME', category: 'BEDFRAME', company_id: 1 },
      { code: 'DUN-Q', branding: 'DUNLOPILLO', category: 'MATTRESS', company_id: 1 },
    ];
    const lines = [{ item_code: 'DUN-Q', item_group: 'MATTRESS', branding: 'BEDFRAME', company_id: 1 }];
    const from = (table: string) => {
      let rows: Array<Record<string, unknown>> = table === 'mfg_products' ? products.slice() : [];
      let patch: Record<string, unknown> | null = null;
      const result = () => {
        if (table === 'mfg_sales_orders') {
          if (patch) { updates.push(patch); return { data: null, error: null }; }
          return { data: head, error: null };
        }
        if (table === 'delivery_orders') return { count: liveDos, error: null };
        if (table === 'sales_invoices') return { count: 0, error: null };
        if (table === 'mfg_sales_order_items') return { data: lines, error: null };
        return { data: rows, error: null };
      };
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => { patch = p; return q; },
        in: (col: string, values: readonly string[]) => { rows = rows.filter((r) => values.includes(String(r[col]))); return q; },
        eq: (col: string, v: unknown) => { if (table === 'mfg_products') rows = rows.filter((r) => r[col] === v); return q; },
        neq: () => q,
        order: () => q,
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown) => resolve(result()),
      };
      return q;
    };
    const c = {
      get: (k: string) => ({ companyId: 1, companyCode: 'HOUZS' } as Record<string, unknown>)[k],
      env: { DB: { prepare: (sql: string) => ({
        all: () => Promise.resolve({ results: HOUZS_BRANDS.map((name) => ({ name })) }),
        /* The fair reads: by id, by exact event, or by venue (the window is not modelled). */
        bind: (...v: unknown[]) => ({ all: () => Promise.resolve({ results: fairs.filter((f) =>
          sql.includes('p.id = ?') ? f.id === v[0]
            : sql.includes('p.start_date = ?') ? f.venue === v[0] && (f.organizer ?? '') === v[1] && f.startdate === v[2] && (f.enddate ?? '') === (v[3] ?? '')
            : f.venue === v[0]) }) }),
      }) } },
    };
    return {
      updates,
      run: () => restampHeaderBranding({ from } as unknown as Parameters<typeof restampHeaderBranding>[0], 'HC-SO-2609-336', c as unknown as Parameters<typeof restampHeaderBranding>[2]),
    };
  }

  it('a header left at BEDFRAME after the lines became a Dunlopillo mattress is re-derived to DUNLOPILLO', async () => {
    const w = world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: 7, fair_match: 'PICKED' });
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO' }]);
  });

  it('a fair verdict computed from the wrong brand goes back to PENDING when no fair fits yet', async () => {
    const w = world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: null, fair_match: 'UNMATCHED', venue: 'MID VALLEY', so_date: '2026-10-12' });
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO', project_id: null, fair_match: 'PENDING' }]);
  });

  /* HC-0094 (Chew, IT Hub, 2026-10-13): a manual edit must re-detect the
     project, linking an existing fair now rather than leaving it unlinked. */
  const MV = { venue: 'MID VALLEY', organizer: 'MLE', startdate: '2026-10-10', enddate: '2026-10-12', status: 'Confirmed' };
  it('an unlinked order whose brand is corrected links to the existing fair booth of that brand at once', async () => {
    const w = world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: null, fair_match: 'UNMATCHED', venue: 'MID VALLEY', so_date: '2026-10-12' }, 0,
      [{ id: 20, brand: 'AKEMI', ...MV }, { id: 21, brand: 'DUNLOPILLO', ...MV }]);
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO', project_id: 21, fair_match: 'PICKED' }]);
  });

  it('an order linked to the old brand booth moves to the new brand booth at the SAME event', async () => {
    const w = world({ branding: 'AKEMI', linked_ac_docno: null, project_id: 20, fair_match: 'PICKED', venue: 'MID VALLEY', so_date: '2026-10-12' }, 0,
      [{ id: 20, brand: 'AKEMI', ...MV }, { id: 21, brand: 'DUNLOPILLO', ...MV },
       { id: 30, brand: 'DUNLOPILLO', ...MV, organizer: 'REX' }]);
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO', project_id: 21, fair_match: 'PICKED' }]);
  });

  it('a link whose booth never matched the order brand (settled by a person) is kept', async () => {
    const w = world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: 20, fair_match: 'PICKED', venue: 'MID VALLEY', so_date: '2026-10-12' }, 0,
      [{ id: 20, brand: 'AKEMI', ...MV }, { id: 21, brand: 'DUNLOPILLO', ...MV }]);
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO' }]);
  });

  it('a no-fair order stays no-fair', async () => {
    const w = world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: null, fair_match: 'NO_FAIR', venue: 'MID VALLEY', so_date: '2026-10-12' }, 0,
      [{ id: 21, brand: 'DUNLOPILLO', ...MV }]);
    await w.run();
    expect(w.updates).toEqual([{ branding: 'DUNLOPILLO' }]);
  });

  it('leaves a migrated order, a delivered order and an already-right header alone', async () => {
    for (const w of [
      world({ branding: 'BEDFRAME', linked_ac_docno: 'SO-1', project_id: null, fair_match: null }),
      world({ branding: 'BEDFRAME', linked_ac_docno: null, project_id: null, fair_match: null }, 1),
      world({ branding: 'DUNLOPILLO', linked_ac_docno: null, project_id: null, fair_match: null }),
    ]) {
      await w.run();
      expect(w.updates).toEqual([]);
    }
  });
});

/* HC-0095 (Chew, IT Hub, 2026-10-13): "if amend the product or brand, it wont
   re-pair to the correct fair". The approved-amendment apply rewrites lines
   without the line routes' tail (reconcileFreeGiftLinesForSo), so it must call
   the re-derive itself, after the lines and before the revision bump. */
describe('an approved amendment re-derives the header brand and its fair', () => {
  it('applySoAmendment calls restampHeaderBranding after its line writes', () => {
    const body = soRevision.slice(soRevision.indexOf('export async function applySoAmendment('));
    const call = body.indexOf('await restampHeaderBranding(sb, docNo, c)');
    expect(call).toBeGreaterThan(body.indexOf('await rederiveDeliveryFee(sb, docNo, c)'));
    expect(call).toBeLessThan(body.indexOf('// (5) Bump the SO'));
  });
});
