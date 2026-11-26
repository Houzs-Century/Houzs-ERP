
/** The seven documents the review workflow applies to, as the tasklist
 *  templates spell them. Kept as data so the test can PROVE the prefix rule is
 *  a superset of the exact set rather than asserting it by hand. */
export const REVIEWABLE_TITLES = [
  "Agreement / Quotation",
  "Stock Out Transfer Record",
  "Stock In Transfer Record",
  "Display Floor Plan",
  "3D Design",
  "2D Design",
  "Exchange List",
];

const REVIEWABLE_TITLE_RE =
  /^(agreement|stock\s*(out|in)\s*transfer|display\s*floor\s*plan|3d\s*design|2d\s*design|exchange\s*list)/i;

export function isReviewableTitle(title: string | null | undefined): boolean {
  return REVIEWABLE_TITLE_RE.test((title ?? "").trim());
}
