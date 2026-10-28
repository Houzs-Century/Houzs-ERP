// Vendored SLICE of packages/shared/src/free-item-campaign.ts — only the one
// pure predicate variant-summary.ts needs (`isFreeItemLine`). The full module
// also exports parseFreeItemEligible / campaignsCoveringLine, which pull in
// ./sofa-combo-pricing + ./sofa-build (a large pricing tail the PO pages don't
// touch). Those are intentionally NOT vendored here; isFreeItemLine has no
// dependency on them and is copied verbatim. Extend this file if a later page
// needs the campaign matcher.

/** A persisted line carries a free-item marker iff variants.freeItem.campaignId is set. */
export function isFreeItemLine(variants: unknown): boolean {
  const v = variants as { freeItem?: { campaignId?: unknown } } | null;
  return Boolean(v?.freeItem && typeof v.freeItem === 'object' && v.freeItem.campaignId);
}
