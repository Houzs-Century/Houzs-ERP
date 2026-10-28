// ----------------------------------------------------------------------------
// Shared per-category badge swatches (HOUZS-pattern groupChip equivalent).
//
// Extracted 2026-05-27 from SoLineCard.tsx so both the SO Listing pages
// (MfgSalesOrdersList, SalesOrderDetailListing) and the line-card editor
// render the same orange/green/amber/grey pill set for item_group values.
//
// Commander reference shots (HOUZS SO Detail Listing) put a coloured pill
// under "Item Group": SOFA → orange, MATTRESS → warm amber, BEDFRAME → green,
// ACC → muted grey, OTHERS → muted grey-on-cream. Keep the swatches aligned
// with 2990's brand tokens so a token retune (e.g. festive-a → new amber)
// propagates everywhere automatically.
// ----------------------------------------------------------------------------

import type { CSSProperties, ReactNode } from 'react';
import { MFG_CATEGORY_LABELS } from '../../shared/product-categories';

export type CategoryBadgeSpec = {
  bg: string;
  fg: string;
  label: string;
};

/** Lookup table keyed by lowercase item_group. Unknown groups fall back to
 *  the OTHERS swatch via the helper below. */
/** The OTHERS swatch is always present — typed as a non-undefined fallback
 *  for the case-insensitive lookup below (the tsconfig sets
 *  `noUncheckedIndexedAccess`, so `CATEGORY_BADGE[key]` is
 *  `CategoryBadgeSpec | undefined`). Pulling OTHERS out as a named const
 *  also keeps the badge palette declared in a single place. */
const OTHERS_BADGE: CategoryBadgeSpec = {
  bg: 'rgba(34, 31, 32, 0.06)', fg: 'var(--fg-muted)', label: 'OTHERS',
};

export const CATEGORY_BADGE: Record<string, CategoryBadgeSpec> = {
  sofa:      { bg: 'rgba(166, 71, 30, 0.12)',  fg: 'var(--c-burnt)',                 label: 'SOFA' },
  /* Sofa Accessory (owner 2026-09-14) rides with the sofa, so it takes the sofa
     swatch. Without an entry it fell to OTHERS on every line card and list. */
  fabric_accessory: { bg: 'rgba(166, 71, 30, 0.12)', fg: 'var(--c-burnt)', label: MFG_CATEGORY_LABELS.FABRIC_ACCESSORY.toUpperCase() },
  bedframe:  { bg: 'rgba(47, 93, 79, 0.12)',   fg: 'var(--c-secondary-a, #2F5D4F)',  label: 'BEDFRAME' },
  mattress:  { bg: 'rgba(199, 127, 62, 0.16)', fg: 'var(--c-festive-a, #C77F3E)',    label: 'MATTRESS' },
  accessory: { bg: 'rgba(34, 31, 32, 0.10)',   fg: 'var(--fg-muted)',                label: 'ACC' },
  others:    OTHERS_BADGE,
  /* SO-SKU spec P2 — SERVICE lines (delivery fee / dispose / lift) are
     first-class SO lines now; muted slate keeps them visually quiet next to
     the goods categories. */
  service:   { bg: 'rgba(90, 96, 102, 0.12)',  fg: 'var(--fg-muted)',                label: 'SERVICE' },
};

/** Resolve a badge spec for any item_group string, case-insensitively.
 *  Returns the OTHERS swatch for unknown groups so the UI never crashes
 *  on dirty legacy data. */
export const badgeFor = (group: string | null | undefined): CategoryBadgeSpec => {
  if (!group) return OTHERS_BADGE;
  const key = group.toLowerCase();
  return CATEGORY_BADGE[key] ?? OTHERS_BADGE;
};

const PILL_STYLE_BASE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 8px',
  borderRadius: 'var(--radius-pill, 999px)',
  fontFamily: 'var(--font-button)',
  fontSize: 'var(--fs-10)',
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
};

/** Small pill rendering the item_group as a colored chip. Falls back to OTHERS
 *  for unknown / null groups. Use directly inside DataGrid accessors. */
export const ItemGroupPill = ({ group }: { group: string | null | undefined }): ReactNode => {
  const spec = badgeFor(group);
  return (
    <span style={{ ...PILL_STYLE_BASE, background: spec.bg, color: spec.fg }}>
      {spec.label}
    </span>
  );
};

/* ── Branding swatches (HOUZS pattern) ────────────────────────────────────
   Houzs paints AKEMI + ZANOTTI purple, everything else muted grey. Keep
   the swatches as a thin overlay on the 2990 token palette so the list
   reads consistently with the brand work in the SoLineCard area. */

const BRAND_BADGE_DEFAULT: CategoryBadgeSpec = {
  bg: 'rgba(34, 31, 32, 0.06)',
  fg: 'var(--fg-muted)',
  label: '',
};

const BRAND_BADGE: Record<string, CategoryBadgeSpec> = {
  AKEMI:    { bg: 'rgba(120, 81, 169, 0.14)', fg: '#5B3E99', label: 'AKEMI' },
  ZANOTTI:  { bg: 'rgba(120, 81, 169, 0.14)', fg: '#5B3E99', label: 'ZANOTTI' },
};

export const brandingFor = (brand: string | null | undefined): CategoryBadgeSpec => {
  if (!brand) return BRAND_BADGE_DEFAULT;
  const key = brand.trim().toUpperCase();
  if (BRAND_BADGE[key]) return BRAND_BADGE[key];
  return { ...BRAND_BADGE_DEFAULT, label: brand };
};

/** Branding pill — purple for AKEMI/ZANOTTI, muted grey for everything
 *  else. Returns null when branding is empty so the cell stays clean. */
export const BrandingPill = ({ branding }: { branding: string | null | undefined }): ReactNode => {
  if (!branding) return null;
  const spec = brandingFor(branding);
  return (
    <span style={{ ...PILL_STYLE_BASE, background: spec.bg, color: spec.fg }}>
      {spec.label}
    </span>
  );
};
