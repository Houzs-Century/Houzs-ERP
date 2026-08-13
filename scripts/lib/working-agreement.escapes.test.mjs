/**
 * node --test scripts/lib/working-agreement.escapes.test.mjs
 *
 * SEVEN WAYS PAST THE WORKING-AGREEMENT GATE, each one executable.
 *
 * These tests assert what the gate does TODAY, not what it should do. Every one
 * of them describes a violation the gate lets through, and every one was first
 * reproduced against real files on `main` — not invented. They are written this
 * way on purpose: the day somebody closes one of these holes, the matching test
 * goes RED and has to be rewritten deliberately, so a hole cannot be closed and
 * silently reopened. A red-team finding that lives only in prose is a finding
 * that gets skipped, which is the same failure the gate itself was built for.
 *
 * NO SHEBANG — see the header of working-agreement.mjs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  addsBugHistoryEntry,
  buildModuleIndex,
  detectFixIntent,
  detectSurfaceChanges,
  evaluate,
  mapPathToGuides,
  parseUnifiedDiff,
} from "./working-agreement.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEMPLATE = fs.readFileSync(path.join(REPO, ".github/pull_request_template.md"), "utf8");

const realGuides = () => {
  const dir = path.join(REPO, "docs/modules");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({ name, text: fs.readFileSync(path.join(dir, name), "utf8") }));
};

const hunk = (file, addedLines, section = "") =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,${addedLines.length} @@ ${section}`,
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");

const verdict = (patch, meta = {}) =>
  evaluate({
    title: meta.title ?? "Ops can clear a stuck processing lease",
    branch: meta.branch ?? "feat/so-lease-clear",
    body: meta.body ?? "Ops asked for this.",
    labels: meta.labels ?? [],
    templateBody: TEMPLATE,
    files: parseUnifiedDiff(patch),
    guides: meta.guides ?? realGuides(),
  });

const SO_ROUTES = "backend/src/scm/routes/mfg-sales-orders.ts";

// ---------------------------------------------------------------------------
// 1. Route + permission, reformatted. Same endpoint, invisible.
// ---------------------------------------------------------------------------

test("ESCAPE 1: a route split across lines with named constants is not a surface change", () => {
  const detected = detectSurfaceChanges(
    parseUnifiedDiff(
      hunk(SO_ROUTES, [
        `mfgSalesOrders.post('/:docNo/force-unlock', requirePermission('scm.so.force_unlock'), async (c) => {`,
      ]),
    )[0],
  );
  assert.deepEqual(
    detected.map((d) => d.kind).sort(),
    ["permission", "route"],
    "the one-line form is caught — this is the control",
  );

  // Byte-for-byte the same endpoint and the same permission, formatted the way
  // prettier formats a registration with two middlewares. `main` already
  // contains 20 route registrations in this shape.
  const evaded = detectSurfaceChanges(
    parseUnifiedDiff(
      hunk(SO_ROUTES, [
        `const FORCE_UNLOCK_ROUTE = '/:docNo/force-unlock';`,
        `const FORCE_UNLOCK_PERM = 'scm.so.force_unlock';`,
        `mfgSalesOrders.post(`,
        `  FORCE_UNLOCK_ROUTE,`,
        `  requirePermission(FORCE_UNLOCK_PERM),`,
        `  async (c) => {`,
      ]),
    )[0],
  );
  assert.deepEqual(evaded, [], "KNOWN GAP: both regexes need the literal on the same line as the call");
});

// ---------------------------------------------------------------------------
// 2. Rule 2 is satisfied by touching the guide, not by updating it.
// ---------------------------------------------------------------------------

test("ESCAPE 2: appending a blank line to the guide turns the FAIL into a PASS", () => {
  const surface = hunk(SO_ROUTES, [
    `mfgSalesOrders.post('/:docNo/force-unlock', requirePermission('scm.so.force_unlock'), async (c) => {`,
  ]);
  assert.equal(verdict(surface).ok, false, "control: the surface change fails");

  const blankLine = hunk("docs/modules/sales-order.md", [""]);
  const r = verdict(`${surface}\n${blankLine}`);
  assert.equal(r.ok, true, "KNOWN GAP: any diff line in the guide counts as updating it");
  assert.match(
    r.findings.find((f) => f.rule === "module-guide").message,
    /the owning guide\(s\) were updated/,
  );
});

// ---------------------------------------------------------------------------
// 3. Rule 1 is satisfied by rewording someone else's heading.
// ---------------------------------------------------------------------------

test("ESCAPE 3: editing an existing BUG-HISTORY heading reports a NEW entry", () => {
  const reworded = addsBugHistoryEntry(
    parseUnifiedDiff(
      hunk("BUG-HISTORY.md", [
        "## The AutoCount write-back never told AutoCount which salesperson sold the order [high]",
      ]),
    ),
  );
  assert.equal(reworded.entry, true, "KNOWN GAP: a rewritten old heading is indistinguishable from a new one");

  // And an empty one is just as good.
  assert.equal(addsBugHistoryEntry(parseUnifiedDiff(hunk("BUG-HISTORY.md", ["## x"]))).entry, true);
});

// ---------------------------------------------------------------------------
// 4. Rule 1's whole weight sits on the branch prefix.
// ---------------------------------------------------------------------------

test("ESCAPE 4: real merged fix PRs that the fix-detector does not flag", () => {
  // Ground truth: each of these MERGED and added a BUG-HISTORY entry, so its
  // author called it a fix. Title and branch carry no fix word.
  const missed = [
    ["Gate the two things a revert cannot undo: migrations and repair scripts", "release-discipline"],
    ["SO: the payment slip is optional everywhere, and from-products can raise a company-1 order again", "so-slip-optional-and-from-products-draft"],
    ["feat(combos): the one table R8 was vendored without", "feat/sofa-combo-anchor-table"],
    ["feat(autocount): open the masters a document names, before the document", "feat/ac-ensure-masters"],
    ["feat(autocount): a conversion names the lines it took, and a removed line is retired", "feat/writeback-all-six"],
  ];
  for (const [title, branch] of missed) {
    assert.equal(
      detectFixIntent({ title, branch, body: "", templateBody: TEMPLATE }).isFix,
      false,
      `KNOWN GAP: "${title}" reads as a fix to a human and not to the gate`,
    );
  }

  // Renaming the branch is the whole trick: 11 of 61 ground-truth fix PRs are
  // caught by the branch name alone.
  const t = "the salesperson roster is keyed on user_id, because email is not a key this data has";
  assert.equal(detectFixIntent({ title: t, branch: "fix/roster", body: "", templateBody: TEMPLATE }).isFix, true);
  assert.equal(detectFixIntent({ title: t, branch: "feat/roster", body: "", templateBody: TEMPLATE }).isFix, false);
});

// ---------------------------------------------------------------------------
// 5. Rules 2 and 3 do not look at scripts, and scripts write to production.
// ---------------------------------------------------------------------------

test("ESCAPE 5: an irreversible schema change shipped as a backend/scripts one-off passes all three rules", () => {
  const r = verdict(
    hunk("backend/scripts/apply-lease-column.mjs", [
      "await c.query(`ALTER TABLE scm.mfg_sales_orders ADD COLUMN processing_lease_by uuid NOT NULL`);",
      "await c.query(`ALTER TYPE scm.so_status ADD VALUE 'LEASE_HELD'`);",
    ]),
    { title: "Give sales orders the processing-lease column ops asked for", branch: "chore/lease-column" },
  );
  assert.equal(r.ok, true);
  assert.equal(r.summary.surfaces.length, 0, "KNOWN GAP: SURFACE_PREFIXES excludes scripts/");
  assert.equal(r.summary.migrations, 0, "KNOWN GAP: rule 3 keys on the migrations-pg PATH, not on SQL");
  // PR #2118's bug lived in exactly this kind of file.
  assert.equal(r.findings.filter((f) => f.level === "fail").length, 0);
});

// ---------------------------------------------------------------------------
// 6. Rule 3 measures length, not truth.
// ---------------------------------------------------------------------------

test("ESCAPE 6: rule 3 accepts a reversal that is false and a verification that is the 0284 failure", () => {
  const r = verdict(hunk("backend/src/db/migrations-pg/0289_so_lease.sql", ["ALTER TABLE scm.mfg_sales_orders ADD COLUMN processing_lease_by uuid;"]), {
    // Reverting the PR does NOT undo an applied migration — that is the whole
    // lesson of 0284 — and "staging" is the replica the rule's own text calls out.
    body: "Reversal: revert this PR and redeploy\nVerified against: the staging database yesterday",
  });
  assert.equal(r.findings.find((f) => f.rule === "migration-notes").level, "pass");
  assert.equal(r.ok, true, "KNOWN GAP: the only tests are >= 12 chars and not a placeholder word");
});

// ---------------------------------------------------------------------------
// 7. The guide index has a zero tripwire, not a ratchet.
// ---------------------------------------------------------------------------

test("ESCAPE 7: archiving 26 of 27 guides downgrades every FAIL to a WARN and still exits 0", () => {
  const surface = hunk(SO_ROUTES, [
    `mfgSalesOrders.post('/:docNo/force-unlock', requirePermission('scm.so.force_unlock'), async (c) => {`,
  ]);
  assert.equal(verdict(surface).ok, false, "control: 27 guides, this fails");

  // One surviving guide that quotes one path clears every self-check in
  // check-working-agreement.mjs: the dir exists, guides.length > 0, mentions > 0.
  const survivor = [{ name: "combo-pricing.md", text: "See `backend/src/scm/lib/combo.ts`." }];
  const r = verdict(surface, { guides: survivor });
  assert.equal(r.ok, true, "KNOWN GAP: nothing asserts the index did not shrink");
  assert.equal(r.findings.find((f) => f.rule === "module-guide").level, "warn");
});

// ---------------------------------------------------------------------------
// The measurement behind escapes 2 and 7: most of the tree is warn-only.
// ---------------------------------------------------------------------------

test("most surface-eligible files are covered by no guide, so their surface changes only WARN", () => {
  const index = buildModuleIndex(realGuides());
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|mts|sql)$/.test(e.name)) out.push(path.relative(REPO, p));
    }
    return out;
  };
  const files = [...walk(path.join(REPO, "backend/src")), ...walk(path.join(REPO, "frontend/src"))].filter(
    (f) => !/(^|\/)(__tests__|__fixtures__|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/.test(f),
  );
  assert.ok(files.length > 500, `only ${files.length} files walked — the scan is broken, not the tree`);
  const unmapped = files.filter((f) => mapPathToGuides(f, index).guides.length === 0).length;
  const pct = (100 * unmapped) / files.length;
  assert.ok(pct > 50, `${pct.toFixed(1)}% unmapped`);
  console.log(`    ${unmapped}/${files.length} (${pct.toFixed(1)}%) surface-eligible files map to no guide -> warn only`);
});
