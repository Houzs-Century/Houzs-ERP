/* deriveListFirstItemBranding was lifted out of the GET /mfg-sales-orders list
   handler on 2026-09-14. The ORACLE below is that handler's inline code as it
   stood at 09fb2faaa (src/scm/routes/mfg-sales-orders.ts, the firstCat / repCat
   / isBedframeOnly block), kept verbatim in shape so the lift is proven
   behaviour-preserving over a generated population rather than by reading. */
import { describe, expect, it } from 'vitest';
import { deriveListFirstItemBranding, type ListBrandingLine } from './so-list-first-item-branding';
import { normCategory } from './so-readiness';

function oracle(
  itemRows: ListBrandingLine[],
  productCategory: Map<string, string>,
  productBranding: Map<string, string>,
  docNos: string[],
) {
  const firstCat = new Map<string, string>();
  const firstBranding = new Map<string, string | null>();
  const firstItemCode = new Map<string, string | null>();
  for (const it of itemRows) {
    if (!firstCat.has(it.doc_no)) {
      firstCat.set(it.doc_no, normCategory(it.item_group));
      firstBranding.set(it.doc_no, it.branding ?? null);
      firstItemCode.set(it.doc_no, it.item_code ?? null);
    }
  }
  const resolveLineCat = (code: string | null, group: string | null): string =>
    (code ? productCategory.get(code) : undefined) ?? normCategory(group);
  const MAIN_CATS = new Set(['SOFA', 'BEDFRAME', 'MATTRESS']);
  const repCat = new Map<string, string>();
  const repBranding = new Map<string, string | null>();
  const repCode = new Map<string, string | null>();
  for (const it of itemRows) {
    if (repCat.has(it.doc_no)) continue;
    const cat = resolveLineCat(it.item_code, it.item_group);
    if (MAIN_CATS.has(cat)) {
      repCat.set(it.doc_no, cat);
      repBranding.set(it.doc_no, it.branding ?? null);
      repCode.set(it.doc_no, it.item_code ?? null);
    }
  }
  const resolvedCatsByDoc = new Map<string, Set<string>>();
  for (const it of itemRows) {
    let s = resolvedCatsByDoc.get(it.doc_no);
    if (!s) { s = new Set(); resolvedCatsByDoc.set(it.doc_no, s); }
    s.add(resolveLineCat(it.item_code, it.item_group));
  }
  const isBedframeOnly = (docNo: string): boolean => {
    const s = resolvedCatsByDoc.get(docNo);
    return !!s && s.has('BEDFRAME') && !s.has('MATTRESS') && !s.has('SOFA');
  };
  const out = new Map<string, { category: string | null; branding: string | null }>();
  for (const docNo of docNos) {
    const hasRep = repCat.has(docNo);
    const fCat = (hasRep ? repCat.get(docNo) : firstCat.get(docNo)) ?? null;
    let fBranding = (hasRep ? repBranding.get(docNo) : firstBranding.get(docNo)) ?? null;
    if (fCat === 'MATTRESS') {
      const code = hasRep ? repCode.get(docNo) : firstItemCode.get(docNo);
      const skuBrand = code ? productBranding.get(code) : undefined;
      if (skuBrand && skuBrand.trim()) fBranding = skuBrand;
    }
    if ((!fBranding || !fBranding.trim()) && isBedframeOnly(docNo)) fBranding = 'BEDFRAME';
    out.set(docNo, { category: fCat, branding: fBranding });
  }
  return out;
}

/* Deterministic PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

describe('deriveListFirstItemBranding — the list handler rule, lifted', () => {
  it('agrees with the handler inline code on 3,000 generated orders', () => {
    const r = rng(20260914);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    const groups = ['SOFA', 'BEDFRAME - DIVAN', 'MATTRESS', 'accessories', 'SERVICE', 'others', 'DINING', '', null];
    const brands = ['ZANOTTI', 'AKEMI', 'DUNLOPILLO', '', '   ', null, '2990s Mattress'];
    const productCategory = new Map<string, string>();
    const productBranding = new Map<string, string>();
    const codes = Array.from({ length: 60 }, (_, i) => `SKU-${i}`);
    for (const code of codes) {
      if (r() < 0.8) productCategory.set(code, normCategory(pick(['SOFA', 'BEDFRAME', 'MATTRESS', 'ACCESSORY', 'SERVICE', 'CARPET'])));
      const b = pick(brands);
      if (b && b.trim()) productBranding.set(code, b);
    }
    const lines: ListBrandingLine[] = [];
    const docNos: string[] = [];
    for (let d = 0; d < 3000; d++) {
      const doc = `SO-${String(d).padStart(5, '0')}`;
      docNos.push(doc);
      const n = Math.floor(r() * 5); // 0..4 lines; 0 = no readable line
      for (let k = 0; k < n; k++) {
        lines.push({
          doc_no: doc,
          item_group: pick(groups),
          branding: pick(brands),
          item_code: r() < 0.1 ? null : pick([...codes, 'UNKNOWN-SKU']),
        });
      }
    }
    const got = deriveListFirstItemBranding(lines, productCategory, productBranding);
    const want = oracle(lines, productCategory, productBranding, docNos);
    for (const doc of docNos) {
      const w = want.get(doc)!;
      const g = got.get(doc) ?? { category: null, branding: null };
      expect(g, doc).toEqual(w);
    }
  });

  it('a bedframe-only order with no brand text reads BEDFRAME; a sofa line beside it does not', () => {
    const cat = new Map([['BF', 'BEDFRAME'], ['SF', 'SOFA'], ['ACC', 'ACCESSORY']]);
    const out = deriveListFirstItemBranding([
      { doc_no: 'A', item_group: 'others', branding: null, item_code: 'ACC' },
      { doc_no: 'A', item_group: 'BEDFRAME', branding: null, item_code: 'BF' },
      { doc_no: 'B', item_group: 'BEDFRAME', branding: null, item_code: 'BF' },
      { doc_no: 'B', item_group: 'SOFA', branding: null, item_code: 'SF' },
    ], cat, new Map());
    expect(out.get('A')).toEqual({ category: 'BEDFRAME', branding: 'BEDFRAME' });
    expect(out.get('B')).toEqual({ category: 'BEDFRAME', branding: null });
  });

  it('a doc with no line is absent, so the label rule prints No Items for it', () => {
    expect(deriveListFirstItemBranding([], new Map(), new Map()).has('X')).toBe(false);
  });
});
