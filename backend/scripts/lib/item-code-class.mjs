// WHY a line's item code differs from the book's, in one word, for one line.
//
// "确保全部 SO PO GR DO SI PI 都是对的" produced an `item code` column, and on
// 2026-09-08 it read 101 on sales orders and 10 on purchase orders. That number
// was waved away all night as "derived, so it measures our translation, not a
// defect" - an ASSUMPTION nobody had measured. It is three unrelated populations
// wearing one number, and only the third is a defect:
//
//   TRANSLATION   our code is the book's code, or the mapping sheet's counterpart
//                 of it. The comparison is what differs, not the product.
//   DECOMPOSITION one book line is several ERP rows - a sofa is one line per
//                 COMPARTMENT here and one line per SOFA there - so only the
//                 MODEL is commensurable, and it agrees.
//   DIFFERENT     our line names a product the book does not. THIS is the defect,
//                 and it is the shape that put a REGAL in front of a customer
//                 whose book line says TRION (docs/bugs/0668, 0671, PR #3132).
//
// PURE: codes and lookup tables in, a verdict out. No filesystem, no database.
// The callers own the I/O and the writes.
//
// NO SHEBANG: tests/itemCodeClass.test.mjs imports this module (see
// lib/so-item-code-correction.mjs for the Windows vitest reason).

import { SOFA_MODEL_ALIAS } from "./parse-sofa.mjs";
import { SOFA_COMPARTMENTS } from "./sofa-compartment-suffixes.mjs";
import { normCode } from "./ac-mapping-csv.mjs";

/* The model is the first run of 3+ digits, folded through the alias the floor
   actually uses - the owner confirmed it on 2026-09-08 ("5536 是 9058,5540 是
   8030"). 5535 is NOT in the table and must never be folded: it is its own
   model, and folding it would turn a real finding into a clean one. */
export const modelOf = (s) => {
  const m = (String(s ?? "").match(/\d{3,}/) || [null])[0];
  return m == null ? null : SOFA_MODEL_ALIAS[m] || m;
};

/** Does this ERP code look like ONE COMPARTMENT of a decomposed sofa? */
export const isCompartmentCode = (s) => {
  const c = normCode(s);
  const cut = c.lastIndexOf("-");
  return cut > 0 && SOFA_COMPARTMENTS.has(c.slice(cut + 1));
};

/**
 * @param {object} a
 * @param {string} a.acCode    the book's ItemCode on the AutoCount line
 * @param {string} a.erpCode   our line's item_code
 * @param {Map}    a.mapping   normalised AC code -> {erp, cat, status}, from readMappingCsv
 * @param {number} [a.groupSize] how many ERP rows carry this AutoCount DtlKey (>1 = decomposed)
 * @returns {{cls: "translation"|"decomposition"|"different", why: string, wanted: string|null}}
 *   `wanted` is what the book says this line should be, in ERP terms, when the
 *   mapping sheet resolves it - NEVER invented, and null when the sheet is silent.
 */
export function classifyItemCode({ acCode, erpCode, mapping, groupSize = 1 }) {
  const ac = normCode(acCode);
  const erp = normCode(erpCode);
  const m = mapping.get(ac);
  const wanted = m && m.erp ? m.erp : null;

  /* Our line carries the book's own string. Whatever the sheet would have
     preferred, the two sides name the same thing. */
  if (ac === erp) return { cls: "translation", why: "our code IS the book's code", wanted };

  if (wanted && normCode(wanted) === erp) {
    return { cls: "translation", why: "the mapping sheet's counterpart of the book's code", wanted };
  }

  /* DECOMPOSITION. One book line, several ERP rows, one per compartment - so
     the codes are "DSL-8051 SOFA" against "8051-1A(LHF)" and only the MODEL is
     comparable. The book's model is taken from the sheet's ERP code when the
     sheet resolves (it is already in OUR numbering) and from the raw AutoCount
     code when it does not.

     A model is required on BOTH sides. A pair where only one side carries one
     is NOT decomposition - that is how "AMN-SOFA PILLOW" (an accessory whose
     NAME contains the word) used to be excused. */
  const bookModel = modelOf(wanted ?? ac);
  const ourModel = modelOf(erp);
  const decomposed = groupSize > 1 || isCompartmentCode(erp);
  if (decomposed && bookModel && ourModel && bookModel === ourModel) {
    return {
      cls: "decomposition",
      why: `one book line, ${groupSize > 1 ? `${groupSize} ERP compartment rows` : "a compartment row"}, model ${ourModel} on both sides`,
      wanted,
    };
  }

  if (bookModel && ourModel && bookModel !== ourModel) {
    return { cls: "different", why: `the book's sofa is model ${bookModel}; ours says ${ourModel}`, wanted };
  }
  if (!wanted) {
    return { cls: "different", why: "the mapping sheet does not carry the book's code, so nothing resolves ours", wanted };
  }
  return { cls: "different", why: `the book says "${wanted}"; ours says "${erp}"`, wanted };
}
