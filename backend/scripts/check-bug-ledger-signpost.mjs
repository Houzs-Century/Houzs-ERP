#!/usr/bin/env node
// Refuse a tree that has LEDGER CONTENT back at the ledger's old path.
//
// The ledger is docs/bugs/, one file per entry, since 2026-08-20 (#2567).
// BUG-HISTORY.md is ~40 lines of signpost kept for the ~60 code comments that
// cite it by name. On 2026-08-21 the whole 24,000-line ledger was back at that
// path on `main` and NOTHING went red — #2567 changed the layout and left
// nothing guarding it. This is that guard. The full trace of how a merge does
// this while exiting 0 is in the header of ./lib/bug-ledger.mjs.
//
// Runs inside `backend-typecheck`, which is a REQUIRED status check. An
// advisory workflow would have reported this one exactly as loudly as the
// nothing that reported it on the day.
//
//   npm --prefix backend run audit:bug-signpost
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BUG_DIR, SIGNPOST_PATH, readEntries, signpostViolations } from "./lib/bug-ledger.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/* SELF-TEST, before a single byte is read from disk, and it EXITS rather than
   reports. A matcher that has stopped matching finds nothing and prints a clean
   run, which is indistinguishable from a clean tree — this repo has been bitten
   by that four times, most recently by the very split this file guards. Every
   sample below is synthetic, so the self-test cannot be made to pass by
   changing the tree.

   Note the false-positive probe: the REAL signpost quotes `## 2026-07-20`
   mid-sentence inside backticks, so a matcher that looked anywhere but the
   start of a line would fail this file on its own correct content. */
{
  const titles = ["## A bare corner was filtered as noise [high]", "## The confirm gate accepted a cancelled PO [high]"];
  const good = [
    "# BUG-HISTORY.md moved — the ledger is `docs/bugs/`, one file per entry",
    "",
    "**This file is a signpost, not the ledger.** The entries are in `docs/bugs/`.",
    "The other twenty named date sections — `## 2026-07-20`, `## Earlier` — that a",
    "later restructure removed.",
    "### A sub-heading at level three is fine",
  ].join("\n");
  const resurrected = `${good}\n\n## The confirm gate accepted a cancelled PO [high]\n\n**Symptom.** ...\n`;
  const mangled = `${good}\n\n# A bare corner was filtered as noise [high]\n\nbody\n`;
  const gutted = "# BUG-HISTORY.md moved\n\nnothing here\n";

  const kinds = (t) => signpostViolations(t, titles).map((v) => v.kind);
  const ok =
    kinds(good).length === 0 &&
    kinds(resurrected).includes("entry-heading") &&
    kinds(mangled).includes("known-entry-title") &&
    kinds(gutted).includes("not-a-signpost") &&
    signpostViolations(resurrected, titles)[0].line === 8;
  if (!ok) {
    console.error(
      "check-bug-ledger-signpost: internal self-test FAILED — the matcher no longer\n" +
        "recognises a resurrected ledger, so a clean report from it would mean nothing.\n" +
        `  clean signpost      -> ${JSON.stringify(kinds(good))}   (expected [])\n` +
        `  resurrected ledger  -> ${JSON.stringify(kinds(resurrected))}   (expected to include entry-heading)\n` +
        `  mangled heading     -> ${JSON.stringify(kinds(mangled))}   (expected to include known-entry-title)\n` +
        `  gutted signpost     -> ${JSON.stringify(kinds(gutted))}   (expected to include not-a-signpost)`,
    );
    process.exit(2);
  }
}

const signpost = path.join(repoRoot, SIGNPOST_PATH);
if (!fs.existsSync(signpost)) {
  console.error(
    `${SIGNPOST_PATH} is GONE. It is kept on purpose: ~60 comments in backend/, frontend/ and docs/\n` +
      `cite it by name, and a reader who follows one should land somewhere useful. Restore it with\n` +
      `  git checkout origin/main -- ${SIGNPOST_PATH}`,
  );
  process.exit(1);
}

const { entries } = readEntries(repoRoot);
/* A gate that cannot see the ledger must not pass. With zero entries read, every
   known-entry-title probe is vacuously clean and the check degrades to half of
   itself without saying so. */
if (entries.length === 0) {
  console.error(
    `check-bug-ledger-signpost: read ZERO entries from ${BUG_DIR} — that is a broken reader, not an\n` +
      "empty ledger, and half this check is computed from those entries. Refusing to report a pass.",
  );
  process.exit(2);
}

const text = fs.readFileSync(signpost, "utf8");
const violations = signpostViolations(
  text,
  entries.map((e) => e.text.split("\n")[0]),
);

if (violations.length === 0) {
  console.log(
    `${SIGNPOST_PATH} is still a signpost (${text.split("\n").length} lines, no entry content), ` +
      `and the ledger is ${entries.length} files under ${BUG_DIR}.`,
  );
  process.exit(0);
}

/* CHARGED UNCONDITIONALLY, which is a deliberate departure from every sibling
   gate over this directory (gen-bug-history.mjs, check-file-size.mjs) — those
   excuse a problem that was already present at the merge base so that one bad
   file on `main` cannot black out CI for authors who did not cause it.
   That rule INVERTS here and would excuse exactly the branch that needs
   catching: a branch forked before #2567 has a merge base whose BUG-HISTORY.md
   is the full 24,733-line ledger, so "it was already like that at the base" is
   true of the very case this exists for.
   The blackout risk it trades away is small and different in kind: the repair is
   two commands, both in the author's own tree, and both are printed below. */
const shown = violations.slice(0, 5);
console.error(
  `\n${SIGNPOST_PATH} HOLDS LEDGER CONTENT AGAIN. The ledger is ${BUG_DIR}/, one file per entry;\n` +
    `this path is a signpost and nothing else.\n\n` +
    shown.map((v) => `  ${v.kind === "not-a-signpost" ? "" : `line ${v.line}: `}${v.text.slice(0, 100)}`).join("\n") +
    (violations.length > shown.length ? `\n  ... and ${violations.length - shown.length} more` : "") +
    `\n\nAlmost always this is a MERGE, not something you typed. A branch forked before 2026-08-20\n` +
    `carries \`${SIGNPOST_PATH} merge=union\` in its own .gitattributes, and \`git merge origin/main\`\n` +
    `then resolves the ledger hunk by KEEPING BOTH SIDES — it prints "Auto-merging" and exits 0.\n\n` +
    `TO FIX, in this order, so your own entry is not the thing you throw away:\n` +
    `  1. Copy any entry of yours out of ${SIGNPOST_PATH} — it is at the TOP, above the old ledger.\n` +
    `  2. git checkout origin/main -- ${SIGNPOST_PATH}\n` +
    `  3. node scripts/new-bug.mjs "<your title>" --severity <sev>   # then paste the entry into it\n` +
    `  4. rm -f .git/MERGE_MSG 2>/dev/null; git add ${SIGNPOST_PATH} ${BUG_DIR} && git commit\n\n` +
    `Then check the same thing after your NEXT merge of main. That merge exits 0 too.\n`,
);
process.exit(1);
