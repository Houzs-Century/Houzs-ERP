/* Does a document line and the SOURCE LINE it names describe the SAME PRODUCT?
 *
 * WHY THIS EXISTS. Site 15 of docs/bugs/0672 — the bug class
 * "key-without-identity" — is nine bind points where a line-to-line link
 * arrives as a CLIENT-SUPPLIED UUID and is written straight to the column:
 *
 *   sales_invoice_items.do_item_id            sales-invoices.ts    buildItemRow
 *   sales_invoice_items.so_item_id            sales-invoices.ts    buildItemRow
 *   purchase_invoice_items.grn_item_id        purchase-invoices.ts create + add-line
 *   grn_items.purchase_order_item_id          grns.ts              create + add-line
 *   purchase_return_items.grn_item_id         purchase-returns.ts  create + add-line
 *   delivery_return_items.do_item_id          delivery-returns.ts  create
 *   delivery_order_items.so_item_id           lib/do-item-row.ts
 *
 * Every one of those paths checks the COMPANY of the source line
 * (`assertSourceLinesInCompany`), most check the PARENT DOCUMENT's status, and
 * most cap the QUANTITY against the source line's remaining. Not one of them
 * compares the ITEM. So a line ordering product B can name a source line for
 * product A: the foreign key is valid, it does not dangle, it violates no
 * constraint, and no coverage count drops. The link is structurally perfect
 * and semantically wrong.
 *
 * THIS IS NOT HYPOTHETICAL. `probe-link-identity.mjs` run 34139187692
 * (2026-09-07 23:37 local) found 2 sales-invoice lines and 3 purchase-invoice
 * lines already in production whose link names a different product, on 5
 * separate documents, and none of the five is a positional permutation — the
 * parent is a product the document does not even order.
 *
 * WHY IT COSTS MONEY RATHER THAN TIDINESS. The quantity ledgers are addressed
 * BY THE LINK: `recomputeGrnInvoiced` writes `grn_items.invoiced_qty` by
 * `.eq('id', grn_item_id)`, `adjustGrnReturnedQty` writes `returned_qty` the
 * same way, and `recomputePoReceived` does it for the purchase order. A wrong
 * link therefore does not merely mislabel one row — it draws down the WRONG
 * source line's remaining quantity, so the right one stays open and can be
 * billed or received a second time. On the sales side the same link is what
 * `doLineRemaining` sums to decide how much of a delivery is still
 * invoiceable.
 *
 * THE REFUSAL IS THE POINT, AND IT IS THE STANDING DEFAULT. When identity
 * cannot be established this module refuses and says why; it never guesses a
 * different source line and never silently drops the link. A missing link is a
 * coverage gap someone can see and repair; a wrong link lights the wrong stock
 * and nothing downstream can tell. `migration-copy-never-compute` is the same
 * rule one layer out.
 *
 * The rule matches `soLinkItemMismatch` (lib/so-link-item-identity.ts) exactly
 * — same normalisation, same "an unresolvable source is refused" stance — and
 * that file's five PO call sites are the precedent this one generalises. Kept
 * as a separate module rather than folded into it because that one's shape is
 * the PO create path's `items[]`/`soRows[]` pair and has its own 11-assertion
 * behavioural test; this one is addressed by table and link column.
 */

/** Trim, upper-case, collapse inner whitespace — the way a person reads a code.
 *  Identical to `soLinkItemMismatch`'s `norm` and to `normItemCode` in
 *  scripts/lib/ac-po-line.mjs, so the rule means ONE thing system-wide.
 *  Anything looser hides a real mismatch; anything stricter reports formatting
 *  as a wrong product. */
export const normLinkItemCode = (v: unknown) =>
  String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** One line's claim: "I am for `itemCode`, and my source is the line `linkId`". */
export type LineLinkClaim = { linkId: string; itemCode: unknown };

export type LineLinkMismatch = {
  error: 'link_material_mismatch';
  reason: string;
  linkId: string;
  itemCode: string | null;
  sourceItemCode: string | null;
};

/** What the caller must do. `unreadable` is deliberately NOT a pass — see below. */
export type LineLinkCheck =
  | { ok: true }
  | { ok: false; status: 409; body: LineLinkMismatch }
  | { ok: false; status: 503; body: { error: 'link_identity_unavailable'; reason: string } };

/**
 * The FIRST claim whose source line names a different product, or null when
 * every claim agrees with its source.
 *
 * A SOURCE THAT IS NOT IN THE MAP IS REFUSED, NOT SKIPPED. An id that resolved
 * to nothing cannot be asserted equal to anything, and every caller has already
 * run `assertSourceLinesInCompany` (404/409 on an id it cannot see) before this
 * runs, so a claim reaching here with no row is a genuine anomaly rather than
 * routine. The alternative — treating "not found" as "nothing to compare" — is
 * precisely the false negative docs/bugs/0672 is about: a check that answers a
 * different question and prints like a clean one.
 *
 * A BLANK CODE ON EITHER SIDE IS ALSO REFUSED, for the same reason: there is
 * nothing to assert. This mirrors `soLinkItemMismatch`, whose
 * `if (soCode && soCode === poCode) continue` falls through to the refusal on a
 * blank source code.
 */
export function lineLinkItemMismatch(
  claims: LineLinkClaim[],
  sourceItemCodeById: Map<string, string | null>,
  labels: { source: string },
): LineLinkMismatch | null {
  for (const claim of claims) {
    if (!claim.linkId) continue; // an unlinked line is not this function's business
    const sourceCode = sourceItemCodeById.get(claim.linkId);
    const src = normLinkItemCode(sourceCode);
    const mine = normLinkItemCode(claim.itemCode);
    if (src && src === mine) continue;
    const known = sourceItemCodeById.has(claim.linkId);
    return {
      error: 'link_material_mismatch',
      reason: known
        ? `This line is for ${String(claim.itemCode ?? '(no item)')}, but the ${labels.source} it is taken from is for ${sourceCode ?? '(no item)'}. Pick the matching ${labels.source}, or leave the source blank.`
        : `The ${labels.source} this line is taken from could not be read back, so it cannot be confirmed to be the same product. Pick the source line again.`,
      linkId: claim.linkId,
      itemCode: (claim.itemCode as string | undefined) ?? null,
      sourceItemCode: sourceCode ?? null,
    };
  }
  return null;
}

/**
 * Read the source lines and apply the rule. One batched `IN` read; call it
 * beside the existing `assertSourceLinesInCompany` at each bind point.
 *
 * A FAILED READ IS A 503, NEVER A PASS. If the source rows cannot be read we do
 * not know whether the link is right, and "we could not check" must not be
 * spelled the same way as "we checked and it was fine". Same stance as
 * `remainingUnavailableResponse` in lib/do-line-remaining.ts, whose header
 * records what the other choice cost.
 */
export async function assertLinkedLineItemsMatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  table: string,
  claims: Array<{ linkId: string | null | undefined; itemCode: unknown }>,
  labels: { source: string },
): Promise<LineLinkCheck> {
  const live = claims.filter((cl): cl is LineLinkClaim => typeof cl.linkId === 'string' && cl.linkId.length > 0);
  if (live.length === 0) return { ok: true };
  const ids = [...new Set(live.map((cl) => cl.linkId))];
  const { data, error } = await sb.from(table).select('id, item_code').in('id', ids);
  if (error) {
    return { ok: false, status: 503, body: { error: 'link_identity_unavailable', reason: `${table}: ${error.message}` } };
  }
  const byId = new Map<string, string | null>();
  for (const r of (data ?? []) as Array<{ id: string; item_code: string | null }>) byId.set(r.id, r.item_code);
  const mismatch = lineLinkItemMismatch(live, byId, labels);
  return mismatch ? { ok: false, status: 409, body: mismatch } : { ok: true };
}
