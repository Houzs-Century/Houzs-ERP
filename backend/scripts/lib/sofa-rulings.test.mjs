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

test("desc2Exclude keeps the SECOND sofa's ruling off the FIRST sofa's lines", () => {
  /* HC-SO-012025, prod 2026-09-08. The two sofas' texts differ only by a
     LEADING SPACE, so the second build's needle ("all adjustable arm rest") is
     carried by the first build's lines too. Without the exclusion the newest
     ruling wins for BOTH, and the four-piece sofa would be reported as if the
     owner had ruled it a single seater. */
  const dir = withData({
    sep: {
      entries: [
        { docs: ["HC-SO-012025"], pieces: ["1A(LHF)", "1NA", "CNR", "1A(RHF)"], desc2Match: " bottom to Nilon" },
        { docs: ["HC-SO-012025"], pieces: ["1S"], desc2Match: "all adjustable arm rest", desc2Exclude: " bottom to Nilon" },
      ],
    },
  });
  const look = makeSofaRulingLookup(dir);
  const first = look("HC-SO-012025", lines(" bottom to Nilon  \n30 inch , all adjustable arm rest  \ncolour :GD2502# 18- GREY"));
  assert.deepEqual(first.pieces, ["1A(LHF)", "1NA", "CNR", "1A(RHF)"]);
  const second = look("HC-SO-012025", lines("bottom to Nilon  \n30 inch , all adjustable arm rest  \ncolour :GD2502# 18- GREY"));
  assert.deepEqual(second.pieces, ["1S"]);
});

test("desc2Exclude is byte-exact — normalising would erase the leading space it turns on", () => {
  const dir = withData({
    sep: { entries: [{ docs: ["HC-SO-012025"], pieces: ["1S"], desc2Match: "adjustable", desc2Exclude: " bottom to Nilon" }] },
  });
  const look = makeSofaRulingLookup(dir);
  assert.equal(look("HC-SO-012025", lines(" bottom to Nilon \nadjustable")), null);
  assert.deepEqual(look("HC-SO-012025", lines("bottom to Nilon \nadjustable")).pieces, ["1S"]);
});
