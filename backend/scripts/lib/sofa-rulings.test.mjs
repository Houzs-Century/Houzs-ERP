import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeSofaRulingLookup } from "./sofa-rulings.mjs";

/* A throwaway data directory shaped like scripts/data. The loader reads the two
   real filenames, so the fixture has to use them. */
const withData = (docs) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofa-rulings-"));
  fs.writeFileSync(path.join(dir, "sofa-compartment-corrections-2026-08.json"), JSON.stringify(docs.aug ?? {}));
  fs.writeFileSync(path.join(dir, "sofa-compartment-corrections-2026-09.json"), JSON.stringify(docs.sep ?? {}));
  return dir;
};
const lines = (desc2) => [{ description2: desc2 }];

test("a written ruling is found, and carries the file it came from", () => {
  const dir = withData({
    sep: { entries: [{ docs: ["HC-SO-013327"], pieces: ["1A(LHF)", "2A(RHF)", "1B(RHF)"], desc2Match: "Peach" }] },
  });
  const look = makeSofaRulingLookup(dir);
  const hit = look("HC-SO-013327", lines("Size:24/Col:BO315-07 Peach"));
  assert.deepEqual(hit.pieces, ["1A(LHF)", "2A(RHF)", "1B(RHF)"]);
  assert.equal(hit.source, "sofa-compartment-corrections-2026-09.json");
});

test("a HELD ruling is NOT a ruling — it has not been written, so it is still work", () => {
  /* HC-SO-011099 on 2026-09-08: the owner ruled 2S and the write is refused,
     so the reconcile must keep reporting it as DIFFER (docs/bugs/0719). */
  const dir = withData({
    aug: { corrections: [], _held: [{ docs: ["HC-SO-011099"], pieces: ["2S"], desc2Match: "2S / colour" }] },
  });
  assert.equal(makeSofaRulingLookup(dir)("HC-SO-011099", lines("2S / colour :BO315-4")), null);
});

test("a document holding TWO builds gets the one its own text names, never the other", () => {
  const dir = withData({
    sep: {
      entries: [
        { docs: ["HC-SO-013475"], pieces: ["2S"], desc2Match: "2S(35\")" },
        { docs: ["HC-SO-013475"], pieces: ["1A(LHF)", "1NA", "1A(RHF)"], desc2Match: "3S(28\")" },
      ],
    },
  });
  const look = makeSofaRulingLookup(dir);
  assert.deepEqual(look("HC-SO-013475", lines('3S(28")')).pieces, ["1A(LHF)", "1NA", "1A(RHF)"]);
  assert.deepEqual(look("HC-SO-013475", lines('2S(35")')).pieces, ["2S"]);
});

test("a needle that matches nothing answers null — never the document's other build", () => {
  const dir = withData({
    sep: {
      entries: [
        { docs: ["HC-SO-013475"], pieces: ["2S"], desc2Match: "2S(35\")" },
        { docs: ["HC-SO-013475"], pieces: ["1A(LHF)"], desc2Match: "3S(28\")" },
      ],
    },
  });
  assert.equal(makeSofaRulingLookup(dir)("HC-SO-013475", lines("something else entirely")), null);
});

test("a document nobody ruled on answers null", () => {
  const dir = withData({ sep: { entries: [{ docs: ["HC-SO-000001"], pieces: ["2S"], desc2Match: "x" }] } });
  assert.equal(makeSofaRulingLookup(dir)("HC-SO-999999", lines("x")), null);
});

test("unreadable data is REPORTED, never silently treated as no rulings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sofa-rulings-bad-"));
  fs.writeFileSync(path.join(dir, "sofa-compartment-corrections-2026-08.json"), "{ not json");
  const said = [];
  const look = makeSofaRulingLookup(dir, (m) => said.push(m));
  assert.equal(said.length, 1, "with no rulings loaded every ruled build reports DIFFER again");
  assert.equal(look("HC-SO-013327", lines("Peach")), null);
});

test("the REAL corrections files load, and the builds written on 2026-09-08 are found", () => {
  /* Pins the fixtures above to the shape production actually has. */
  const look = makeSofaRulingLookup(path.join(import.meta.dirname, "..", "data"));
  assert.deepEqual(
    look("HC-SO-013327", lines('Size:24”/Col:BO315-07 Peach/Bottom wrap nylon'))?.pieces,
    ["1A(LHF)", "2A(RHF)", "1B(RHF)"],
  );
  assert.deepEqual(
    look("HC-SO-010209", lines("L shape \nbottom Nilon \nColour : modenza"))?.pieces,
    ["1A(LHF)", "1NA", "L(RHF)"],
  );
  assert.equal(
    look("HC-SO-011099", lines("2S / colour :BO315-4")), null,
    "held, so it must stay DIFFER in the reconcile",
  );
});

/* ── A RULING ADDRESSED BY LINE KEY MUST BE FOUND TOO ───────────────────────
 * HC-SO-012827 holds a three-seater and a separate single chair whose Desc2 the
 * book wrote as a SUBSTRING of the three-seater's, so the single chair has no
 * needle that reaches it alone and is addressed by the account book's own
 * DtlKey instead (scripts/lib/sofa-desc2-match.mjs).
 *
 * This lookup is what stops the report handing the owner back a sofa he has
 * already ruled on (docs/bugs/0720). It chose an entry by `desc2Match` only, so
 * a line-key ruling was invisible to it and its line kept reading "sofa build
 * not verifiable" AFTER the build had been written to production — measured on
 * tally run 34236971666, where HC-SO-012827 stayed in the cannot-compare list
 * with the owner's answer already in the database.
 *
 * The ERP lines carry the key as `ac_dtlkey` (lib/ac-reconcile-erp-sql.mjs). */
const keyedLines = (rows) => rows.map(([ac_dtlkey, description2]) => ({ ac_dtlkey, description2 }));

const SO_012827_DATA = {
  sep: {
    entries: [
      { docs: ["HC-SO-012827"], pieces: ["1A(LHF)", "1NA", "1A(RHF)"], desc2Match: "3 seater", why: "owner" },
      { docs: ["HC-SO-012827"], pieces: ["1S"], lineKeys: ["873101"], why: "owner" },
    ],
  },
};

test("LINE KEY: a ruling addressed by lineKeys is found on the line that carries the key", () => {
  const look = makeSofaRulingLookup(withData(SO_012827_DATA));
  const got = look("HC-SO-012827", keyedLines([["873101", "35 inch  color modenza 07 silver  Nilon bottom"]]));
  assert.deepEqual(got && got.pieces, ["1S"]);
});

test("LINE KEY: the three-seater still resolves by its text, unaffected", () => {
  const look = makeSofaRulingLookup(withData(SO_012827_DATA));
  const got = look("HC-SO-012827", keyedLines([["873100", "3 seater  35 inch  color modenza 07 silver  Nilon bottom"]]));
  assert.deepEqual(got && got.pieces, ["1A(LHF)", "1NA", "1A(RHF)"]);
});

test("LINE KEY: a key ruling never blesses a line that does not carry the key", () => {
  /* The whole point of the key. Answering "1S" for the three-seater's lines
     would bless the wrong furniture, which is the failure this lane prevents. */
  const look = makeSofaRulingLookup(withData({
    sep: { entries: [{ docs: ["HC-SO-012827"], pieces: ["1S"], lineKeys: ["873101"], why: "owner" }] },
  }));
  assert.equal(look("HC-SO-012827", keyedLines([["873100", "3 seater  35 inch  color"]])), null);
});

test("LINE KEY: a lone key ruling is not treated as the document's only build", () => {
  /* `only` blesses a single needle-less entry as the document's one build. A
     lineKeys entry is needle-less but is NOT unaddressed, so it must not take
     that path on a line whose key does not match. */
  const look = makeSofaRulingLookup(withData({
    sep: { entries: [{ docs: ["HC-SO-012827"], pieces: ["1S"], lineKeys: ["873101"], why: "owner" }] },
  }));
  assert.equal(look("HC-SO-012827", [{ description2: "no key on this row at all" }]), null);
});

test("a LATER ruling supersedes an earlier one on the same build", () => {
  /* HC-SO-012929, measured on the 2026-09-08 book: the owner ruled this build
     TWICE. August read it as three pieces; on 2026-09-04 and again on 2026-09-05
     he removed the surplus 1S and ruled 1A(LHF)+2A(RHF). Both entries' needles
     match the SAME book text, so the lookup had two candidates and answered with
     the FIRST — the stale August one. The ERP holds his September answer, the
     stale ruling did not match it, and the document kept reporting as
     "CANNOT BE COMPARED — your drawing decides these" on every run. He said
     「这个很多我刚刚都给过你答案了啊」. The newest ruling is the ruling. */
  const dir = withData({
    aug: { entries: [{ docs: ["HC-SO-012929"], pieces: ["1S", "1A(LHF)", "2A(RHF)"], desc2Match: "Size:26”/Col:Modenza 02 Barley/Bottom wr" }] },
    sep: { entries: [{ docs: ["HC-SO-012929"], pieces: ["1A(LHF)", "2A(RHF)"], desc2Match: "Size:26”/Col:Modenza 02 Barley" }] },
  });
  const hit = makeSofaRulingLookup(dir)("HC-SO-012929", lines('Size:26"/Col:Modenza 02 Barley/Bottom wrap nylon'));
  assert.deepEqual(hit.pieces, ["1A(LHF)", "2A(RHF)"]);
  assert.equal(hit.source, "sofa-compartment-corrections-2026-09.json");
});
