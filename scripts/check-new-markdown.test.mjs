import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify } from "./check-new-markdown.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("allowed places pass", () => {
  const v = classify([
    "docs/modules/scm.md", "docs/bugs/README.md", "tasks/TODO.md", "frontend/README.md",
    ".claude/skills/x/SKILL.md", ".claude/skills/x/references/a.md", ".github/pull_request_template.md", "backend/src/a.ts",
  ], []);
  assert.deepEqual(v, { ok: true, blocked: [], waived: false });
});

test("plans, notes and nested module docs fail", () => {
  const v = classify(["docs/PLAN.md", "HANDOFF.md", "docs/modules/scm/notes.md", "tasks/findings.md", "docs/bugs/x.MD"], []);
  assert.equal(v.ok, false);
  assert.deepEqual(v.blocked, ["docs/PLAN.md", "HANDOFF.md", "docs/modules/scm/notes.md", "tasks/findings.md", "docs/bugs/x.MD"]);
});

test("the docs-requested label waives, and says what it waived", () => {
  assert.deepEqual(classify(["docs/PLAN.md"], ["bug", "docs-requested"]), { ok: true, blocked: ["docs/PLAN.md"], waived: true });
  assert.equal(classify(["docs/PLAN.md"], ["no-test-needed"]).ok, false);
});

const hook = path.join(root, ".claude/hooks/block-unsolicited-md.mjs");
const runHook = (file_path) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path } }), encoding: "utf8" });

test("hook blocks a new unsolicited markdown in the repo", () => {
  const r = runHook(path.join(root, "docs", "zz-handoff-not-real.md"));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unsolicited markdown/);
});

test("hook allows allowed paths, existing files, code and files outside the repo", () => {
  assert.equal(runHook(path.join(root, "docs", "modules", "zz-new.md")).status, 0);
  assert.equal(runHook(path.join(root, "CLAUDE.md")).status, 0);
  assert.equal(runHook(path.join(root, "docs", "zz.ts")).status, 0);
  assert.equal(runHook(path.join(os.tmpdir(), "notes.md")).status, 0);
  assert.ok(!fs.existsSync(path.join(root, "docs", "zz-handoff-not-real.md")));
});
