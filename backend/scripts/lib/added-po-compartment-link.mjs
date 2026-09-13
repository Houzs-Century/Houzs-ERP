/* Which sales-order line an ADDED purchase-order compartment belongs to.
 *
 * WHY THIS EXISTS (staff issue #19, 2026-09). `apply-sofa-compartment-corrections`
 * splits a sofa build into its compartments on BOTH documents. On the purchase
 * order it INSERTs the new piece and deliberately leaves `so_item_id` NULL,
 * because at that moment the sales order may not hold the matching piece yet
 * (its half of the same entry runs after). Nothing ever came back to link it.
 * Since 2026-09-09 a company-1 sofa line is covered ONLY by a purchase-order
 * line that carries its `so_item_id` (`isDedicated`, scm/routes/mrp.ts), so the
 * added piece was invisible: HC-SO-011114's 9058-STOOL read SHORT while
 * HC-PO-010045 carried it (prod APPLY run 34507126629 inserted six such rows).
 *
 * The decision is made AFTER both halves are written, and only on evidence the
 * documents themselves state — never on a code that merely looks alike, because
 * sofa compartment codes repeat across customers
 * (docs/mrp-stock-vs-bound-rules-2026-09-09.md §3):
 *   1. the added row's SIBLINGS on the same purchase order and the same account-
 *      book line (`linked_ac_dtlkey`) are linked, and they name exactly ONE
 *      sales order and exactly ONE book line on it;
 *   2. on that sales order, exactly ONE live line with the same item code, the
 *      same book line and the same warehouse is not already covered by a live
 *      purchase-order line.
 * Anything else is LEFT unlinked with the reason, for a human.
 *
 * Pure: no database. The caller reads the rows; tests/addedPoCompartmentLink.test.mjs
 * pins the rules.
 */

const norm = (s) => String(s ?? "").trim().toUpperCase();
const same = (a, b) => (a ?? null) === (b ?? null);

/**
 * @param {{ item_code: string, warehouse_id: string|null, linked_ac_dtlkey: string|null }} added
 * @param {Array<{ so_doc: string, so_dtlkey: string|null }>} siblings  linked PO lines on the same PO and book line
 * @param {Array<{ id: string, doc_no: string, line_no: number|null, item_code: string, cancelled: boolean,
 *                 warehouse_id: string|null, linked_ac_dtlkey: string|null, covered: boolean }>} candidates
 * @returns {{ verdict: "link", soItemId: string, soDoc: string, soLineNo: number|null }
 *         | { verdict: "leave", reason: string }}
 */
export function decideAddedPoCompartmentLink(added, siblings, candidates) {
  if (!added.linked_ac_dtlkey) {
    return { verdict: "leave", reason: "the added row carries no account-book line key, so nothing ties it to a sibling" };
  }
  if (!siblings.length) {
    return { verdict: "leave", reason: "no other piece of this build on the purchase order is linked to a sales order" };
  }
  const docs = [...new Set(siblings.map((s) => s.so_doc))];
  if (docs.length !== 1) {
    return { verdict: "leave", reason: `the linked pieces of this build point at ${docs.length} sales orders (${docs.join(", ")})` };
  }
  const keys = [...new Set(siblings.map((s) => s.so_dtlkey ?? null))];
  if (keys.length !== 1 || keys[0] === null) {
    return { verdict: "leave", reason: `the linked pieces sit on ${keys[0] === null ? "a sales-order line with no book key" : `${keys.length} different sales-order book lines`}` };
  }
  const soDoc = docs[0];
  const soKey = keys[0];
  const fit = candidates.filter((c) =>
    c.doc_no === soDoc
    && !c.cancelled
    && norm(c.item_code) === norm(added.item_code)
    && same(c.linked_ac_dtlkey, soKey)
    && same(c.warehouse_id, added.warehouse_id));
  const open = fit.filter((c) => !c.covered);
  if (open.length === 1) {
    return { verdict: "link", soItemId: open[0].id, soDoc, soLineNo: open[0].line_no ?? null };
  }
  if (open.length > 1) {
    return { verdict: "leave", reason: `${soDoc} holds ${open.length} uncovered ${added.item_code} pieces on book line ${soKey} — which one this purchase line buys is not written down` };
  }
  return {
    verdict: "leave",
    reason: fit.length
      ? `${soDoc}'s ${added.item_code} on book line ${soKey} is already covered by another live purchase-order line — this row is a SURPLUS piece, not a missing link`
      : `${soDoc} holds no live ${added.item_code} on book line ${soKey} in this warehouse — the sales-order half of the build does not carry this piece`,
  };
}
