// ----------------------------------------------------------------------------
// IS THIS GROUP OF ERP LINES ONE PRODUCT? — docs/bugs/0672, the photo sites.
//
// THE SHAPE. Several places pick "the first row" out of a group keyed by
// something that is NOT unique — `(doc_no, linked_ac_dtlkey)` for the photo
// backfill and the repoint planner, `(doc_no, item_code)` for the two photo
// importers. Taking the first is not itself wrong: it is the owner's own sofa
// rule, 2026-08-10 — 「每个 SKU 的照片都一样,留第一个就可以了」. One AutoCount
// line becomes several ERP compartment lines, the photo belongs on the first
// piece, and the siblings showing nothing is the design.
//
// WHAT WAS MISSING is the assertion that makes "the first" safe: that every row
// in the group is the SAME MODEL. If it is, the group is one sofa build
// decomposed into compartments and any member identifies the build. If it is
// not, "the first" is a coin flip between two different products and the photo
// lands on whichever row happened to sort first — which, for a UUID-ordered
// group, is random.
//
// THE MODEL, NOT THE ITEM CODE. A sofa's compartments deliberately have
// DIFFERENT item codes: MODEL-1S, MODEL-2S, MODEL-CNR. Comparing item codes
// therefore answers "is this a sofa", not "is this one product", and answers it
// with a near-universal yes — docs/bugs/0672 records that exact mistake being
// made once already, when a discriminator over item codes returned 295 of 296
// and settled nothing. The model is the code before the first dash, and it is
// what compartments share.
//
// MEASURED, so this guard is known to be cheap. probe-link-identity.mjs run
// 34172468269 (2026-09-08 08:13 local) counted every shared `linked_ac_dtlkey`
// in production: 310 keys on mfg_sales_order_items (774 rows) and 106 on
// purchase_order_items (275 rows), and ALL of them are one model AND on one
// document. So no group in production fails this test today; the guard costs
// nothing now and refuses the first group that ever does.
// ----------------------------------------------------------------------------

/** Trim, upper-case, collapse inner whitespace — as everywhere else in this repo. */
export const normModelCode = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

/** The MODEL: the code before the first dash. `PC151-CNR` -> `PC151`. */
export const modelOfCode = (v) => normModelCode(v).split('-')[0];

/**
 * True when every row in `rows` names the same model, so any one of them
 * identifies the group.
 *
 * A row with NO code at all makes the answer FALSE, not true: a blank cannot be
 * asserted equal to anything, and treating "nothing to compare" as agreement is
 * the false negative this whole bug class is made of.
 *
 * `codeOf` says where the item code lives, because the three call sites shape
 * their rows differently.
 */
export function isOneModel(rows, codeOf = (r) => r.item_code) {
  if (!rows || rows.length === 0) return false;
  const models = new Set();
  for (const r of rows) {
    const m = modelOfCode(codeOf(r));
    if (!m) return false;
    models.add(m);
  }
  return models.size === 1;
}

/** The distinct models in a group, for a refusal message. */
export function modelsIn(rows, codeOf = (r) => r.item_code) {
  return [...new Set((rows ?? []).map((r) => modelOfCode(codeOf(r))))];
}
