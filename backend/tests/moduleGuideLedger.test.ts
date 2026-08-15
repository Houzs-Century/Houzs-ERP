/* The module-guide verification ledger lists every guide, and only real guides.

   WHY. docs/MODULE-GUIDE-VERIFICATION.md is the handover for a grind that will
   outlive any one session: which guides have had their BEHAVIOURAL claims checked
   against source, and which have not. Its whole value is that "0 of 27 verified"
   is TRUE.

   A ledger drifts in the direction that flatters it. Add a guide and forget the
   row, and the denominator silently shrinks — 27 unverified quietly reads as 26,
   then 20, and the number that was supposed to show how much is left instead
   hides it. That is the same failure this repo has already paid for twice: a
   count nobody re-derived (632 handlers, then 1019) and a doc nobody regenerated
   (codebase-map-facts, stale three weeks).

   So the ledger is not allowed to be a hand-maintained list. It is checked
   against the directory, both ways. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEDGER = "docs/MODULE-GUIDE-VERIFICATION.md";

const guidesOnDisk = () =>
  fs.readdirSync(path.join(ROOT, "docs/modules")).filter((n) => n.endsWith(".md")).sort();

/** Guides named in the ledger table, from the first cell of each row. */
function guidesInLedger(): string[] {
  const text = fs.readFileSync(path.join(ROOT, LEDGER), "utf8");
  return [...text.matchAll(/^\|\s*`([a-z0-9-]+\.md)`\s*\|/gm)].map((m) => m[1]).sort();
}

test("the ledger parses — it cannot pass by reading nothing", () => {
  const rows = guidesInLedger();
  assert.ok(rows.length >= 20, `only ${rows.length} ledger row(s) parsed — the table shape changed, and this guard is reading it wrong rather than passing.`);
  assert.ok(guidesOnDisk().length >= 20, "docs/modules has almost no guides — check the path before believing this.");
});

test("every guide on disk has a ledger row, and every row is a real guide", () => {
  const disk = guidesOnDisk();
  const ledger = guidesInLedger();

  const missing = disk.filter((g) => !ledger.includes(g));
  assert.deepEqual(
    missing,
    [],
    "these guides exist but are NOT in docs/MODULE-GUIDE-VERIFICATION.md, so the ledger under-reports how " +
      "much is unverified:\n  " + missing.join("\n  ") +
      "\nAdd a row with status `not verified` — that is the honest default, not a failure.",
  );

  const phantom = ledger.filter((g) => !disk.includes(g));
  assert.deepEqual(
    phantom,
    [],
    "the ledger has rows for guides that do not exist:\n  " + phantom.join("\n  ") +
      "\nA ledger counting files that are gone inflates the work remaining as surely as a missing row hides it.",
  );
});

/* `partial` counts as a claim, not as an absence.
   The first real day of verification produced one: sales-order.md is 1,400 lines
   and checking it is several sittings, so the row has to be able to say "some of
   it, and here is which". Left out of the check below, `partial` would be the
   one status that can claim progress and record nothing — and it is the status a
   half-finished session reaches for, which is exactly when the next reader needs
   the PR and the finding most. Anything that is not literally `not verified` now
   owes its evidence. */
const CLAIMS_PROGRESS = (status: string) =>
  /verified|partial/i.test(status) && !/not verified/i.test(status);

test("a row claiming progress names its evidence — a bare `verified` or `partial` is not a verification", () => {
  const text = fs.readFileSync(path.join(ROOT, LEDGER), "utf8");
  const bad: string[] = [];
  for (const m of text.matchAll(/^\|\s*`([a-z0-9-]+\.md)`\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/gm)) {
    const [, guide, status, by, found] = m;
    if (!CLAIMS_PROGRESS(status)) continue;
    /* The method in the ledger's own header requires a PR and a finding. A row
       claiming `verified` with neither is the shape that makes the whole table
       untrustworthy — it looks like progress and records nothing. */
    if (!/#\d+/.test(by) || !found.trim() || found.trim() === "—") {
      bad.push(`${guide}: status "${status.trim()}" but by="${by.trim()}" found="${found.trim()}"`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    "these rows claim verification without naming the PR and what was found:\n  " + bad.join("\n  "),
  );
});
