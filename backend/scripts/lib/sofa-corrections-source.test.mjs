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
  /* The 2026-09 round is eighteen builds. If that number changes the file
     changed, and whoever changed it should say so here.
     15 -> 18 on 2026-09-05: three builds were added to the file without this
     number following them, so the assertion had been RED on main and the
     working-agreement workflow (which runs `node --test scripts/lib/*.test.mjs`
     and reports rather than blocks) had been carrying the failure. Corrected to
     what the file actually holds. */
  assert.equal(bySource.get("sofa-compartment-corrections-2026-09.json"), 18);
});

/**
 * THE FILES MAY NOT DISAGREE ABOUT ONE DOCUMENT.
 *
 * Every file is loaded on every run and they are applied in order, so a
 * document named by two builds with DIFFERENT pieces has no answer — it has
 * whichever answer ran last. Worse, `FILE=2026-08` plans that round alone,
 * which is how the losing answer gets written on its own.
 *
 * WHAT THIS DOES NOT COVER, said plainly because the first draft of this
 * comment claimed otherwise: it keys on the document NUMBER, so it sees a
 * document contradicted by another entry — and it does NOT see the two HALVES
 * of one sofa contradicting each other, because a sales order and the purchase
 * order raised from it are different numbers in different files. That pair is
 * only linked by being the same physical sofa, and nothing in the data says so.
 * The 1ELT test below pins that particular pair by hand for exactly this
 * reason; a new build corrected on only one of its two documents will still get
 * past this check.
 */
test("no two builds give the same document different pieces", () => {
  const seen = new Map();
  for (const b of loadCorrections(DATA).builds) {
    const pieces = (b.pieces || []).map((p) => String(p).trim().toUpperCase()).join("+");
    for (const doc of b.docs || []) {
      /* A document CAN legitimately appear twice — two different builds on one
         document, told apart by desc2Match. Key on both. */
      const key = `${doc} :: ${b.desc2Match ?? ""}`;
      const prev = seen.get(key);
      if (prev && prev.pieces !== pieces) {
        assert.fail(
          `${doc} is given two different builds for the same desc2Match:\n` +
          `  ${prev.source}: ${prev.pieces}\n  ${b.source}: ${pieces}\n` +
          `Correct both, or the round that runs last silently wins.`,
        );
      }
      seen.set(key, { pieces, source: b.source });
    }
  }
});

test("the 1ELT build says L(LHF) on BOTH its documents (owner 2026-09-05)", () => {
  const builds = loadCorrections(DATA).builds
    .filter((b) => (b.desc2Match || "").includes("1 ELT"));
  /* The sales order (2026-09) and the purchase order (2026-08) of one sofa. */
  assert.equal(builds.length, 2, builds.map((b) => `${b.source} ${b.docs.join("/")}`).join(" | "));
  for (const b of builds) {
    assert.deepEqual(
      b.pieces.map((p) => String(p).toUpperCase()),
      ["L(LHF)", "1NA", "2A(RHF)"],
      `${b.source} ${b.docs.join("/")} still carries the retired 1ABOX reading`,
    );
  }
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
