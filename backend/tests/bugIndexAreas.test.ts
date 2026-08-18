/* What the bug index files each entry under, pinned — and the two ways it went
   wrong in bulk.

   WHY THIS IS WORTH A FILE. docs/generated/bug-index.md exists for one job:
   "have we hit this before?" It is the only way into a 9,000-line ledger, and a
   row that points at the wrong subsystem sends the reader somewhere else and
   they conclude there is no prior entry. That failure is silent — the generator
   is green either way, and `audit:bug-index` only checks that the FILE matches
   the GENERATOR, never that the generator is right.

   TWO DEFECTS, both measured 2026-08-14 over 185 entries:

   1. The document abbreviations sat in the case-INSENSITIVE patterns as
      `\bso[- ]`, `\bpo[- ]`, `\bdo[- ]`, which match the English words "so " and
      "do ". Body hits cap at 5, so any entry whose prose says "so the…" five
      times scored a full body hit for Sales orders. 54 entries had no area word
      in their TITLE and were decided by their body; TWENTY of those were decided
      by "so" alone, with no real document reference in them. Fixing it moved 25
      rows out of Sales orders.

   2. There was no area for the repo's OWN machinery. Entries about a ratchet, a
      generator or a test runner carry no subsystem vocabulary, so they scattered
      onto whatever English word matched: the coverage-ratchet entry landed in
      "Auth, permissions" on *scope* and *token*, the codebase-map generator in
      "Fleet, trips" on *route*, and the node:test conversion in "Projects + PMS"
      on *project* — a vitest project.

   AND THE FIX FOR (2) HAD TO BE CORRECTED ONCE, which is the part worth keeping:
   `\bgate\b` was in the new area's pattern for one round and dragged four PRODUCT
   entries in — the confirm gate, the stock-location gate, a permission gate, and
   "A shipped DO's line cost was rebuilt from a ROUNDED unit price", which is
   about money. Houzs calls product features gates. **A word is generic or not
   according to this repo's vocabulary, not English.** */
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const GEN = path.join(ROOT, "backend/scripts/gen-bug-index.mjs");
const INDEX = path.join(ROOT, "docs/generated/bug-index.md");

/* The index is GENERATED and, since 2026-08-18, no longer tracked — a committed
   copy of a file every PR rewrites made every pair of concurrent PRs conflict.
   So this test builds the thing it reads instead of assuming someone committed
   it. That changes nothing about WHAT is asserted below: the subject was always
   the classifier, and the file was only ever how its output was reached. */
function ensureIndex(): void {
  if (fs.existsSync(INDEX)) return;
  execFileSync(process.execPath, [GEN], { cwd: ROOT, stdio: "pipe" });
  assert.ok(fs.existsSync(INDEX), "the generator ran but produced no index — that is a broken generator.");
}

/** area -> [titles], read out of the generated index. */
function indexByArea(): Map<string, string[]> {
  ensureIndex();
  const out = new Map<string, string[]>();
  let area = "";
  for (const line of fs.readFileSync(INDEX, "utf8").split(/\r?\n/)) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { area = h[1].trim(); continue; }
    const r = /^\|\s*\w+\s*\|\s*\[([^\]]+)\]/.exec(line);
    if (r) (out.get(area) ?? out.set(area, []).get(area)!).push(r[1]);
  }
  return out;
}

test("the index parses — this cannot pass by reading nothing", () => {
  const byArea = indexByArea();
  const total = [...byArea.values()].reduce((n, xs) => n + xs.length, 0);
  assert.ok(total > 100, `only ${total} rows parsed out of the index — the extraction is broken, not the index.`);
  assert.ok(byArea.size > 8, `only ${byArea.size} areas parsed.`);
});

/* DEFECT 1. Case-sensitivity is the whole fix, so it is asserted on the SOURCE:
   an `\bso[- ]` back inside a case-insensitive pattern would re-file 20 entries
   and nothing else in CI would notice. */
test("the document abbreviations are matched case-SENSITIVELY", () => {
  const src = fs.readFileSync(GEN, "utf8");
  const areaLines = src.split(/\r?\n/).filter((l) => /^\s*\["/.test(l));
  assert.ok(areaLines.length > 10, `only ${areaLines.length} area rows found in the generator.`);

  for (const line of areaLines) {
    // The /i pattern is the FIRST regex on the row; a case-sensitive one may follow.
    const insensitive = /\[(?:"[^"]+"),\s*(\/.+?\/i)/.exec(line)?.[1] ?? "";
    /* Matched as a PATTERN, not as six literal strings. The first draft of this
       guard listed `"\\bso[- ]"` and friends, and its own red proof slipped
       through: a shell ate the `\b`, the file got a bare `so[- ]` — every bit as
       ruinous — and the guard said nothing. What matters is a lowercase two-letter
       document abbreviation followed by a space-or-hyphen class, however it is
       spelled. */
    const bad = /(?:\\b)?(so|po|do)\[[ -]{2}\]/.exec(insensitive)?.[0];
    if (bad !== undefined) {
      assert.fail(
        `${bad} is inside a case-insensitive pattern:\n  ${line.trim()}\n` +
          'Under /i that matches the English words "so " and "do ". Measured 2026-08-14: ' +
          "556 lowercase-with-space uses of `so` in BUG-HISTORY.md, all of them prose, " +
          "and 20 entries filed to Sales orders on that alone. Put the abbreviation in " +
          "the third, case-SENSITIVE column instead.",
      );
    }
  }
});

/* DEFECT 2, and the correction to its fix. Both are stated as PROPERTIES of the
   finished index rather than as a list of titles, so the assertions survive new
   entries arriving. */
test("entries about the repo's own tooling land in the tooling area, not on a product", () => {
  const byArea = indexByArea();
  const tooling = [...byArea.entries()].find(([a]) => /^Repo tooling/.test(a))?.[1] ?? [];
  assert.ok(tooling.length > 0, "the tooling area is empty — it exists because 15 entries had no home.");

  /* A title that names a repo TOOL belongs there. Deliberately a small, literal
     list: these are tool names, not concepts, which is the distinction the
     `gate` mistake got wrong. */
  const toolWord = /\b(ratchet|linter|eslint|vitest|coverage|generator|working-agreement)\b/i;
  const misplaced: string[] = [];
  for (const [area, titles] of byArea) {
    if (/^Repo tooling/.test(area)) continue;
    for (const t of titles) if (toolWord.test(t)) misplaced.push(`${area} :: ${t}`);
  }
  assert.deepEqual(
    misplaced,
    [],
    "these entries name a repo tool in their TITLE but were filed on a product area:\n  " +
      misplaced.join("\n  "),
  );
});

test("no PRODUCT entry is dragged into the tooling area by a repo-vocabulary word", () => {
  const byArea = indexByArea();
  const tooling = [...byArea.entries()].find(([a]) => /^Repo tooling/.test(a))?.[1] ?? [];

  /* `gate` was in the tooling pattern for exactly one round. Houzs calls product
     features gates — confirm gate, stock-location gate, deposit gate, permission
     gate — and it pulled in four product entries, one of them about money. If a
     title's only tooling-looking word is `gate`, it does not belong here. */
  /* This list was short by two on its first run and flagged "The working-agreement
     gate…" and "The file-size gate…", both of which genuinely belong here. The
     assertion was right about the SHAPE and wrong about the vocabulary — worth
     recording, because it is the same mistake the pattern made, one level up. */
  const realToolWord = /\b(ratchet|linter|eslint|vitest|coverage|generator|test file|test suite|shebang|audit script|derived doc|working-agreement|file-size)/i;
  const onlyGate = tooling.filter((t) => /\bgate\b/i.test(t) && !realToolWord.test(t));
  assert.deepEqual(
    onlyGate,
    [],
    "these are in the tooling area on the word `gate` alone, which in this repo is " +
      "product vocabulary (the confirm gate, the stock-location gate, a permission gate):\n  " +
      onlyGate.join("\n  "),
  );
});

test("an unknown <!-- area: --> tag is refused, not silently guessed", () => {
  const src = fs.readFileSync(GEN, "utf8");
  assert.match(
    src,
    /AREA_NAMES\.has\(tag\)/,
    "the generator no longer validates the area tag. A typo that falls back to the keyword " +
      "guess is worse than no tag: the entry looks declared and is not.",
  );
  assert.match(src, /process\.exit\(1\)/, "an unknown tag must FAIL the generator, not warn.");
});
