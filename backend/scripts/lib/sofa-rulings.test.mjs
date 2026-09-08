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

/* ── A BUILD SELECTED BY ITS LINE KEY ────────────────────────────────────────
 * Two of the last six sales-order differences hold the build on rows that carry
 * NO Desc2, so no needle can reach them and the entry is keyed on the AutoCount
 * DtlKey instead. The reporter has to honour the same key the writer does, or a
 * build that IS written keeps reading DIFFER — which is bug 0714 all over
 * again, one file later.
 */
test("LINE KEY: a keyed ruling is found on the row carrying that DtlKey", () => {
  const dir = withData({
    sep: { entries: [{ docs: ["HC-SO-011221"], pieces: ["2A(LHF)", "1A(RHF)"], dtlKey: "775621", why: "book" }] },
  });
  const look = makeSofaRulingLookup(dir);
  /* The reconcile aliases the column to `ac_dtlkey`; a caller reading the table
     directly has `linked_ac_dtlkey`. Both spellings must resolve. */
  assert.deepEqual(look("HC-SO-011221", [{ ac_dtlkey: "775621" }]).pieces, ["2A(LHF)", "1A(RHF)"]);
  assert.deepEqual(look("HC-SO-011221", [{ linked_ac_dtlkey: 775621 }]).pieces, ["2A(LHF)", "1A(RHF)"]);
});

test("LINE KEY: the ruling never reaches the document's OTHER book line", () => {
  const dir = withData({
    sep: {
      entries: [
        { docs: ["HC-SO-005082"], pieces: ["2379-3S"], dtlKey: "358016", why: "book" },
        { docs: ["HC-SO-005082"], pieces: ["2379-2S"], dtlKey: "358017", why: "book" },
      ],
    },
  });
  const look = makeSofaRulingLookup(dir);
  assert.deepEqual(look("HC-SO-005082", [{ ac_dtlkey: "358016" }]).pieces, ["2379-3S"]);
  assert.deepEqual(look("HC-SO-005082", [{ ac_dtlkey: "358017" }]).pieces, ["2379-2S"]);
  /* A third line of the same document is nobody's ruling. */
  assert.equal(look("HC-SO-005082", [{ ac_dtlkey: "358018" }]), null);
});

test("LINE KEY: a keyed entry is not blessed by a document that only shares its number", () => {
  const dir = withData({
    sep: { entries: [{ docs: ["HC-SO-011221"], pieces: ["2A(LHF)"], dtlKey: "775621", why: "book" }] },
  });
  const look = makeSofaRulingLookup(dir);
  /* No key on the lines at all: the entry names one, so it must not match. */
  assert.equal(look("HC-SO-011221", [{ description2: "anything" }]), null);
});
