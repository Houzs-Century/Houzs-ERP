// Which migrated sales-order lines name a different product from the book, and
// what each one has to become. PURE: maps in, findings out. No filesystem, no
// database, no process.exit - the runner
// (../correct-so-item-code-from-autocount.mjs) does the I/O and owns the write.
//
// NO SHEBANG: backend/tests/soItemCodeCorrection.test.mjs imports this module,
// and on Windows vitest inlines it, where a `#!` that is no longer at byte 0 is
// a load-time SyntaxError (CLAUDE.md, "Anything a TEST imports lives in
// backend/scripts/lib/").
//
// WHY THIS EXISTS. `sync-ac-delta` lane `links` bound ten sales-order lines to
// purchase-order lines for a DIFFERENT bed (docs/bugs/0668, 0671). The book was
// never the wrong side: on every one of those edges AutoCount's SODTL and PODTL
// rows carry a BYTE-IDENTICAL item code, and `autocount-erp-mapping-1561.csv`
// maps that one code to what OUR PURCHASE ORDER already says. So the row that
// disagrees with its own source is the SALES-ORDER line, and the owner ruled on
// 2026-09-08: follow AutoCount, correct the sales order.
//
// WHAT MAY CHANGE, AND WHAT MAY NOT. Three fields follow the product, and they
// are the three the importer derives from the AutoCount item code
// (import-ac-outstanding-so.mjs:234-249, :323-326):
//
//   item_code    the mapping sheet's ERP code, resolved through OUR OWN pick
//                list so the stored string is byte-identical to a picker-chosen
//                one. A code scm.mfg_products does not carry is REFUSED, never
//                invented.
//   item_group   CATG[the mapping sheet's category]. It is a copy of the same
//                CSV row, not a judgement - and it matters, because
//                `isHardBoundLine` reads the GROUP.
//   description  the ERP product's `name`. The importer's own comment says why:
//                "description MUST be the ERP product name (what a
//                picker-selected item stores), not the AutoCount Description -
//                else list shows item_code but Edit shows the AC text."
//
// NOTHING ELSE MOVES, and the two that could carry money or a customer's choice
// are named here so no later reader has to infer it:
//
//   qty / unit_price_sen / total_sen   the importer copied these from
//     `SODTL.Qty` and `SODTL.UnitPrice` of the SAME DtlKey
//     (import-ac-outstanding-so.mjs:257-258). The item code was mis-RESOLVED;
//     the money on the line came from the book row the correction is agreeing
//     with, so correcting the code cannot make the price more or less faithful.
//     Where the ERP holds a price and the book states 0.00, the standing owner
//     rule is that a blank never overwrites a value (docs/bugs/0675) - that is
//     a separate, already-listed population and this planner never touches it.
//   variants / custom_specials   parsed from `SODTL.Desc2` of the SAME DtlKey
//     (parseBedframe / parseSofa), which the correction does not move. They are
//     what the customer chose - colour, divan, gap, leg - and they are properties
//     of the ORDER, not of the item code.
//
// A DtlKey claimed by MORE THAN ONE ERP row is a decomposed sofa: one book line,
// one ERP row per compartment, and `linked_ac_dtlkey` is not unique
// (docs/bugs/0673 - a keyed repair that ignored this proposed RM 2,216,501 of
// invented revenue). Such a key is REFUSED here rather than corrected, because
// "the book's product" for a compartment row is not the book line's own code.

import { normItemCode, acFromSoDtlKey } from "./ac-po-line.mjs";
import { classifyItemCode } from "./item-code-class.mjs";

/** AutoCount mapping-sheet category -> `mfg_sales_order_items.item_group`.
 *  The SAME table import-ac-outstanding-so.mjs:68 uses. One rule, one place. */
export const AC_CATEGORY_TO_ITEM_GROUP = {
  MATTRESS: "mattress", BEDFRAME: "bedframe", ACC: "accessory", ACCESSORY: "accessory",
  BEDLINES: "accessory", DIFFUSER: "others", CARPET: "others", DINING: "others",
  OTHER: "others", SERVICE: "service", TRANS: "service", SOFA: "sofa",
};

export const itemGroupForCategory = (cat) =>
  AC_CATEGORY_TO_ITEM_GROUP[String(cat ?? "").trim().toUpperCase()] || "others";

/**
 * @param {object} a
 * @param {Array}  a.edges         AutoCount PODTL rows carrying FromSODtlKey
 * @param {Map}    a.bookSoByDtl   SODtlKey (string) -> the book's SODTL row
 * @param {Map}    a.acMapByCode   normalised AutoCount code -> { erp, cat }
 * @param {Map}    a.erpRowsByDtl  SODtlKey (string) -> array of ERP SO line rows
 * @param {Map}    a.productByCode normalised ERP code -> { code, name }
 * @returns {{plan: Array, refused: Array, counts: Object}}
 */
export function planSoItemCodeCorrections({ edges, bookSoByDtl, acMapByCode, erpRowsByDtl, productByCode }) {
  const plan = [];
  const refused = [];
  const counts = { edges: 0, notInBook: 0, unmapped: 0, notInErp: 0, decomposed: 0, agree: 0, noProduct: 0, translation: 0 };
  const seen = new Set();

  for (const e of edges ?? []) {
    const key = acFromSoDtlKey(e);
    if (key == null) continue;
    /* One SO line can feed several PO lines, so the same key arrives more than
       once. Correcting it twice would be a second UPDATE of a row the first
       already moved - de-duplicate on the KEY, not on the edge. */
    if (seen.has(key)) continue;
    seen.add(key);
    counts.edges++;

    const book = bookSoByDtl.get(key);
    if (!book) { counts.notInBook++; continue; }

    const acCode = book.itemKey;
    const m = acMapByCode.get(normItemCode(acCode));
    if (!m || !m.erp) { counts.unmapped++; continue; }

    const rows = erpRowsByDtl.get(key) ?? [];
    if (rows.length === 0) { counts.notInErp++; continue; }
    if (rows.length > 1) {
      counts.decomposed++;
      refused.push({
        why: "decomposed",
        dtlKey: key, acCode, docNo: rows[0]?.doc_no ?? null, rows: rows.length,
        detail: `AutoCount line ${key} (${acCode}) is claimed by ${rows.length} ERP rows - a decomposed sofa. The book line's own code is not a compartment's code; a person owns this one.`,
      });
      continue;
    }

    const row = rows[0];
    if (normItemCode(row.item_code) === normItemCode(m.erp)) { counts.agree++; continue; }

    /* OUR CODE IS NOT THE SHEET'S, AND THAT IS NOT AUTOMATICALLY A DEFECT.
       A migrated line very often carries the BOOK'S OWN code rather than the
       sheet's longer catalogue name - "DL-CS2 NN-WINTER SLEEP MATT (K" against
       the sheet's "DUNLOPILLO COOLSILK 2.0 NANO-G WINTER SLEEP MATT (K)". The
       two name the same product; only the string differs. Correcting those
       would be a mass rename of lines nothing is wrong with, and on the `all`
       population it is the difference between a handful of corrections and
       hundreds. lib/item-code-class.mjs decides, and only `different` is a
       defect this planner may write. */
    const k = classifyItemCode({ acCode, erpCode: row.item_code, mapping: acMapByCode, groupSize: rows.length });
    if (k.cls !== "different") { counts.translation++; continue; }

    /* Resolve through OUR OWN pick list so the stored string is byte-identical
       to a picker-chosen one. `m.erp` is what the CSV says; `product.code` is
       what the catalogue actually carries. */
    const product = productByCode.get(normItemCode(m.erp));
    if (!product) {
      counts.noProduct++;
      refused.push({
        why: "noProduct",
        dtlKey: key, acCode, docNo: row.doc_no, ours: row.item_code, wanted: m.erp,
        detail: `the mapping sheet says "${m.erp}" and scm.mfg_products does not carry that code for this company - REFUSED rather than writing a code our own pick list cannot resolve.`,
      });
      continue;
    }

    plan.push({
      id: row.id,
      docNo: row.doc_no,
      lineNo: row.line_no ?? null,
      dtlKey: key,
      debtorName: row.debtor_name ?? null,
      acCode,
      fromCode: row.item_code,
      toCode: product.code,
      fromGroup: row.item_group,
      toGroup: itemGroupForCategory(m.cat),
      fromDescription: row.description,
      toDescription: product.name,
      /* Carried so the runner can PRINT them and the verify can assert they did
         not move. Never written. */
      qty: Number(row.qty),
      unitPriceSen: Number(row.unit_price_sen),
      totalSen: Number(row.total_sen),
      unitCostSen: Number(row.unit_cost_sen ?? 0),
      stockStatus: row.stock_status ?? null,
      variants: row.variants ?? null,
      customSpecials: row.custom_specials ?? null,
      bookQty: book.qty, bookUnitPrice: book.unitPrice, bookSubTotal: book.subTotal,
    });
  }

  return { plan, refused, counts };
}
