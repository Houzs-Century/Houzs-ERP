/**
 * node --test scripts/lib/working-agreement.test.mjs
 *
 * Zero dependencies on purpose: the repo root has no test runner and this gate
 * must not acquire one. A checker nobody runs is not a checker, so CI runs this
 * file in the same job as the gate itself.
 *
 * NO SHEBANG — see the header of working-agreement.mjs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  addsBugHistoryEntry,
  buildModuleIndex,
  detectFixIntent,
  detectSurfaceChanges,
  evaluate,
  findObservation,
  findRemedyClaims,
  isCodePath,
  isSurfacePath,
  mapPathToGuides,
  parseUnifiedDiff,
  stripTemplateLines,
} from "./working-agreement.mjs";

const TEMPLATE = "## Regression proof\n\n- [ ] `BUG-HISTORY.md` links the regression evidence for a bug fix.\n";

const diff = (path, added = [], removed = [], section = "") =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,3 +1,3 @@ ${section}`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");

const guides = [
  {
    name: "sales-order.md",
    text: "Detail lives in `backend/src/scm/routes/mfg-sales-orders.ts` and `frontend/src/pages/scm-v2/SalesOrderDetailV2.tsx`.",
  },
  { name: "warehouses.md", text: "See `backend/src/scm/routes/warehouse-racks.ts`." },
];

const base = {
  title: "chore: something",
  branch: "chore/x",
  body: "",
  labels: [],
  templateBody: TEMPLATE,
  guides,
};

// --------------------------------------------------------------------------
test("parseUnifiedDiff keeps the path, the sides and the hunk section", () => {
  const files = parseUnifiedDiff(diff("backend/src/a.ts", ["const x = 1;"], ["const x = 0;"], "export const DO_STATUSES = ["));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "backend/src/a.ts");
  assert.equal(files[0].added[0].text, "const x = 1;");
  assert.equal(files[0].removed[0].text, "const x = 0;");
  assert.equal(files[0].added[0].section, "export const DO_STATUSES = [");
});

test("path classification", () => {
  assert.equal(isCodePath("backend/scripts/repair.mjs"), true, "a script that writes to prod is code");
  assert.equal(isCodePath("docs/modules/quote.md"), false);
  assert.equal(isSurfacePath("backend/src/scm/routes/x.ts"), true);
  assert.equal(isSurfacePath("backend/src/scm/routes/x.test.ts"), false, "a test is not a surface");
  assert.equal(isSurfacePath("backend/src/types.d.ts"), false);
  assert.equal(isSurfacePath("backend/scripts/x.mjs"), false, "a script is not a module surface");
});

// --- rule 1 ---------------------------------------------------------------
test("fix intent reads title, branch and de-templated headings — not prose", () => {
  assert.equal(detectFixIntent({ title: "fix(scm): stat cards", branch: "x", body: "", templateBody: TEMPLATE }).isFix, true);
  assert.equal(detectFixIntent({ title: "add a column", branch: "fix/thing", body: "", templateBody: TEMPLATE }).isFix, true);
  assert.equal(detectFixIntent({ title: "add a column", branch: "feat/x", body: "## The fix\n", templateBody: TEMPLATE }).isFix, true);
  assert.equal(
    detectFixIntent({ title: "add a column", branch: "feat/x", body: "This grew out of a bug we saw.\n", templateBody: TEMPLATE }).isFix,
    false,
    "body PROSE is not a signal",
  );
});

test("the PR template's own words do not make every PR a fix", () => {
  const body = TEMPLATE;
  assert.match(body, /bug fix/, "guard: the template really does contain fix words");
  assert.equal(detectFixIntent({ title: "feat: x", branch: "feat/x", body, templateBody: TEMPLATE }).isFix, false);
  assert.equal(stripTemplateLines(body, TEMPLATE).trim(), "");
});

test("word boundaries: debug and 500ms are not fix signals", () => {
  assert.equal(detectFixIntent({ title: "add debug logging at 500ms", branch: "feat/x", body: "", templateBody: TEMPLATE }).isFix, false);
  assert.equal(detectFixIntent({ title: "the endpoint 500s", branch: "feat/x", body: "", templateBody: TEMPLATE }).isFix, false);
  assert.equal(detectFixIntent({ title: "returns 500 on empty", branch: "feat/x", body: "", templateBody: TEMPLATE }).isFix, true);
});

test("a BUG-HISTORY entry is a new heading, not a touched file", () => {
  assert.equal(addsBugHistoryEntry(parseUnifiedDiff(diff("BUG-HISTORY.md", ["typo"]))).entry, false);
  const ok = addsBugHistoryEntry(parseUnifiedDiff(diff("BUG-HISTORY.md", ["## The thing broke [high]"])));
  assert.equal(ok.entry, true);
  assert.equal(ok.heading, "## The thing broke [high]");
});

test("rule 1 fails a fix that changes code without an entry, and the escape says why", () => {
  const files = parseUnifiedDiff(diff("backend/scripts/repair.mjs", ["const fixed = true;"]));
  const bad = evaluate({ ...base, title: "fix the repair script", branch: "fix/x", files });
  assert.equal(bad.ok, false);
  assert.equal(bad.findings.filter((f) => f.level === "fail" && f.rule === "bug-history").length, 1);

  const escaped = evaluate({ ...base, title: "fix the repair script", branch: "fix/x", labels: ["no-bug-history-needed"], files });
  assert.equal(escaped.ok, true);
  const esc = escaped.findings.find((f) => f.level === "escape");
  assert.match(esc.message, /SKIPPED by label/);
  assert.match(esc.message, /NO BUG-HISTORY.md entry/, "an escape must PRINT the violation it waives");

  const logged = evaluate({
    ...base,
    title: "fix the repair script",
    branch: "fix/x",
    files: [...files, ...parseUnifiedDiff(diff("BUG-HISTORY.md", ["## The repair script double-encoded jsonb [high]"]))],
  });
  assert.equal(logged.ok, true);
});

test("rule 1 ignores a fix that touches no code", () => {
  const files = parseUnifiedDiff(diff("docs/CODEBASE-MAP.md", ["fix the wrong line count"]));
  assert.equal(evaluate({ ...base, title: "docs: fix a wrong count", files }).ok, true);
});

// --- rule 2 ---------------------------------------------------------------
test("surface: a new route registration", () => {
  const f = parseUnifiedDiff(diff("backend/src/scm/routes/mfg-sales-orders.ts", ['app.post("/:docNo/unlock", requireX, async (c) => {']))[0];
  const found = detectSurfaceChanges(f);
  assert.deepEqual(found.map((x) => x.kind), ["route"]);
  assert.match(found[0].detail, /POST \/:docNo\/unlock/);
});

test("surface: a new permission string, on either side of the wire", () => {
  const be = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/scm/routes/a.ts", ['router.get("/x", requirePermission("scm.so.unlock"), h);']))[0]);
  assert.ok(be.some((x) => x.kind === "permission" && x.detail === "scm.so.unlock"));
  const fe = detectSurfaceChanges(parseUnifiedDiff(diff("frontend/src/pages/a.tsx", ['{can("scm.so.unlock") && <Button />}']))[0]);
  assert.ok(fe.some((x) => x.kind === "permission" && x.detail === "scm.so.unlock"));
  const cat = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/services/permissions.ts", ['  { key: "scm.so.unlock", resource: "SCM", verb: "manage" },']))[0]);
  assert.ok(cat.some((x) => x.kind === "permission"));
});

test("surface: a moved route is not a new route", () => {
  const f = parseUnifiedDiff(
    diff("backend/src/scm/routes/a.ts", ['  app.get("/summary", handler);'], ['app.get("/summary", handler);']),
  )[0];
  assert.deepEqual(detectSurfaceChanges(f), []);
});

test("surface: a new status value, by declaration and by hunk section", () => {
  const decl = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/scm/shared/s.ts", ["export const DO_STATUSES = ['DRAFT', 'VOID'] as const;"]))[0]);
  assert.ok(decl.some((x) => x.kind === "status"));
  const member = detectSurfaceChanges(
    parseUnifiedDiff(diff("backend/src/scm/shared/s.ts", ["  'PART_SHIPPED',"], [], "export const DO_STATUSES = ["))[0],
  );
  assert.ok(member.some((x) => x.kind === "status" && x.detail.startsWith("PART_SHIPPED")));
  const sql = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/db/migrations-pg/0287_x.sql", ["ALTER TYPE do_status ADD VALUE 'PART_SHIPPED';"]))[0]);
  assert.ok(sql.some((x) => x.kind === "status"));
});

test("surface: `const state = ...` is a local, not a status declaration", () => {
  const f = parseUnifiedDiff(diff("backend/src/scm/lib/so-location-gate.ts", ["  const state = String(facts.customerState ?? '').trim();"]))[0];
  assert.deepEqual(detectSurfaceChanges(f), [], "the /i flag that made this fire was PR #2112's false positive");
});

test("surface: comments cannot move a surface", () => {
  const f = parseUnifiedDiff(diff("backend/src/scm/lib/a.ts", ["// A State with no state_warehouse_mappings row derives no warehouse.", "  // app.get('/x', h)"]))[0];
  assert.deepEqual(detectSurfaceChanges(f), []);
});

test("surface: a field becoming or ceasing to be required", () => {
  const req = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/scm/shared/r.ts", ["  itemCode: string | null,"], ["  itemCode?: string,"]))[0]);
  assert.ok(req.some((x) => x.kind === "required-field" && /itemCode became REQUIRED/.test(x.detail)));
  const opt = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/scm/shared/r.ts", ["  itemCode: z.string().optional(),"], ["  itemCode: z.string(),"]))[0]);
  assert.ok(opt.some((x) => x.kind === "required-field" && /itemCode became OPTIONAL/.test(x.detail)));
  const sql = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/db/migrations-pg/0287_x.sql", ["ALTER TABLE scm.so ALTER COLUMN item_code SET NOT NULL;"]))[0]);
  assert.ok(sql.some((x) => x.kind === "required-field"));
});

test("surface: a new lock", () => {
  const f = detectSurfaceChanges(parseUnifiedDiff(diff("backend/src/scm/lib/a.ts", ["  const row = await sql`SELECT 1 FROM scm.so WHERE id = ${id} FOR UPDATE`;"]))[0]);
  assert.ok(f.some((x) => x.kind === "lock"));
});

test("the module index is built from the guides' own quoted paths", () => {
  const index = buildModuleIndex(guides);
  assert.equal(index.mentions, 3);
  assert.deepEqual(mapPathToGuides("backend/src/scm/routes/mfg-sales-orders.ts", index).guides, ["sales-order"]);
  assert.deepEqual(mapPathToGuides("backend/src/scm/routes/warehouse.ts", index).guides, ["warehouses"], "stem fallback");
  assert.deepEqual(mapPathToGuides("backend/src/scm/lib/nothing-owns-me.ts", index).guides, []);
});

test("rule 2 fails a surface change whose guide was not updated, passes when it was", () => {
  const route = diff("backend/src/scm/routes/mfg-sales-orders.ts", ['app.post("/:docNo/unlock", handler);']);
  const bad = evaluate({ ...base, files: parseUnifiedDiff(route) });
  assert.equal(bad.ok, false);
  const fail = bad.findings.find((f) => f.level === "fail" && f.rule === "module-guide");
  assert.match(fail.detail, /docs\/modules\/sales-order\.md/);

  const good = evaluate({
    ...base,
    files: parseUnifiedDiff(`${route}\n${diff("docs/modules/sales-order.md", ["POST /:docNo/unlock — releases the edit lease."])}`),
  });
  assert.equal(good.ok, true);

  const escaped = evaluate({ ...base, labels: ["no-guide-change"], files: parseUnifiedDiff(route) });
  assert.equal(escaped.ok, true);
  assert.match(escaped.findings.find((f) => f.level === "escape").message, /sales-order\.md/);
});

test("rule 2 WARNS, never fails, where no guide exists — and names the module", () => {
  const r = evaluate({ ...base, files: parseUnifiedDiff(diff("backend/src/scm/routes/pallets.ts", ['app.get("/pallets", handler);'])) });
  assert.equal(r.ok, true, "a missing guide is a pre-existing gap, not this PR's regression");
  const warn = r.findings.find((f) => f.level === "warn");
  assert.match(warn.detail, /docs\/modules\/pallet\.md/);
});

// --- rule 3 ---------------------------------------------------------------
test("rule 3 demands a stated reversal and a stated verification", () => {
  const files = parseUnifiedDiff(diff("backend/src/db/migrations-pg/0287_rename.sql", ["ALTER TABLE scm.so RENAME COLUMN a TO b;"]));
  assert.equal(evaluate({ ...base, files }).ok, false);
  assert.equal(
    evaluate({ ...base, body: "Reversal: rename b back to a; nothing reads b yet.\nVerified against: the live catalog via pg-catalog-check.yml.", files }).ok,
    true,
  );
  assert.equal(
    evaluate({ ...base, body: "Rollback: TBD\nVerified against: a replica", files }).ok,
    false,
    "placeholders and one-word answers are not statements",
  );
  assert.equal(
    evaluate({ ...base, body: "Reversal: rename b back to a, nothing reads it.", files }).ok,
    false,
    "reversal alone is not enough — the 0284 rename was reversible and still wrong",
  );
});

test("a migration NUMBER is not a module name", () => {
  const index = buildModuleIndex(guides);
  assert.deepEqual(mapPathToGuides("backend/src/db/migrations-pg/0287_scm_so_audit.sql", index).stem, null);
  const r = evaluate({
    ...base,
    body: "Reversal: drop the column.\nVerified against: the live catalog.",
    files: parseUnifiedDiff(diff("backend/src/db/migrations-pg/0287_scm_so_audit.sql", ["ALTER TABLE scm.mfg_sales_orders ALTER COLUMN doc_no SET NOT NULL;"])),
  });
  const warn = r.findings.find((f) => f.level === "warn");
  assert.doesNotMatch(warn.detail, /0287/, "must not propose docs/modules/0287_....md");
  assert.match(warn.detail, /scm\.mfg_sales_orders/, "name the table instead");
});

test("rule 3 has no label escape, and no migration means no demand", () => {
  const files = parseUnifiedDiff(diff("backend/src/db/migrations-pg/0287_x.sql", ["ALTER TABLE scm.so ADD COLUMN b text;"]));
  assert.equal(evaluate({ ...base, labels: ["no-guide-change", "no-bug-history-needed"], files }).ok, false);
  assert.equal(evaluate({ ...base, files: parseUnifiedDiff(diff("backend/src/db/migrations/0287_x.sql", ["ALTER TABLE x ADD COLUMN b text;"])) }).ok, true);
});

/* LOGIC changes, not only surface ones (owner 2026-08-18). These three cases are
   the whole rule: a rule change in a documented file FAILS, the same change with
   the guide updated PASSES, and a comment-only edit says nothing at all.

   The middle one matters as much as the first. A gate that cannot be satisfied
   is a gate people route around, and the escape label already exists for the
   cases where the guide genuinely does not need to move. */
test("rule 2 fails a LOGIC change in a documented file, even with no surface change", () => {
  /* No route, no permission, no status, no required flip, no lock — just a rule
     that now reads a different column. detectSurfaceChanges sees nothing here. */
  const logic = diff("backend/src/scm/routes/mfg-sales-orders.ts", [
    "  const brand = product.branding ?? line.branding;",
  ], [
    "  const brand = line.branding ?? product.branding;",
  ]);

  const bad = evaluate({ ...base, files: parseUnifiedDiff(logic) });
  assert.equal(bad.ok, false, "a documented file whose logic moved must ask for its guide");
  const fail = bad.findings.find((f) => f.level === "fail" && f.rule === "module-guide");
  assert.match(fail.message, /guide that documents it was not updated/);
  assert.match(fail.detail, /docs\/modules\/sales-order\.md/);

  const good = evaluate({
    ...base,
    files: parseUnifiedDiff(`${logic}
${diff("docs/modules/sales-order.md", ["Branding now reads the SKU first."])}`),
  });
  assert.equal(good.ok, true, "updating the guide has to be enough, or the gate is unsatisfiable");
});

test("rule 2 stays silent on a comment-only edit to a documented file", () => {
  /* The false-positive that would get this gate deleted: fixing a typo in a
     comment is not a logic change, and must not demand a doc update. */
  const commentOnly = diff("backend/src/scm/routes/mfg-sales-orders.ts", [
    "  /* Reads the SKU first — owner 2026-08-18. */",
    "",
  ], [
    "  /* Reads the SKU frist — owner 2026-08-18. */",
  ]);
  const res = evaluate({ ...base, files: parseUnifiedDiff(commentOnly) });
  assert.equal(res.ok, true);
  assert.equal(res.findings.some((f) => f.level === "fail" && f.rule === "module-guide"), false);
});

test("rule 2 ignores a file no guide quotes, so the gate cannot spread on its own", () => {
  /* Scope is the 343 files a guide names BY PATH. A file nobody documented is
     not this PR's debt, and failing it would make the gate everyone's problem. */
  const undocumented = diff("backend/src/scm/lib/some-undocumented-helper.ts", [
    "  return rows.filter((r) => r.active);",
  ]);
  const res = evaluate({ ...base, files: parseUnifiedDiff(undocumented) });
  assert.equal(res.findings.some((f) => f.level === "fail" && f.rule === "module-guide"), false);
});

// --------------------------------------------------------------------------
// Rule 4 — a remedy claim needs the run that proved it
// --------------------------------------------------------------------------

/* The two strings below are QUOTED FROM THE REPO, not invented for the test.
   The first is the sentence that cost a salesperson a working day; the second
   is the correction that replaced it. A gate whose fixtures are written by the
   same person who wrote the regex proves only that the regex is self-consistent,
   so these are the real ones and they are checked in both directions. */
const THE_CLAIM_THAT_SHIPPED = [
  '    console.log("   still be reporting successful runs — it counts per-row failures and");',
  '    console.log("   carries on. Run the pull in \'all\' mode: pull.ts:29 says that path");',
  '    console.log("   uses /getAll and does NOT touch the checkpoint, so it is the clean");',
  '    console.log("   way to collect a backlog without unfreezing anything by hand.");',
].join("\n");

const THE_CORRECTION = [
  "**`all` DOES NOT WORK on this book, and that was measured rather than reasoned.**",
  "Dispatched against production 2026-08-19: 39 seconds, then HTTP 503",
  "`Worker exceeded resource limits`. `getAll()` over ~13,000 orders cannot fetch and",
  "upsert inside one Cloudflare Worker request.",
].join("\n");

test("rule 4 fires on the real sentence that shipped, and stays silent on its correction", () => {
  const claims = findRemedyClaims(THE_CLAIM_THAT_SHIPPED);
  assert.equal(claims.length, 1, "the claim that cost a day must be detected");
  assert.match(claims[0].text, /Run the pull in 'all' mode/);

  assert.deepEqual(findRemedyClaims(THE_CORRECTION), [], "a correction must not read as a claim");
});

test("rule 4 does not fire on a mention of an operation that prescribes nothing", () => {
  /* The first draft of this detector fired here — `\brun\b` matched the noun.
     A gate that flags narration is a gate that gets routed around. */
  assert.deepEqual(
    findRemedyClaims("the job kept reporting a normal-looking run. The INSERT is fixed now."),
    [],
  );
  assert.deepEqual(findRemedyClaims("Running the migration is what BROKE it."), []);
  assert.deepEqual(findRemedyClaims("Should I run the backfill to fix this?"), [], "a question asserts nothing");
});

test("rule 4 reads a claim split across lines, because that is how it was written", () => {
  /* Same-line matching missed the real defect: the instruction and the promise
     were four console.log lines apart. */
  const split = "Re-run the sync.\nThat collects everything the checkpoint skipped.";
  assert.equal(findRemedyClaims(split).length, 1);
});

test("rule 4 ignores fenced blocks — the evidence is not the claim", () => {
  const withFence = ["```", "Run the pull in all mode; it collects the backlog", "```"].join("\n");
  assert.deepEqual(findRemedyClaims(withFence), []);
});

test("rule 4 fails a body that prescribes a remedy with no sign it was run", () => {
  const body = "`?mode=all` is the clean way to collect a backlog — just run it against production.";
  const res = evaluate({ ...base, body, files: [] });
  assert.equal(res.ok, false);
  assert.equal(res.findings.filter((f) => f.level === "fail" && f.rule === "remedy-claim").length, 1);
});

test("rule 4 passes when the author pasted what they observed", () => {
  const body = [
    "`?mode=all` is the clean way to collect a backlog — just run it against production.",
    "",
    "Observed: dispatched 2026-08-19, 39s then HTTP 503 Worker exceeded resource limits.",
  ].join("\n");
  const res = evaluate({ ...base, body, files: [] });
  assert.equal(res.findings.some((f) => f.level === "fail" && f.rule === "remedy-claim"), false);
  assert.equal(res.findings.some((f) => f.level === "pass" && f.rule === "remedy-claim"), true);
});

test("an observation must show something LOOKED AT, not a restatement", () => {
  assert.equal(findObservation("Observed: it works fine"), null, "no outcome token, and too short");
  assert.equal(findObservation("Observed: <fill this in>"), null, "a placeholder is not evidence");
  assert.ok(findObservation("Observed: returned 200 with 362 rows fetched"));
  assert.ok(findObservation("Measured: took 39s then errored out"));
});

test("rule 4 escapes are on the record, never silent", () => {
  const claim = "Just re-run the importer and it recovers the missing rows.";
  const byLabel = evaluate({ ...base, body: claim, labels: ["remedy-untested"], files: [] });
  assert.equal(byLabel.ok, true);
  const esc = byLabel.findings.find((f) => f.level === "escape" && f.rule === "remedy-claim");
  assert.ok(esc, "the label must produce an ESCAPE finding, not silence");
  assert.match(esc.message, /re-run the importer/, "the waived claim is printed verbatim");

  const inline = evaluate({ ...base, body: `${claim} (UNTESTED)`, files: [] });
  assert.equal(inline.ok, true);
  assert.ok(inline.findings.some((f) => f.level === "escape" && f.rule === "remedy-claim"));
});

test("rule 4 WARNS, never fails, on a guide or check script — and never on other files", () => {
  /* Warn, for the same reason rule 2 warns on an unmapped guide: a gate that
     fails on prose gets deleted. The claim still lands in the log, which is
     what the module guide correction missed when it left the identical
     sentence printing in the check script's own verdict. */
  const guide = diff("docs/modules/system-health.md", [
    "Run it in `all` mode and it collects the whole backlog.",
  ]);
  const res = evaluate({ ...base, files: parseUnifiedDiff(guide) });
  assert.equal(res.ok, true, "a doc claim must not block");
  assert.equal(res.findings.filter((f) => f.level === "warn" && f.rule === "remedy-claim").length, 1);

  const script = diff("backend/scripts/check-autocount-pull-health.mjs", [
    '  console.log("Run the pull in all mode; it collects the backlog.");',
  ]);
  assert.equal(
    evaluate({ ...base, files: parseUnifiedDiff(script) })
      .findings.filter((f) => f.level === "warn" && f.rule === "remedy-claim").length,
    1,
  );

  /* Ordinary source is NOT scanned. Prose lives in guides and in the read-only
     checks whose output is advice to a human; everywhere else this would be
     noise on every PR. */
  const src = diff("backend/src/services/pull.ts", [
    "  // Run it in all mode and it collects the backlog.",
  ]);
  assert.equal(
    evaluate({ ...base, files: parseUnifiedDiff(src) })
      .findings.some((f) => f.rule === "remedy-claim" && f.level === "warn"),
    false,
  );
});

test("the PR template itself can never trip rule 4", () => {
  /* The failure this prevents is not hypothetical in this file: the template's
     own word "fix" once made detectFixIntent report EVERY pull request as a
     fix. A prescriptive sentence in the template would do the same to rule 4,
     and "every PR is red" is how a gate gets deleted. Read from the real file
     on disk, so editing the template re-runs this check. */
  const template = readFileSync(new URL("../../.github/pull_request_template.md", import.meta.url), "utf8");
  assert.deepEqual(findRemedyClaims(template), [], "the template must contain no remedy claim");

  const untouched = evaluate({
    title: "chore: x",
    branch: "chore/x",
    body: template,
    labels: [],
    templateBody: template,
    files: [],
    guides,
  });
  assert.equal(untouched.findings.some((f) => f.rule === "remedy-claim" && f.level === "fail"), false);
});
