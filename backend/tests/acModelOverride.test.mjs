/**
 * The owner's declared model override, and the two halves that keep it from
 * becoming a list of excused documents.
 *
 * The case that matters most is THE EXPIRY: change the book's model and the
 * override must stop covering the line, because nobody has decided what the
 * line reads NOW. docs/bugs/0693 is what an unguarded typed model costs — three
 * documents held wrong against the book for a month.
 *
 * NO SHEBANG on the module under test — see its header.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  makeModelOverrideIndex, overrideCovers, splitOwnerModelOverride,
  runSelfTest, selfTestCases, NOTE_MODEL_OVERRIDE,
} from "../scripts/lib/ac-model-override.mjs";

const DECL = { model: "8030", book: "9838 DB", by: "owner", on: "2026-09-08", why: "「那就放8030 daybed把」" };
const BUILD = { docs: ["HC-SO-011657"], model: "8030", modelOverride: { ...DECL, model: undefined }, source: "f.json" };

test("the built-in self-test passes, so the splitter is allowed to run", () => {
  assert.deepEqual(runSelfTest(), []);
});

test("every planted case lands where it does and nowhere else", () => {
  for (const c of selfTestCases()) assert.equal(overrideCovers(c.decl, c.row), c.want, c.name);
});

test("a declaration missing WHO decided it is an ordinary typed model, not an override", () => {
  const idx = makeModelOverrideIndex([{ docs: ["HC-SO-1"], model: "8030", modelOverride: { book: "9838 DB" } }]);
  assert.equal(idx.size, 0);
});

test("a declaration missing the BOOK model it overrides is not an override either", () => {
  const idx = makeModelOverrideIndex([{ docs: ["HC-SO-1"], model: "8030", modelOverride: { by: "owner" } }]);
  assert.equal(idx.size, 0);
});

test("THE EXPIRY — the book changing sends the finding back to DIFFER with no edit", () => {
  const index = makeModelOverrideIndex([BUILD]);
  const still = splitOwnerModelOverride({
    rows: [{ key: "SO-011657", erpNo: "HC-SO-011657", line: "x", acCode: "TNS-9838 DB", erpCode: "8030-STOOL" }],
    index,
  });
  assert.equal(still.moved.length, 1, "while the book still says 9838 it is his decision");
  assert.equal(still.moved[0].decl.by, "owner");

  const changed = splitOwnerModelOverride({
    rows: [{ key: "SO-011657", erpNo: "HC-SO-011657", line: "x", acCode: "TNS-9058 DB", erpCode: "8030-STOOL" }],
    index,
  });
  assert.equal(changed.moved.length, 0, "the book moved, so nobody has decided what it reads now");
  assert.equal(changed.differ.length, 1);
});

test("a finding on ANOTHER document is never covered by this document's declaration", () => {
  const index = makeModelOverrideIndex([BUILD]);
  const r = splitOwnerModelOverride({
    rows: [{ key: "SO-009735", erpNo: "HC-SO-009735", line: "x", acCode: "TNS-9838 DB", erpCode: "8030-STOOL" }],
    index,
  });
  assert.equal(r.moved.length, 0);
  assert.equal(r.differ.length, 1);
});

test("with no declaration loaded NOTHING moves — a silent index must not read as a clean run", () => {
  const r = splitOwnerModelOverride({
    rows: [{ key: "SO-011657", erpNo: "HC-SO-011657", line: "x", acCode: "TNS-9838 DB", erpCode: "8030-STOOL" }],
    index: new Map(),
  });
  assert.equal(r.applied, false);
  assert.equal(r.moved.length, 0);
  assert.equal(r.differ.length, 1);
});

test("the note class is a constant, so the verdict and the reconcile cannot disagree about its name", () => {
  assert.equal(NOTE_MODEL_OVERRIDE, "owner-model-override");
});
