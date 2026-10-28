import assert from "node:assert/strict";
import test from "node:test";

import { judgeCompartmentPair, normCode } from "./sofa-po-so-pair.mjs";

const row = (item_code) => ({ item_code });

test("every code unique on both sides is PROVABLE, and each pair names the same product", () => {
  const got = judgeCompartmentPair(
    [row("8030-1A(LHF)"), row("8030-1A(RHF)")],
    [row("8030-1A(RHF)"), row("8030-1A(LHF)")],
  );
  assert.equal(got.verdict, "provable");
  assert.equal(got.pairs.length, 2);
  for (const p of got.pairs) assert.equal(normCode(p.po.item_code), normCode(p.so.item_code));
});

test("ORDER is not the pairing - the item code is", () => {
  /* line_no is a storage order, not a physical layout. A pairing that used
     position would put the left arm on the right arm's purchase line whenever
     the two documents were keyed in a different order. */
  const got = judgeCompartmentPair(
    [row("9058-CNR"), row("9058-1NA")],
    [row("9058-1NA"), row("9058-CNR")],
  );
  assert.equal(got.verdict, "provable");
  const byPo = new Map(got.pairs.map((p) => [p.po.item_code, p.so.item_code]));
  assert.equal(byPo.get("9058-CNR"), "9058-CNR");
  assert.equal(byPo.get("9058-1NA"), "9058-1NA");
});

test("a code twice on one side is REFUSED - which row is which is a coin flip", () => {
  const got = judgeCompartmentPair(
    [row("9050-1NA"), row("9050-1NA")],
    [row("9050-1NA"), row("9050-1NA")],
  );
  assert.equal(got.verdict, "duplicateCode");
  assert.deepEqual(got.pairs, []);
});

test("a MIRRORED build is REFUSED as a build disagreement, not paired by count", () => {
  /* HC-PO-010085 against HC-SO-010287 on production, 2026-09-08: the same sofa
     with the arms on opposite ends. The row COUNTS agree, so a checker that
     compared only counts would have paired a left arm to a right arm. */
  const got = judgeCompartmentPair(
    [row("9058-1A(LHF)"), row("9058-2A(RHF)")],
    [row("9058-2A(LHF)"), row("9058-1A(RHF)")],
  );
  assert.equal(got.verdict, "differentProducts");
  assert.match(got.why, /BUILD disagreement/);
  assert.deepEqual(got.pairs, []);
});

test("a different NUMBER of rows is REFUSED - and the reason given is the honest one", () => {
  /* `countsDiffer` is DEFENSIVE and, on these three gates, unreachable: once no
     code is duplicated and the two sides carry the same SET of codes, the sizes
     are equal by construction. A shorter side always surfaces as the missing
     code, which is more useful than a count. The branch stays because "cannot
     happen" is what every silent mis-pairing believed; what is asserted here is
     that the pair is refused and NAMED, never that the label is `countsDiffer`. */
  const got = judgeCompartmentPair(
    [row("8051-1NA")],
    [row("8051-1NA"), row("8051-1A(RHF)")],
  );
  assert.notEqual(got.verdict, "provable");
  assert.equal(got.verdict, "differentProducts");
  assert.match(got.why, /8051-1A\(RHF\)/);
});

test("THE DISAGREEMENT THIS MODULE EXISTS FOR: an already-linked purchase row is part of the pair", () => {
  /* Production, 2026-09-08, HC-PO-010040 <- SO-012277. Three compartments; one
     purchase row was already dedicated. Tallying only the UNLINKED purchase rows
     read it as 2 against 3 and refused (probe run 34204007759); tallying every
     row carrying the key read 3 against 3 and paired it (repair run
     34203858897). The second is right, and this test is the difference. */
  const all = [row("8051-1NA"), row("8051-1A(RHF)"), row("8051-1A(LHF)")];
  const so = [row("8051-1NA"), row("8051-1A(RHF)"), row("8051-1A(LHF)")];
  assert.equal(judgeCompartmentPair(all, so).verdict, "provable");
  /* The same pair with the already-linked purchase row withheld is not provable
     at all. WHICH refusal it gets is not the point and the two tools did not
     even agree on that — the probe reported `countsDiffer` because it compared
     only the purchase side's codes against the sales side's, so a sales-only
     compartment was invisible to it and the shortfall surfaced as a count. This
     module tests membership BOTH ways, so it names the real difference. */
  assert.equal(judgeCompartmentPair(all.slice(0, 2), so).verdict, "differentProducts");
  assert.notEqual(judgeCompartmentPair(all.slice(0, 2), so).verdict, "provable");
});

test("casing and inner whitespace are noise, not identity", () => {
  const got = judgeCompartmentPair([row(" 8030-1a(lhf) ")], [row("8030-1A(LHF)")]);
  assert.equal(got.verdict, "provable");
});

test("an empty pair is not provable by vacuum", () => {
  /* Two empty sides satisfy every gate above, and returning `provable` with no
     pairs would let a caller report "resolved" over nothing. */
  const got = judgeCompartmentPair([], []);
  assert.equal(got.pairs.length, 0);
});
