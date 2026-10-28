import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideAddedPoCompartmentLink } from "../scripts/lib/added-po-compartment-link.mjs";

/* Staff issue #19 (HC-SO-011114 / HC-PO-010045): a compartment the sofa
   correction ADDED to a purchase order was never linked to its sales-order
   piece, so the MRP / SO screen could not see the purchase order. */

const WH = "wh-kl";
const added = { item_code: "9058-STOOL", warehouse_id: WH, linked_ac_dtlkey: "914354" };
const sib = (so_doc = "HC-SO-011114", so_dtlkey = "764705") => ({ so_doc, so_dtlkey });
const cand = (over = {}) => ({
  id: "so-ln5", doc_no: "HC-SO-011114", line_no: 5, item_code: "9058-STOOL", cancelled: false,
  warehouse_id: WH, linked_ac_dtlkey: "764705", covered: false, ...over,
});

test("the HC-SO-011114 shape links: one order, one book line, one uncovered piece", () => {
  const d = decideAddedPoCompartmentLink(added, [sib(), sib()], [cand(), cand({ id: "so-ln1", line_no: 1, item_code: "9058-2A(LHF)", covered: true })]);
  assert.deepEqual(d, { verdict: "link", soItemId: "so-ln5", soDoc: "HC-SO-011114", soLineNo: 5 });
});

test("item codes compare trimmed and case-insensitive", () => {
  const d = decideAddedPoCompartmentLink(added, [sib()], [cand({ item_code: " 9058-stool " })]);
  assert.equal(d.verdict, "link");
});

test("already covered by another PO line is a SURPLUS piece, never re-linked (HC-PO-010041)", () => {
  const d = decideAddedPoCompartmentLink(added, [sib()], [cand({ covered: true })]);
  assert.equal(d.verdict, "leave");
  assert.match(d.reason, /SURPLUS/);
});

test("the sales order does not carry the piece (HC-PO-009940 / HC-SO-013224) is left", () => {
  const d = decideAddedPoCompartmentLink(added, [sib()], [cand({ item_code: "9058-1NA" })]);
  assert.equal(d.verdict, "leave");
  assert.match(d.reason, /does not carry this piece/);
});

test("two uncovered candidates are ambiguous and left", () => {
  const d = decideAddedPoCompartmentLink(added, [sib()], [cand(), cand({ id: "so-ln6", line_no: 6 })]);
  assert.equal(d.verdict, "leave");
  assert.match(d.reason, /2 uncovered/);
});

test("siblings naming two orders, no siblings, or no book key are all left", () => {
  assert.equal(decideAddedPoCompartmentLink(added, [sib(), sib("HC-SO-099999")], [cand()]).verdict, "leave");
  assert.equal(decideAddedPoCompartmentLink(added, [], [cand()]).verdict, "leave");
  assert.equal(decideAddedPoCompartmentLink({ ...added, linked_ac_dtlkey: null }, [sib()], [cand()]).verdict, "leave");
  assert.equal(decideAddedPoCompartmentLink(added, [sib("HC-SO-011114", null)], [cand()]).verdict, "leave");
});

test("a different book line, a cancelled line or another warehouse never matches", () => {
  for (const over of [{ linked_ac_dtlkey: "764706" }, { cancelled: true }, { warehouse_id: "wh-jb" }, { doc_no: "HC-SO-000001" }]) {
    assert.equal(decideAddedPoCompartmentLink(added, [sib()], [cand(over)]).verdict, "leave", JSON.stringify(over));
  }
});

/* The rule is only worth something if the applier USES it. On the tree that
   shipped the defect the PO insert returned nothing and no pass linked it. */
test("apply-sofa-compartment-corrections links the purchase pieces it adds", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "../scripts/apply-sofa-compartment-corrections.mjs"), "utf8");
  assert.match(src, /import \{ decideAddedPoCompartmentLink \} from "\.\/lib\/added-po-compartment-link\.mjs"/);
  assert.match(src, /INSERT INTO scm\.purchase_order_items[\s\S]{0,900}?RETURNING id/);
  assert.match(src, /SET so_item_id = \$\{[^}]+\}[\s\S]{0,120}?so_item_id IS NULL/);
});
