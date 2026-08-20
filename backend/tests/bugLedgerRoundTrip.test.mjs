/* The bug ledger is 461 files that RENDER into one document. These pin the
   properties that keep that true, and the reason each one is here.

   THE MIGRATION IS ALREADY PROVED and this test does not re-prove it: on
   2026-08-20 the split from BUG-HISTORY.md was compared against the original
   blob and matched on two independent hashes — the rendered ledger against a
   blank-line-normalised original, and every NON-WHITESPACE byte against the
   original with no normalisation at all. Both are recorded in
   docs/bugs/README.md. That evidence is about a file that no longer exists, so
   it cannot be re-run; what CAN rot from here is the machinery, and that is
   what this file holds.

   node:test-shaped, dependency-free apart from the vitest runner. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUG_DIR,
  ENTRY_FILE_RX,
  parseEntry,
  readEntries,
  renderLedger,
  slugify,
} from "../scripts/lib/bug-ledger.mjs";
import { BUG_ENTRY_DIR, BUG_ENTRY_FILE_RX } from "../../scripts/lib/working-agreement.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the ledger parses, and cannot pass by reading nothing", () => {
  const { entries, skipped } = readEntries(ROOT);
  assert.ok(entries.length > 400, `only ${entries.length} entries read from ${BUG_DIR} — the reader is broken, not the ledger.`);
  assert.deepEqual(
    skipped.filter((n) => n !== "README.md"),
    [],
    "a .md in the ledger directory that is not an entry and not the README is invisible to the ledger, the index AND the working-agreement gate at once.",
  );
});

test("one file is exactly one entry", () => {
  const { entries } = readEntries(ROOT);
  const broken = [];
  for (const e of entries) {
    if (!e.parsed) broken.push(`${e.name}: line 1 is not a \`## Title [severity]\` heading`);
    else if (e.parsed.headingCount > 1) broken.push(`${e.name}: ${e.parsed.headingCount} \`## \` headings`);
  }
  assert.deepEqual(broken, [], broken.join("\n  "));
});

test("the rendered ledger round-trips back to the same entries", () => {
  /* The property the whole layout rests on: rendering N files into one document
     and splitting it again gives the same N entries, in the same order, with the
     same text. If that ever stops holding, the combined view is no longer the
     ledger — it is a lossy summary of it, which is what nobody would notice. */
  const { entries } = readEntries(ROOT);
  const rendered = renderLedger(entries);

  const lines = rendered.split("\n");
  const heads = [];
  lines.forEach((l, i) => { if (/^##\s+\S/.test(l)) heads.push(i); });
  assert.equal(heads.length, entries.length, "the render produced a different number of `## ` headings than there are entries");
  assert.equal(heads[0], 0, "the rendered ledger must open on the newest entry's heading");

  for (let k = 0; k < heads.length; k++) {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const chunk = lines.slice(heads[k], end).join("\n").replace(/\s+$/, "");
    assert.equal(chunk, entries[k].text.replace(/\s+$/, ""), `entry ${entries[k].name} does not survive the round trip`);
  }
});

test("the render is deterministic — the same tree gives the same bytes", () => {
  const a = renderLedger(readEntries(ROOT).entries);
  const b = renderLedger(readEntries(ROOT).entries);
  assert.equal(a, b);
  /* Ordering is total, so two branches picking the SAME ordinal cannot make the
     render depend on readdir order. That case is deliberately allowed — see
     scripts/new-bug.mjs — so it has to be ordered, not prevented. */
  const same = [
    { ordinal: 5, name: "0005-bbb.md", text: "## b [low]\n" },
    { ordinal: 5, name: "0005-aaa.md", text: "## a [low]\n" },
  ];
  const sorted = same.slice().sort((x, y) => y.ordinal - x.ordinal || (x.name < y.name ? 1 : x.name > y.name ? -1 : 0));
  assert.deepEqual(sorted.map((e) => e.name), ["0005-bbb.md", "0005-aaa.md"]);
});

test("no entry file is empty of content", () => {
  const { entries } = readEntries(ROOT);
  const empty = entries.filter((e) => e.parsed && e.parsed.body.trim() === "").map((e) => e.name);
  /* ONE is grandfathered and named rather than tolerated silently: the oldest
     entry arrived from BUG-HISTORY.md as a dangling heading with no body — the
     file ended on it, with no trailing newline. Splitting it faithfully
     preserved a defect that was already there. It is not this test's job to
     invent a body for it, and it IS this test's job to stop a second one. */
  assert.ok(empty.length <= 1, `${empty.length} entries have no body at all:\n  ${empty.join("\n  ")}`);
});

test("the two copies of the ledger's location agree", () => {
  /* `scripts/lib/working-agreement.mjs` must stay dependency-free of backend/,
     so the directory is named in two places. A drift between them is silent in
     the worst way: the gate would look for entries somewhere the ledger is not,
     find none, and pass every pull request. */
  assert.equal(BUG_ENTRY_DIR, `${BUG_DIR}/`);

  /* Compared by BEHAVIOUR over probes, never by regex source: the two patterns
     are written differently on purpose (the ledger's captures the ordinal and
     the slug, the gate's only decides) and a source comparison would fail on a
     harmless edit while passing a meaningful one. */
  for (const [name, accepted] of [
    ["0462-the-thing-broke.md", true],
    ["0001-a.md", true],
    ["12345-a-longer-ordinal.md", true],
    ["README.md", false],
    ["462-three-digits.md", false],
    ["0462-Capitals.md", false],
    ["0462_underscores.md", false],
    ["0462-trailing.txt", false],
    ["0462-.md", false],
  ]) {
    assert.equal(ENTRY_FILE_RX.test(name), accepted, `bug-ledger.mjs disagrees on ${name}`);
    assert.equal(BUG_ENTRY_FILE_RX.test(name), accepted, `working-agreement.mjs disagrees on ${name}`);
  }
});

test("every real entry filename satisfies the gate's own pattern", () => {
  /* The assertion above compares two regexes; this one compares each against the
     TREE, which is the check that survives either being rewritten. */
  const names = fs.readdirSync(path.join(ROOT, BUG_DIR)).filter((n) => n !== "README.md");
  assert.ok(names.length > 400, `only ${names.length} files in ${BUG_DIR}`);
  const rejected = names.filter((n) => !ENTRY_FILE_RX.test(n) || !BUG_ENTRY_FILE_RX.test(n));
  assert.deepEqual(rejected, [], `these filenames are not entries to one of the two readers:\n  ${rejected.join("\n  ")}`);
});

test("slugify produces a filename the readers accept", () => {
  for (const title of [
    "The confirm gate accepted a cancelled PO [high]",
    'A bare "C" (corner) was filtered as noise, so 49 sofa builds lost their corner',
    "2026-08-08",
    "SO -> PO transfer threw the whole header away",
  ]) {
    const name = `0999-${slugify(title)}.md`;
    assert.ok(ENTRY_FILE_RX.test(name), `slugify(${JSON.stringify(title)}) -> ${name}, which is not an entry filename`);
  }
});

test("parseEntry refuses what is not an entry", () => {
  assert.equal(parseEntry("no heading here\n"), null);
  assert.equal(parseEntry("### too deep\n"), null);
  const ok = parseEntry("## A title [critical]\n\nbody\n");
  assert.equal(ok.title, "A title");
  assert.equal(ok.severity, "critical");
  assert.equal(parseEntry("## A title\n").severity, "unspecified");
});
