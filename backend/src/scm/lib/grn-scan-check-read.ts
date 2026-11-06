// ---------------------------------------------------------------------------
// grn-scan-check-read — from a delivery order as read to the working copy of the
// check step: match it, mark taught free gifts, and fill what a person can then
// confirm. Shared by the scan pipeline and the upgrade of copies written before
// a change to what a copy holds (REVIEW_VERSION).
// ---------------------------------------------------------------------------

import type { SupabaseClient as SupabaseClientGeneric } from '@supabase/supabase-js';
import { buildReview, type GrnReview } from './grn-scan-check';
import { loadScanCodes } from './grn-scan-codes';
import { buildNeedsReviewNote, matchScan } from './grn-scan-draft';
import type { GrnExtracted } from './grn-scan-extract';
import { emptyScanNote } from './grn-scan-extract';
import { giftLines, loadCatalogueProducts } from './grn-scan-gifts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped service client every scm route uses
type SupabaseClient = SupabaseClientGeneric<any, any, any>;

export async function reviewOfRead(svc: SupabaseClient, companyId: number | null, parsed: GrnExtracted | null, scanDate: string): Promise<{ review: GrnReview; note: string | null }> {
  if (!parsed || parsed.lines.length === 0) return { review: buildReview(parsed, null, null, [], [], scanDate), note: emptyScanNote(parsed) };
  const ctx = await matchScan(svc, companyId, parsed);
  const taught = ctx.supplierId ? await loadScanCodes(svc, companyId, ctx.supplierId) : [];
  const products = await loadCatalogueProducts(svc, companyId, taught.map((t) => t.itemCode));
  const gifts = giftLines(ctx.match, taught, products);
  const review = buildReview(parsed, ctx.supplierId, ctx.match, gifts, ctx.openLines.filter((l) => l.supplierId === ctx.supplierId), scanDate);
  // Every row placed: the matcher's complaint is no longer the operator's problem.
  const placed = review.lines.length > 0 && review.lines.every((l) => l.poItemId || l.gift);
  return { review, note: placed || ctx.match.picks.length > 0 ? null : ctx.otherCompany ?? buildNeedsReviewNote(parsed, ctx.match, ctx.allPos, ctx.supplierId) };
}
