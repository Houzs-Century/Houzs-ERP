/* CLAUDE.md's mechanically checkable claims, checked.

   WHY THIS FILE EXISTS. CLAUDE.md is AUTO-LOADED into every session, so a wrong
   sentence in it is not a stale doc — it is a wrong belief installed in everyone
   who works here, before they read a line of code. It has already described the
   database as D1 SQLite for a month after the Postgres cutover, and carried a
   required-status-check list that was simply wrong.

   `check-docs-drift` catches a claim whose PATH is gone. It cannot catch a claim
   about BEHAVIOUR — "CI does not run this" — and that is the shape that misleads,
   because it reads as settled fact and sends the reader in the wrong direction.

   Found 2026-08-15, all four in one file:

     · "CI ... does NOT run `audit:route-locator` or `audit:map`" — `audit:map`
       had been a ci.yml step since the day before. A reader would not regenerate
       the map, and would be surprised by a red PR.
     · the SAME bullet said it twice, in two paragraphs that contradicted each
       other, the second of which began mid-sentence — a paste that never deleted
       what it replaced.
     · a worked drift example ("957 lines against an actual 1118") that no longer
       held. A stale worked example is worse than none: it reads as freshly
       measured evidence.
     · "Treat `skipped` on `backend` as a failed deploy", full stop — over-broad
       in the expensive direction. A docs-only PR legitimately skips that job with
       the RUN concluding success.

   These assertions are deliberately NARROW. There is no general checker for
   prose, and pretending otherwise would produce a gate that fails on wording.
   Each one below pins a claim that was WRONG, against the file that settles it. */
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const CLAUDE = () => read("CLAUDE.md");
const CI = () => read(".github/workflows/ci.yml");

test("the files this guard reads are all present — it cannot pass by reading nothing", () => {
  assert.ok(CLAUDE().length > 5000, "CLAUDE.md is missing or truncated");
  assert.ok(CI().includes("backend-typecheck"), ".github/workflows/ci.yml is not the file this expects");
});

/* The claim that misled. Whichever way CI goes, the table has to follow it. */
test("CLAUDE.md's gated/not-gated table matches what ci.yml actually runs", () => {
  const ci = CI();
  const md = CLAUDE();

  const runsMap = /^\s*-\s*run:.*audit:map\b/m.test(ci);
  const runsLocator = /^\s*-\s*run:.*audit:route-locator\b/m.test(ci);

  /* The table row is `| `codebase-map-facts.md` | YES — ... |`. Read the row,
     not the whole document: the word "YES" appears elsewhere. */
  const row = (artifact: string) =>
    new RegExp(`\\|\\s*\`?${artifact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?\\s*\\|([^|]*)\\|`).exec(md)?.[1] ?? "";

  const mapRow = row("codebase-map-facts.md");
  const locatorRow = row("route-locator.md");
  assert.ok(mapRow.trim(), "CLAUDE.md no longer has a row for codebase-map-facts.md — this guard is reading the wrong shape");
  assert.ok(locatorRow.trim(), "CLAUDE.md no longer has a row for route-locator.md");

  assert.equal(
    /YES/.test(mapRow),
    runsMap,
    `CLAUDE.md says codebase-map-facts.md is ${/YES/.test(mapRow) ? "" : "NOT "}CI-gated; ` +
      `ci.yml ${runsMap ? "DOES" : "does NOT"} run audit:map. ` +
      "This exact sentence was wrong once and sent readers away from regenerating the map.",
  );
  assert.equal(
    /YES/.test(locatorRow),
    runsLocator,
    `CLAUDE.md says route-locator.md is ${/YES/.test(locatorRow) ? "" : "NOT "}CI-gated; ` +
      `ci.yml ${runsLocator ? "DOES" : "does NOT"} run audit:route-locator.`,
  );
});

/* The over-broad rule. `skipped` alone is not a failure; the PAIR is the signal. */
test("the deploy rule distinguishes a failed run from a path-filtered skip", () => {
  const md = CLAUDE();
  assert.ok(
    /run conclusion/.test(md) && /path filter|filter is `backend/.test(md),
    "CLAUDE.md's `backend: skipped` rule no longer explains the run-conclusion pair. " +
      "Stated flatly, that rule calls a docs-only deploy a production failure — measured on #2207.",
  );
  const filter = /backend:\s*\n\s*-\s*'([^']+)'/.exec(read(".github/workflows/deploy.yml"))?.[1];
  assert.equal(filter, "backend/**", "deploy.yml's backend path filter moved — the table in CLAUDE.md names it");
});

/* The claim that pointed at files which no longer exist. */
test("the shebang rule names test files that are actually there", () => {
  const md = CLAUDE();
  const named = /imported by `tests\/(scale\*\.[a-z.]+)`/.exec(md)?.[1];
  assert.ok(named, "CLAUDE.md's shebang rule no longer names the importing tests — this guard is reading the wrong shape");
  const suffix = named.replace("scale*", "");
  const found = fs.readdirSync(path.join(ROOT, "backend/tests")).filter((n) => n.startsWith("scale") && n.endsWith(suffix));
  assert.ok(
    found.length > 0,
    `CLAUDE.md says the three shebang-free scripts are imported by \`tests/${named}\`, and no such file exists. ` +
      "They were renamed to *.test.mjs by #2180 and this line was not updated with them.",
  );
});

/* The three scripts the shebang rule is ABOUT. If one moves into scripts/lib,
   the rule's exception list is wrong and someone will add a shebang to it. */
test("the three shebang-free scripts are still outside scripts/lib", () => {
  for (const f of ["scale-pg-real-schema.mjs", "scale-target-guard.mjs", "repair-so-fee-line-integrity.mjs"]) {
    const direct = fs.existsSync(path.join(ROOT, "backend/scripts", f));
    const inLib = fs.existsSync(path.join(ROOT, "backend/scripts/lib", f));
    assert.ok(
      direct || inLib,
      `CLAUDE.md names backend/scripts/${f} as a test-imported script with no shebang, and it is in neither place.`,
    );
    if (direct) {
      const src = read(`backend/scripts/${f}`);
      assert.ok(!src.startsWith("#!"), `backend/scripts/${f} has grown a shebang — on Windows this breaks at LOAD and CI will not tell you.`);
    }
  }
});
