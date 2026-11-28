
/** A persisted line carries a free-item marker iff variants.freeItem.campaignId is set. */
export function isFreeItemLine(variants: unknown): boolean {
  const v = variants as { freeItem?: { campaignId?: unknown } } | null;
  return Boolean(v?.freeItem && typeof v.freeItem === 'object' && v.freeItem.campaignId);
}
