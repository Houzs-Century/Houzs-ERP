// Two questions that only exist because the world moved on 2026-08-10.
//
// `backfill-ac-line-keys.mjs` ran against PRODUCTION in APPLY mode
// (workflow run 31416597720) and reported, for the purchase-order half:
//
//     PO lines: erp lines 864; to set 275; already set 0; no AC match 589;
//               count mismatch 0 (skipped 0 lines in ambiguous groups)
//
// So 275 purchase-order lines now carry a `linked_ac_dtlkey` that was derived
// by a DIFFERENT rule from this repair's: a match on (AutoCount DocNo, ERP item
// code) through the mapping CSV, zipping same-code rows by a `line_no` the PO
// query selected as `NULL::int`. That changes two things.
//
//   1. Those 275 are no longer NULL, so this repair's `IS NULL` guard skips
//      them SILENTLY. Silence is the wrong answer here. A stored key that
//      disagrees with the one this repair derives is not a harmless difference
//      of opinion — it is a live wrong value in a column the write-back
//      dereferences. Migration 0273's own header says what a wrong DtlKey does:
//      AcSyncService APPENDS a line to the live account book instead of editing
//      the one the operator changed. So the repair AUDITS what it may not
//      overwrite, and reports every disagreement as a row for the owner.
//
//   2. The 589 the code match could not reach are the lines that still have no
//      identity at all, and "no AC match" is a symptom, not a reason. The
//      census below turns each one into a reason, so the gap between the two
//      rules is a measurement rather than a hypothesis.
//
// Neither function writes anything. They exist to make the DRY-RUN able to say
// something true about rows this repair deliberately does not touch.

/**
 * A stored line key against the one this repair derives for the same row.
 * @returns "absent" | "agree" | "disagree" | "underived"
 */
export function compareStoredKey(stored, derived) {
  const s = stored === null || stored === undefined || stored === "" ? null : Number(stored);
  const d = derived === null || derived === undefined || derived === "" ? null : Number(derived);
  if (s === null) return "absent";
  if (d === null) return "underived";
  /* Number(), not ===: the column is bigint and the postgres driver hands it
     back as a string on some paths and a number on others. Comparing those with
     === reports every single row as a disagreement, which would bury the real
     ones in noise and is exactly the kind of false alarm that gets a report
     ignored. NaN is impossible here — both sides are already non-null numbers
     from a bigint column and a Number()-validated DtlKey. */
  return s === d ? "agree" : "disagree";
}

/**
 * Why the (DocNo, ERP code) rule could not reach an ERP purchase-order line.
 *
 * The booleans are measured by the caller against the same two files and the
 * same mapping CSV that `backfill-ac-line-keys.mjs` reads, so the answer is
 * comparable to that script's own "no AC match" count rather than a re-scoped
 * near-miss.
 *
 * @param codeMatched        the (DocNo, mapped ERP code) key existed
 * @param docInOutstandingPo the AutoCount DocNo is in ac-outstanding-po.json.gz
 * @param docInSoLinkedPos   the AutoCount DocNo is in ac-so-linked-pos.json.gz
 * @param skuBeyondItemCode  supplier_sku is "<AutoCount ItemCode> <compartment>"
 * @param acItemMapped       the AutoCount ItemCode has a row in the mapping CSV
 * @returns a reason string, or null when there is no gap to explain
 */
export function codeMatchGapReason({
  codeMatched,
  docInOutstandingPo,
  docInSoLinkedPos,
  skuBeyondItemCode,
  acItemMapped,
}) {
  if (codeMatched) return null;
  if (!docInOutstandingPo && !docInSoLinkedPos) {
    return "the AutoCount document is in NEITHER committed PO export";
  }
  if (!docInOutstandingPo) {
    return "the AutoCount document is only in ac-so-linked-pos.json.gz, which the code match never opens (it reads ac-outstanding-po.json.gz alone)";
  }
  /* Checked before the mapping test on purpose. A decomposed sofa line fails
     BOTH ways — its compartment SKU has no mapping row AND its AutoCount item
     is a different string — and the compartment is the cause, the missing
     mapping row merely its consequence. Reporting the consequence would make
     the fix look like "add rows to the CSV", which cannot work: there is no
     AutoCount item to map a compartment to. */
  if (skuBeyondItemCode) {
    return "the ERP row is a COMPARTMENT of a decomposed line — supplier_sku is the AutoCount ItemCode plus a compartment, and material_code is the compartment SKU, so no mapping row can ever name it";
  }
  if (!acItemMapped) {
    return "the AutoCount ItemCode has no row in autocount-erp-mapping-1561.csv, so the code match can never fire for it";
  }
  return "the document is in the export and the item is mapped, but no AutoCount line on it maps to this row's material_code";
}

/**
 * True when `sku` extends `itemCode` with a compartment suffix.
 * "DSL-8030 SOFA 1A(LHF)" over "DSL-8030 SOFA" is a compartment; the bare
 * ItemCode is not, and neither is an unrelated sku that merely starts with the
 * same letters ("DSL-8030 SOFAX" has no space at the boundary).
 */
export function isCompartmentSku(sku, itemCode) {
  const s = (sku || "").trim().toUpperCase().replace(/\s+/g, " ");
  const c = (itemCode || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!s || !c) return false;
  return s.length > c.length && s.startsWith(c + " ");
}
