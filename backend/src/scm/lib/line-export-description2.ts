// ----------------------------------------------------------------------------
// line-export-description2 — what a list export prints as "Detail Description 2"
// for a Goods Received, Purchase Invoice or Sales Invoice line.
//
// OWNER RULING 2026-09-15: composed from the line's variants
// (buildVariantSummary); the stored description2 only when the variants produce
// nothing. NOT composeDescription2 (services/autocount-writeback.ts), where the
// stored text wins.
//
// MEASURED the same day against AutoCount's Detail Listing (run 34947063972):
// the stored text equals the book's Desc2 on about 77% of paired GR / PI lines
// and the variant summary on 16-25%, because the book holds the free text the
// cutover copied into description2. Reported to the owner; if he reverses the
// order, this is the one line to change.
// ----------------------------------------------------------------------------

import { buildVariantSummary } from '../shared/variant-summary';

export function lineExportDescription2(
  itemGroup: string | null | undefined,
  variants: unknown,
  stored: string | null | undefined,
): string | null {
  const v = typeof variants === 'string' ? safeParse(variants) : variants;
  const composed = buildVariantSummary(itemGroup, v && typeof v === 'object' ? (v as Record<string, unknown>) : null).trim();
  if (composed) return composed;
  const s = (stored ?? '').trim();
  return s === '' ? null : s;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
