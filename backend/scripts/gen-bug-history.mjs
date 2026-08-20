#!/usr/bin/env node
// Build docs/generated/bug-history.md — the combined, newest-first bug ledger —
// from the one-file-per-entry directory docs/bugs/.
//
// WHY THE LEDGER IS A DIRECTORY NOW. The full trace lives in the header of
// backend/scripts/lib/bug-ledger.mjs. Short version: every entry used to be
// prepended to the same first line of BUG-HISTORY.md, the working agreement
// makes that append MANDATORY on every code PR, and `main` now runs a merge
// QUEUE whose stacking is done by GitHub's git — which does not read this
// repository's `.gitattributes`, so `merge=union` never applied there. Measured
// 2026-08-20: seven entries queued, six UNMERGEABLE, all seven touching
// BUG-HISTORY.md.
//
// GENERATED, never hand-edited, and NOT TRACKED — the same shape
// docs/generated/bug-index.md took on 2026-08-18. A generated copy of the whole
// ledger sitting in git would conflict on exactly the pairs of PRs this change
// exists to unblock, which is to say it would solve nothing.
//
//   npm --prefix backend run gen:bug-history     # write it, then read it
//   npm --prefix backend run audit:bug-history   # CI: the generator still works
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUG_DIR,
  ENTRY_FILE_RX,
  LEDGER_OUT,
  mergeBaseLedger,
  parseEntry,
  readEntries,
  renderLedger,
} from "./lib/bug-ledger.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const checkOnly = process.argv.includes("--check");
const strict = process.argv.includes("--strict");

/* SELF-TEST, before anything is read from disk. A generator whose parser has
   stopped matching produces an empty ledger and reports a clean run, and this
   repo has been bitten by that three times in one day. Assert the two patterns
   this file's whole answer rests on. */
{
  const ok =
    ENTRY_FILE_RX.test("0461-converting-a-sales-order-on-the-phone.md") &&
    !ENTRY_FILE_RX.test("README.md") &&
    !ENTRY_FILE_RX.test("notes.txt") &&
    renderLedger([{ text: "## a [high]\n\nbody\n" }, { text: "## b [low]\n\nbody\n" }]) ===
      "## a [high]\n\nbody\n\n## b [low]\n\nbody\n";
  if (!ok) {
    console.error("gen-bug-history: internal self-test FAILED — not reporting.");
    process.exit(2);
  }
}

const { dir, entries, skipped } = readEntries(repoRoot);

if (!fs.existsSync(dir)) {
  console.error(`gen-bug-history: ${BUG_DIR} does not exist. The ledger is a directory since 2026-08-20.`);
  process.exit(2);
}

/* A .md in this directory that is not an entry and not the README is either a
   typo in a filename — in which case the entry is invisible to the index, the
   ledger and the working-agreement gate all at once — or somebody's stray note.
   Named, never guessed at. */
const strayFiles = skipped.filter((n) => n !== "README.md");

/* A file whose first line is not `## Title`, or that carries a second `## `
   heading, holds something other than exactly one entry. */
const malformed = [];
for (const e of entries) {
  if (!e.parsed) malformed.push({ name: e.name, why: "the first line is not a `## Title [severity]` heading" });
  else if (e.parsed.headingCount > 1)
    malformed.push({ name: e.name, why: `carries ${e.parsed.headingCount} \`## \` headings — one file is one entry` });
}
for (const n of strayFiles) {
  malformed.push({ name: n, why: `does not match the entry filename shape NNNN-slug.md` });
}

/* CHARGED TO WHOEVER INTRODUCED IT, never to whoever is holding the branch.
   `audit:bug-history` runs inside `backend-typecheck`, which IS a required
   status check, so an unconditional refusal here would turn one bad filename on
   `main` into a repo-wide CI blackout — which is precisely what a stray
   `<!-- area: -->` tag did on 2026-08-17 (commit 6c9f8cbd, five of five PR
   branches red for an hour, three of them unrelated). Same rule as
   check-file-size.mjs uses for an inherited ceiling violation: REPORT in full,
   CHARGE only the change in front of you. */
const describe = (p) => `  ${BUG_DIR}/${p.name} — ${p.why}`;
const inherited = [];
const mine = [];
let baseResolved = true;
if (malformed.length) {
  const base = mergeBaseLedger(repoRoot);
  baseResolved = base.resolved;
  for (const p of malformed) {
    const at = base.resolved ? base.read(p.name) : null;
    /* Inherited means the SAME file was ALREADY not-one-entry at the base — read
       and re-judged, not taken from a name list, so a file that was fixed on
       `main` and re-broken here is charged here. A file that did not exist at
       the base is this change's by definition. */
    const wasBroken = at !== null && (() => {
      const q = parseEntry(at);
      return !q || q.headingCount > 1;
    })();
    (wasBroken ? inherited : mine).push(p);
  }
}

if (inherited.length) {
  console.warn(
    `\nBUG LEDGER: ${inherited.length} file(s) under ${BUG_DIR} were already malformed at the merge base — ` +
      `reported, NOT charged to this change:\n${inherited.map(describe).join("\n")}\n` +
      `They are skipped, so the ledger still builds. They should be fixed, but not by whoever is holding this branch.`,
  );
}

if (mine.length) {
  console.error(
    `\nBUG LEDGER: this change leaves ${mine.length} file(s) under ${BUG_DIR} that are not one entry:\n` +
      mine.map(describe).join("\n") +
      `\n\nAn entry file is \`${BUG_DIR}/NNNN-slug.md\`, opening with \`## Title [severity]\` on line 1 and holding\n` +
      `exactly one entry. Scaffold one with \`node scripts/new-bug.mjs "<title>"\`.\n` +
      (baseResolved
        ? ""
        : "The merge base could not be resolved, so every malformed file is charged here — a gate\n" +
          "that cannot tell whose fault it is must not let anything through.\n"),
  );
  process.exit(1);
}

const usable = entries.filter((e) => e.parsed);
const ledger = renderLedger(usable);

if (checkOnly) {
  /* NOTHING IS COMPARED AGAINST A COMMITTED COPY, because there is no committed
     copy — that is the point of the change. What is gated is the failure this
     check exists for: THE GENERATOR DYING. docs/staging-bench-rot-coe.md records
     `audit:map` crashing unnoticed for three weeks. A parse failure throws above,
     a malformed entry file exits 1 above, and an empty ledger is refused below. */
  console.log(
    `Bug ledger generates cleanly (${usable.length} entries across ${BUG_DIR}, ` +
      `${ledger.split("\n").length.toLocaleString()} lines rendered).`,
  );

  /* The generator producing NOTHING is the failure this gate exists for. A scan
     that finds no entries is broken, not clean — the same rule the file-size
     gate encodes for an empty file list. */
  if (usable.length === 0) {
    console.error(`BUG LEDGER: parsed ZERO entries from ${BUG_DIR} — that is a broken generator, not an empty history.`);
    process.exit(2);
  }

  /* A verdict computed over a suspiciously small corpus is worth naming too: the
     ledger only grows, so a collapse is a parser regression rather than a
     tidy-up. REPORTED by default, FAILABLE with `--strict`, the same shape
     derivedDocsDoNotDeadlock.test.mjs requires of every derived-doc generator —
     a soft signal anyone can make hard in a job of their own, without it being
     hard for every author by default. */
  if (usable.length < 400) {
    const thin =
      `BUG LEDGER: only ${usable.length} entries parsed. The split from BUG-HISTORY.md landed 461 on 2026-08-20 ` +
      `and the ledger only grows, so a collapse is a parser regression rather than a tidy-up.\n` +
      `NOT failing the run: the ledger's size is not this author's to answer for, and a floor here would need ` +
      `maintaining, which is how the next stale number gets written. Pass --strict to fail on it.`;
    if (strict) { console.error(thin); process.exit(1); }
    console.warn(thin);
  }
} else {
  const out = path.join(repoRoot, LEDGER_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    `<!-- GENERATED from ${BUG_DIR}/ by backend/scripts/gen-bug-history.mjs. Do not edit by hand;\n` +
      `     edit the entry file. Regenerate: npm --prefix backend run gen:bug-history -->\n\n` +
      ledger,
    "utf8",
  );
  console.log(`Wrote ${LEDGER_OUT} (${usable.length} entries, newest first).`);
}
