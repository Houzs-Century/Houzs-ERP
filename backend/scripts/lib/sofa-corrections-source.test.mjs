import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CORRECTION_FILES, loadCorrections, readCorrectionsDoc } from "./sofa-corrections-source.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "data");

test("reads `corrections` (2026-08) and `entries` (2026-09) alike", () => {
  assert.deepEqual(
    readCorrectionsDoc({ corrections: [{ docs: ["A"] }] }, "old.json").builds.map((b) => b.docs[0]),
    ["A"],
  );
  assert.deepEqual(
    readCorrectionsDoc({ entries: [{ docs: ["B"] }] }, "new.json").builds.map((b) => b.docs[0]),
    ["B"],
  );
});

test("a file carrying both names contributes both, in that order", () => {
  const got = readCorrectionsDoc({ corrections: [{ docs: ["A"] }], entries: [{ docs: ["B"] }] }, "f");
  assert.deepEqual(got.builds.map((b) => b.docs[0]), ["A", "B"]);
});

test("every build is tagged with the file it came from", () => {
  const got = readCorrectionsDoc({ entries: [{ docs: ["B"] }] }, "new.json");
  assert.equal(got.builds[0].source, "new.json");
});

test("_held is carried too, so a held build keeps being printed", () => {
  const got = readCorrectionsDoc({ _held: [{ docs: ["X"], why: "no photo" }] }, "f");
  assert.equal(got.held.length, 1);
  assert.equal(got.held[0].source, "f");
});

test("a file with neither key contributes nothing rather than throwing", () => {
  assert.deepEqual(readCorrectionsDoc({ _note: "x" }, "f"), { builds: [], held: [] });
  assert.deepEqual(readCorrectionsDoc(null, "f"), { builds: [], held: [] });
});

test("BOTH real files load, and the 2026-08 round is still there", () => {
  const both = loadCorrections(DATA);
  assert.equal(both.files.length, CORRECTION_FILES.length, both.files.join(" | "));
  const bySource = new Map();
  for (const b of both.builds) bySource.set(b.source, (bySource.get(b.source) ?? 0) + 1);
  for (const f of CORRECTION_FILES) assert.ok(bySource.get(f) > 0, `${f} contributed no builds`);
  /* The 2026-09 round is fifteen builds. If that number changes the file
     changed, and whoever changed it should say so here. */
  assert.equal(bySource.get("sofa-compartment-corrections-2026-09.json"), 15);
});

test("every build in every file names its documents, its pieces and a desc2Match", () => {
  for (const b of loadCorrections(DATA).builds) {
    const where = `${b.source} ${(b.docs || []).join("/")}`;
    assert.ok(Array.isArray(b.docs) && b.docs.length, `${where}: no docs`);
    assert.ok(Array.isArray(b.pieces) && b.pieces.length, `${where}: no pieces`);
    /* A `why` is required but not a length: the 2026-08 round has one that
       reads exactly "owner" (HC-SO-011733), and that is a complete answer. */
    assert.ok(typeof b.why === "string" && b.why.trim() !== "", `${where}: no why`);
    /* A document can hold several builds, and desc2Match is the ONLY thing that
       tells them apart. A build without one claims the whole document. */
    assert.ok(b.desc2Match, `${where}: no desc2Match`);
  }
});

test("the `only` filter loads one round without replanning the other", () => {
  const one = loadCorrections(DATA, "2026-09");
  assert.equal(one.files.length, 1);
  assert.ok(one.builds.every((b) => b.source.includes("2026-09")));
});
