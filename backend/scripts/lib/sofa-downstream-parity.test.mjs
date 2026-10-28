import assert from "node:assert/strict";
import test from "node:test";

import { planDownstreamParity } from "./sofa-downstream-parity.mjs";

const WANT = ["5526-L(LHF)", "5526-1NA", "5526-2A(RHF)"];
const row = (id, code, extra = {}) => ({ id, code, ...extra });

test("the production case: a receipt holding only the lead gains the other two", () => {
  /* HC-GR-000287 as production actually holds it, probe run 34316985562. */
  const r = planDownstreamParity([row("g1", "5526-L(LHF)")], WANT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keep, [{ id: "g1", from: "5526-L(LHF)", to: "5526-L(LHF)" }]);
  assert.deepEqual(r.add.map((a) => a.to), ["5526-1NA", "5526-2A(RHF)"]);
  assert.equal(r.template.id, "g1");
});

test("a document that already states the whole build adds nothing — the re-run is inert", () => {
  const r = planDownstreamParity(
    [row("a", "5526-L(LHF)"), row("b", "5526-1NA"), row("c", "5526-2A(RHF)")], WANT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.add, []);
  assert.equal(r.keep.length, 3);
  assert.match(r.how, /every piece already has a row/);
});

test("the lead is RE-CODED, never dropped: a placeholder row keeps its id", () => {
  /* The row id is what carries the link the invoice was raised through. */
  const r = planDownstreamParity([row("g1", "5526-1S")], WANT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keep, [{ id: "g1", from: "5526-1S", to: "5526-L(LHF)" }]);
  assert.equal(r.add.length, 2);
});

test("the same compartment under another MODEL keeps its own row", () => {
  const r = planDownstreamParity([row("g1", "9058-1NA")], WANT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keep, [{ id: "g1", from: "9058-1NA", to: "5526-1NA" }]);
  assert.deepEqual(r.add.map((a) => a.to), ["5526-L(LHF)", "5526-2A(RHF)"]);
});

test("REFUSES rather than deleting when the document holds more rows than the build has pieces", () => {
  const r = planDownstreamParity(
    [row("a", "5526-L(LHF)"), row("b", "5526-1NA"), row("c", "5526-2A(RHF)"), row("d", "5526-1S")], WANT);
  assert.equal(r.ok, false);
  assert.match(r.why, /4 row\(s\) for this build and the build has 3 piece\(s\)/);
  assert.match(r.why, /nothing here removes a/);
});

test("REFUSES a document carrying the build twice, rather than pairing one sofa out of two", () => {
  const r = planDownstreamParity(
    [row("a", "5526-L(LHF)"), row("b", "5526-1NA"), row("c", "5526-2A(RHF)"),
      row("d", "5526-L(LHF)"), row("e", "5526-1NA"), row("f", "5526-2A(RHF)")], WANT);
  assert.equal(r.ok, false);
  assert.match(r.why, /carries the sofa twice/);
});

test("a build that is not on the document at all is reported, not planned", () => {
  const r = planDownstreamParity([], WANT);
  assert.equal(r.ok, false);
  assert.match(r.why, /not on this document/);
});

test("a build with no pieces is refused rather than emptying a document", () => {
  const r = planDownstreamParity([row("g1", "5526-1S")], []);
  assert.equal(r.ok, false);
  assert.match(r.why, /names no pieces/);
});

test("codeOf is honoured, so a caller may name its own column", () => {
  const r = planDownstreamParity([{ id: "g1", item_code: "5526-1S" }], WANT, (x) => x.item_code);
  assert.equal(r.ok, true);
  assert.deepEqual(r.keep, [{ id: "g1", from: "5526-1S", to: "5526-L(LHF)" }]);
});
