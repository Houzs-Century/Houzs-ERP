// Carry AutoCount's own Description 2 onto the ERP sales-order line's REMARK.
//
// Owner, 2026-09-08: 「记得把autocount的这个description2 remain着搬进去我们的
// remark」 — keep the book's Description 2 and move it into our remark.
//
// WHY THE REMARK AND NOT description2, WHICH ALREADY HOLDS IT. The go-live
// importer does write the book text to mfg_sales_order_items.description2
// (import-ac-outstanding-so.mjs, ICOLS -> `V(it.d2 || null)`), so the words are
// in the database. They are nonetheless (a) INVISIBLE and (b) DOOMED:
//
//   (a) every surface renders `buildVariantSummary(item_group, variants) ||
//       description2` — the decoded variant summary WINS, and a migrated line
//       always has a variants blob, so the stored book text never reaches the
//       screen (SalesOrderDetailV2.tsx:817-824, SalesOrderDetail.tsx:2399-2409,
//       MobileSODetail.tsx:1064-1070, DocumentLinesExpansion.tsx:600-610).
//   (b) the SO item PATCH REGENERATES the column on every write —
//       `updates['description2'] = buildVariantSummary(...) || null`
//       (routes/mfg-sales-orders.ts:8575, "Description 2 is ALWAYS the
//       server-generated variant summary"). The first time anyone edits the
//       line, AutoCount's words are overwritten by our derivation.
//
// `remark` has neither problem: it is rendered verbatim on every SO surface, it
// is a searchable/filterable/exportable column on the desktop detail, and it is
// NOT in SO_ITEM_COLS (scm/lib/autocount-outbox.ts:382) so nothing here can
// reach the AutoCount write-back. This is the SALES-side twin of what the PO
// migration already did with purchase_order_items.notes.
//
// THE COMPOSITION RULE. The importer's own notes are load-bearing — "sofa: …",
// "SOFA UNPARSED — 按图/原文补件: …", "name-matched from free-text" — so the book
// text is APPENDED on its own final line behind a marker, never substituted:
//
//     sofa: seat sizes read from the drawing
//     AC原文: COL: PC151-01/ DIVAN: 8" + 2" LEG/ GAP: 12"
//
// A person reads it as the order slip's own words. A script gets them back with
// splitRemark(). The marker is safe to parse on: measured over all 16,532 SO
// Desc2 values in data/ac-reconcile-truth.json.gz, NONE contains a newline, a
// CJK character, or the marker itself, and none is blank (blank Desc2 is
// omitted from the snapshot, not empty-stringed).
//
// COPY, NEVER COMPUTE. The value is AutoCount's, trimmed of surrounding
// whitespace and otherwise byte-for-byte. A line whose book Desc2 is absent
// gets NOTHING — not an empty string, not a placeholder.

import crypto from "node:crypto";

/** The marker that opens the carried book text. Its trailing space is part of it. */
export const AC_MARK = "AC原文: ";

const s = (v) => (v == null ? "" : String(v));

/**
 * Split a remark into the part that was already there and the carried book text.
 *
 * The marker is matched at the START of a line only, and the LAST such line
 * wins, so a base remark that merely mentions the marker mid-sentence cannot
 * hijack the split. Everything after the marker to end-of-string is the book
 * text — exact, because a Desc2 never contains a newline and the block is
 * always appended last.
 *
 * @param {string|null|undefined} remark
 * @returns {{base: string, acDesc2: string|null}}
 */
export function splitRemark(remark) {
  const r = s(remark);
  if (!r) return { base: "", acDesc2: null };
  const at = r.startsWith(AC_MARK) ? 0 : r.lastIndexOf(`\n${AC_MARK}`);
  if (at < 0) return { base: r, acDesc2: null };
  const markAt = at === 0 ? 0 : at + 1;
  return {
    base: at === 0 ? "" : r.slice(0, at).replace(/\s+$/, ""),
    acDesc2: r.slice(markAt + AC_MARK.length),
  };
}

/**
 * The remark this line should end up with, or `null` when it must not change.
 *
 * Returns null — i.e. leave the row alone — when:
 *   - the book has no Desc2 for the line          (blank stays blank)
 *   - the remark already carries a marked block   (idempotence; a second run
 *     writes nothing, whatever the block says)
 *   - the remark already quotes the book text     (never double it — the PO
 *     side measured 891 of 923 migrated lines byte-identical to description2)
 *
 * @param {string|null|undefined} existingRemark
 * @param {string|null|undefined} desc2  AutoCount's own Description 2
 * @returns {string|null}
 */
export function composeRemark(existingRemark, desc2) {
  const book = s(desc2).trim();
  if (!book) return null;
  if (/[\r\n]/.test(book)) {
    throw new Error(`Description 2 contains a newline and would not round-trip: ${JSON.stringify(book)}`);
  }
  const { base, acDesc2 } = splitRemark(existingRemark);
  if (acDesc2 !== null) return null;
  if (base.includes(book)) return null;
  return base.trim() === "" ? `${AC_MARK}${book}` : `${base.replace(/\s+$/, "")}\n${AC_MARK}${book}`;
}

/**
 * Plan the whole batch.
 *
 * Rows are paired to the book on `linked_ac_dtlkey` — the AutoCount line key —
 * and NEVER on position: two similar rows paired by position get transposed
 * (docs/bugs/0690). The snapshot's keys are strings; a numeric key off the
 * database is coerced to match.
 *
 * @param {Array<{id:string, doc_no:string, line_no:number|string, linked_ac_dtlkey:string|number|null, remark:string|null}>} rows
 * @param {Map<string,string>} desc2ByDtlKey
 */
export function planRows(rows, desc2ByDtlKey) {
  const updates = [];
  const skipped = { noKey: 0, noBookText: 0, alreadyCarried: 0, alreadyQuoted: 0 };
  for (const row of rows ?? []) {
    const key = row.linked_ac_dtlkey;
    if (key == null || s(key).trim() === "") { skipped.noKey += 1; continue; }
    const book = desc2ByDtlKey.get(s(key).trim());
    if (!book || !s(book).trim()) { skipped.noBookText += 1; continue; }
    const after = composeRemark(row.remark, book);
    if (after == null) {
      if (splitRemark(row.remark).acDesc2 !== null) skipped.alreadyCarried += 1;
      else skipped.alreadyQuoted += 1;
      continue;
    }
    updates.push({
      id: row.id,
      docNo: row.doc_no,
      lineNo: row.line_no,
      dtlKey: s(key).trim(),
      before: row.remark ?? null,
      after,
    });
  }
  return { updates, skipped };
}

/**
 * A fingerprint of WHAT THIS PLAN SAW — every targeted row's id and the remark
 * it held at plan time. Apply re-reads the rows and recomputes this; a mismatch
 * means something moved under us (another lane rewriting sofa remarks, a person
 * editing a line) and the apply must refuse rather than write a stale plan.
 *
 * Order-independent: the entries are sorted, so a different row order over the
 * same facts is the same digest.
 */
export function planDigest(updates) {
  const lines = (updates ?? [])
    .map((u) => `${u.id}${u.before ?? ""}${u.after}`)
    .sort();
  return crypto.createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}
