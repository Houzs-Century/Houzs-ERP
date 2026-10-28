// ----------------------------------------------------------------------------
// brand-letterhead — which BRAND logo a document PDF prints IN PLACE OF the
// company letterhead.
//
// THE DEFECT THIS FILE EXISTS TO CLOSE (owner, 2026-08-21, found on a real
// PDF). A Sales Order headed "2990 HOME SDN. BHD." (SSM 202501060667, doc
// 2990-SO-2607-026, DELIVERED) printed the ZANOTTI logo. Zanotti is HOUZS's
// house sofa brand. Two independent causes, in the block this replaces
// (scm/routes/mfg-sales-orders.ts:2755-2793):
//
//   1. the brand pool was read with NO company predicate
//      (`SELECT name, logo_r2_key FROM project_brands WHERE active = 1`), and
//   2. the SOFA branch hardcoded the NAME 'ZANOTTI' for every company.
//
// Either one alone reproduces it, so both are fixed and both are pinned by a
// test. The rule was never in doubt: the owner wrote it on 2026-08-18 and
// shared/so-branding-label.ts has implemented it for the grid LABEL ever since
// — SOFA resolves the COMPANY's house sofa brand, and the line's own text is
// not consulted. The PDF LOGO is a separate code path that only ever
// implemented the Houzs half.
//
// WHAT PRODUCTION SAID before this was written (read-only run 32455140536,
// 2026-08-21) — the fix is shaped by these, not by two remembered names:
//   · 69 existing 2990 sales orders resolve Houzs's Zanotti logo today.
//     They are not a backfill: a PDF is generated on demand, so a code fix
//     corrects future prints of past documents too.
//   · "2990s Sofa" ALREADY EXISTS as a 2990 brand row (id=33, active) and has
//     NO logo_r2_key. Five of the table's 19 rows carry a logo and all five
//     are HOUZS's. So the right answer for 2990 today is the COMPANY
//     letterhead — the fail-soft path below — and NOT a logo invented to fill
//     the gap. Evidence is not a setting; the missing row IS the finding.
//   · project_brands.company_id has existed since migration 0093 and the
//     baseline's global UNIQUE(name) is NOT in production, so the scoping
//     needs no schema change — only a predicate and this rule.
//
// FAIL-SOFT IS A PROPERTY, NOT AN ACCIDENT. Every path here returns null
// rather than throwing, and null means "keep the company letterhead". A PDF
// must never fail because of a logo.
// ----------------------------------------------------------------------------
import { houseSofaBrandName } from '../shared/so-branding-label';

/** One row from public.project_brands, as the pg driver hands it back. */
export type BrandRow = Record<string, unknown>;

/** A brand name paired with its logo key, after normalisation. */
export interface NormalisedBrand {
  name: string;
  logoKey: string | null;
}

/**
 * Normalise raw project_brands rows.
 *
 * Dual-read logoR2Key ?? logo_r2_key — the pg driver camelCases result columns
 * (#1 recurring bug in this repo).
 */
export function normaliseBrandRows(rows: readonly BrandRow[]): NormalisedBrand[] {
  return rows
    .map((r) => ({
      name: String(r.name ?? '').trim(),
      logoKey: (() => {
        const v = (r.logoR2Key ?? r.logo_r2_key) as string | null | undefined;
        const s = typeof v === 'string' ? v.trim() : '';
        return s || null;
      })(),
    }))
    .filter((b) => b.name);
}

export interface BrandLetterheadInput {
  /** The active company's brand pool. MUST be read with a company predicate;
   *  the sofa rule below refuses to leak even if it is not. */
  brands: readonly BrandRow[];
  /** Every line's item_group, in the document's display order. */
  itemGroups: ReadonlyArray<string | null | undefined>;
  /** The FIRST displayed line's description. */
  firstDescription: string | null | undefined;
  /** The document's owning company code ('HOUZS' / '2990'). */
  companyCode: string | null | undefined;
}

/**
 * Resolve the brand logo R2 key for a document, or null to keep the company
 * letterhead.
 *
 * NEVER THROWS. A PDF must never fail because of a logo.
 */
export function resolveBrandLetterheadKey(input: BrandLetterheadInput): string | null {
  const brands = normaliseBrandRows(input.brands ?? []);

  const hasSofa = (input.itemGroups ?? []).some((g) =>
    String(g ?? '').toUpperCase().includes('SOFA'),
  );
  if (hasSofa) {
    /* THE COMPANY's house sofa brand, from the owner's own 2026-08-18 rule —
       never the literal 'ZANOTTI', which is one company's answer to it. An
       unidentifiable company yields null and falls through to the prefix match
       below, exactly as a sofa order with no house-brand logo already did. */
    const houseName = houseSofaBrandName(input.companyCode);
    if (houseName) {
      const wanted = houseName.toUpperCase();
      const house = brands.find((b) => b.name.toUpperCase() === wanted && b.logoKey);
      if (house) return house.logoKey;
    }
  }

  const firstDesc = String(input.firstDescription ?? '').trim().toUpperCase();
  if (firstDesc) {
    let best: NormalisedBrand | null = null;
    for (const b of brands) {
      if (!firstDesc.startsWith(b.name.toUpperCase())) continue;
      if (!best || b.name.length > best.name.length) best = b;
    }
    return best?.logoKey ?? null;
  }
  return null;
}
