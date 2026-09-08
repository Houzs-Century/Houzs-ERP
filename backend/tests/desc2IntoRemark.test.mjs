import { test } from "vitest";
import assert from "node:assert/strict";

import { AC_MARK, splitRemark, composeRemark, planRows, planDigest } from "../scripts/lib/desc2-remark.mjs";

/* ---------------------------------------------------------------- compose */

test("an empty remark takes the book text alone, marked", () => {
  assert.equal(composeRemark(null, 'KING SIZE'), `${AC_MARK}KING SIZE`);
  assert.equal(composeRemark("", 'KING SIZE'), `${AC_MARK}KING SIZE`);
  assert.equal(composeRemark("   ", 'KING SIZE'), `${AC_MARK}KING SIZE`);
});

test("the importer's own note survives; the book text is appended below it", () => {
  const got = composeRemark("sofa: seat sizes from photo", 'COL: PC151-01/ GAP: 12"');
  assert.equal(got, `sofa: seat sizes from photo\n${AC_MARK}COL: PC151-01/ GAP: 12"`);
});

test("a SOFA UNPARSED note is not destroyed", () => {
  const note = "SOFA UNPARSED — 按图/原文补件: unreadable";
  const got = composeRemark(note, "3S(60cm)/ Col: J9226-14");
  assert.ok(got.startsWith(note), "the importer's note must still lead the remark");
  assert.ok(got.endsWith("3S(60cm)/ Col: J9226-14"));
});

test("the book text is carried VERBATIM — no case, space or quote normalising", () => {
  const raw = `Col:PC151-01 /Div:8"+1"   `;
  const got = composeRemark(null, raw);
  assert.equal(splitRemark(got).acDesc2, raw.trim());
});

/* ------------------------------------------------------------ blank stays blank */

test("a line with no book text gets nothing — not an empty string, not a placeholder", () => {
  assert.equal(composeRemark("sofa: x", null), null);
  assert.equal(composeRemark("sofa: x", ""), null);
  assert.equal(composeRemark("sofa: x", "   "), null);
  assert.equal(composeRemark(null, null), null);
});

/* ------------------------------------------------------------------ idempotence */

test("running it twice is a no-op", () => {
  const once = composeRemark("sofa: why", 'KING SIZE');
  assert.equal(composeRemark(once, 'KING SIZE'), null);
});

test("running it three times is still a no-op", () => {
  const once = composeRemark(null, 'KING SIZE');
  const twice = composeRemark(once, 'KING SIZE');
  assert.equal(twice, null);
  assert.equal(composeRemark(once, 'KING SIZE'), null);
});

test("a remark that ALREADY quotes the book text is left alone — never doubled", () => {
  assert.equal(composeRemark('COL: PC151-01', 'COL: PC151-01'), null);
  assert.equal(composeRemark('COL: PC151-01 (checked)', 'COL: PC151-01'), null);
});

test("a marker already present is never rewritten, even if the book text differs", () => {
  assert.equal(composeRemark(`${AC_MARK}OLD TEXT`, "NEW TEXT"), null);
});

/* ----------------------------------------------------------------- parse back */

test("a script can split the remark back into its two halves", () => {
  const got = composeRemark("sofa: a; b", 'COL: X / GAP: 12"');
  assert.deepEqual(splitRemark(got), { base: "sofa: a; b", acDesc2: 'COL: X / GAP: 12"' });
});

test("splitting a remark that has no marker yields the whole thing as base", () => {
  assert.deepEqual(splitRemark("just a note"), { base: "just a note", acDesc2: null });
  assert.deepEqual(splitRemark(null), { base: "", acDesc2: null });
});

test("a base that itself mentions the marker text does not confuse the split", () => {
  const got = composeRemark(`staff wrote AC原文: something`, "REAL BOOK TEXT");
  assert.equal(splitRemark(got).acDesc2, "REAL BOOK TEXT");
});

/* ------------------------------------------------------------------- guards */

test("a multi-line book value is REFUSED rather than written unparseably", () => {
  assert.throws(() => composeRemark(null, "line one\nline two"), /newline/i);
});

/* --------------------------------------------------------------------- plan */

const D2 = new Map([["13724", "COL: PC151-11"], ["13728", "KING SIZE"]]);

test("the plan matches on the AutoCount line key, never on position", () => {
  const rows = [
    { id: "b", doc_no: "SO-2", line_no: 1, linked_ac_dtlkey: "13728", remark: null },
    { id: "a", doc_no: "SO-1", line_no: 1, linked_ac_dtlkey: "13724", remark: null },
  ];
  const { updates } = planRows(rows, D2);
  const byId = new Map(updates.map((u) => [u.id, u.after]));
  assert.equal(byId.get("a"), `${AC_MARK}COL: PC151-11`);
  assert.equal(byId.get("b"), `${AC_MARK}KING SIZE`);
});

test("a numeric dtlkey from the database matches the snapshot's string key", () => {
  const { updates } = planRows([{ id: "a", doc_no: "S", line_no: 1, linked_ac_dtlkey: 13724, remark: null }], D2);
  assert.equal(updates.length, 1);
});

test("a line with no book text at all is not in the plan", () => {
  const { updates, skipped } = planRows(
    [{ id: "z", doc_no: "S", line_no: 9, linked_ac_dtlkey: "99999", remark: "keep me" }], D2);
  assert.equal(updates.length, 0);
  assert.equal(skipped.noBookText, 1);
});

test("a line with no AutoCount key at all is not in the plan", () => {
  const { updates, skipped } = planRows(
    [{ id: "z", doc_no: "S", line_no: 9, linked_ac_dtlkey: null, remark: null }], D2);
  assert.equal(updates.length, 0);
  assert.equal(skipped.noKey, 1);
});

test("a second plan over the already-applied rows is empty", () => {
  const rows = [{ id: "a", doc_no: "S", line_no: 1, linked_ac_dtlkey: "13724", remark: null }];
  const after = planRows(rows, D2).updates[0].after;
  const again = planRows([{ ...rows[0], remark: after }], D2);
  assert.equal(again.updates.length, 0);
  assert.equal(again.skipped.alreadyCarried, 1);
});

/* ------------------------------------------------------------------- digest */

test("the digest changes when a targeted row's remark moved under us", () => {
  const rows = [{ id: "a", doc_no: "S", line_no: 1, linked_ac_dtlkey: "13724", remark: null }];
  const planned = planRows(rows, D2);
  const moved = planRows([{ ...rows[0], remark: "someone else wrote this" }], D2);
  assert.notEqual(planDigest(planned.updates), planDigest(moved.updates));
});

test("the digest is stable across row order", () => {
  const a = { id: "a", doc_no: "S", line_no: 1, linked_ac_dtlkey: "13724", remark: null };
  const b = { id: "b", doc_no: "S", line_no: 2, linked_ac_dtlkey: "13728", remark: null };
  assert.equal(planDigest(planRows([a, b], D2).updates), planDigest(planRows([b, a], D2).updates));
});
