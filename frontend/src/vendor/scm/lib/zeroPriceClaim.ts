/* ── The RM 0 claim — ONE decision, every SO write surface ──────────────────
 *
 * A `unitPriceSen` of 0 on the wire means two different things and the server
 * cannot tell them apart on its own:
 *
 *   "this line is FREE"     the operator typed 0 into the price box
 *   "I have no price"       the SKU carries no sell price, or it is a sofa the
 *                           server prices from its Model's module SKUs at save
 *
 * The backend resolves it with `erpLineTrust`
 * (backend/src/scm/lib/mfg-pricing-recompute.ts): a 0 is persisted only when the
 * client states `zeroPriceIntended: true` ('operator-zero'); a bare 0 is "not
 * provided" and takes the catalogue fill. So the claim is the client's half of a
 * two-party rule, and it belongs in one place rather than at each site.
 *
 * `authored` is REQUIRED and has no default, deliberately (CLAUDE.md: a
 * parameter that DECIDES something is required). It is the whole safety of this
 * helper: claim on EVERY zero and an unpriced sofa build books at RM 0, because
 * the trust arm then wins over the server's own module arithmetic. Pass true
 * only where the number in front of the operator IS the number that will be
 * charged:
 *
 *   - the operator typed into the price box on this line (a create/add draft),
 *   - or the line already exists and its 0 is its PERSISTED price, being carried
 *     through an edit that must not silently re-price it.
 *
 * Pass false where the 0 is the client's failure to resolve a price.
 */
export function zeroPriceClaim(
  unitPriceSen: number,
  authored: boolean,
): { zeroPriceIntended?: true } {
  return unitPriceSen === 0 && authored ? { zeroPriceIntended: true } : {};
}
