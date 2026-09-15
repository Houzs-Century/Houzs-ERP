import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { artifactNameForTree, decideQueueReuse, prNumberFromQueueRef } from "./lib/ci-queue-reuse.mjs";

const HEAD = "a".repeat(40);
const job = (name, conclusion = "success") => ({ name, conclusion });
const SHARED = [job("changes"), job("backend-typecheck"), job("file-size"), job("e2e-contract"), job("lint (backend)"), job("lint (frontend)")];
const BACKEND = [job("backend-tests (1)"), job("backend-tests (2)"), job("backend-tests (3)"), job("backend-postgres")];
const FRONTEND = [job("frontend-tests (1)"), job("frontend-tests (2)"), job("frontend-tests (3)"), job("frontend-checks"), job("frontend-typecheck"), job("frontend-build"), job("frontend-perf")];
const green = (over = {}) => ({
  id: 1, path: ".github/workflows/ci.yml", event: "pull_request", status: "completed", conclusion: "success",
  head_sha: HEAD, jobs: [...SHARED, ...BACKEND, ...FRONTEND], ...over,
});

test("a green PR run of this head on this tree reuses everything", () => {
  const d = decideQueueReuse({ prHeadSha: HEAD, runs: [green()] });
  assert.deepEqual([d.reuse, d.backend, d.frontend, d.runId], [true, false, false, 1]);
});

test("each proof condition, dropped on its own, stops the reuse", () => {
  const cases = {
    "another workflow": { path: ".github/workflows/deploy.yml" },
    "not a PR run": { event: "merge_group" },
    "still running": { status: "in_progress", conclusion: null },
    "failed run": { conclusion: "failure" },
    "cancelled run": { conclusion: "cancelled" },
    "a different head": { head_sha: "b".repeat(40) },
    "typecheck skipped": { jobs: [...SHARED.filter((j) => j.name !== "backend-typecheck"), job("backend-typecheck", "skipped"), ...BACKEND, ...FRONTEND] },
    "a lint leg missing": { jobs: [...SHARED.filter((j) => j.name !== "lint (frontend)"), ...BACKEND, ...FRONTEND] },
    "file-size absent": { jobs: [...SHARED.filter((j) => j.name !== "file-size"), ...BACKEND, ...FRONTEND] },
  };
  for (const [label, over] of Object.entries(cases)) {
    const d = decideQueueReuse({ prHeadSha: HEAD, runs: [green(over)] });
    assert.deepEqual([d.reuse, d.backend, d.frontend], [false, true, true], label);
  }
  assert.equal(decideQueueReuse({ prHeadSha: null, runs: [green()] }).reuse, false, "no PR head");
  assert.equal(decideQueueReuse({ prHeadSha: HEAD, runs: [] }).reuse, false, "no run");
});

test("a half the PR run skipped by path is run by the queue", () => {
  const frontendOnly = green({ jobs: [...SHARED, job("backend-tests", "skipped"), job("backend-postgres", "skipped"), ...FRONTEND] });
  const d = decideQueueReuse({ prHeadSha: HEAD, runs: [frontendOnly] });
  assert.deepEqual([d.reuse, d.backend, d.frontend], [true, true, false]);
  const oneShardFailed = green({ jobs: [...SHARED, ...BACKEND, ...FRONTEND.filter((j) => j.name !== "frontend-tests (2)"), job("frontend-tests (2)", "failure")] });
  assert.equal(decideQueueReuse({ prHeadSha: HEAD, runs: [oneShardFailed] }).frontend, true);
});

test("a bad run does not hide a good one for the same tree", () => {
  const d = decideQueueReuse({ prHeadSha: HEAD, runs: [green({ id: 7, conclusion: "cancelled" }), green({ id: 8 })] });
  assert.deepEqual([d.reuse, d.runId], [true, 8]);
});

test("queue ref and artifact name parsing", () => {
  assert.equal(prNumberFromQueueRef(`refs/heads/gh-readonly-queue/main/pr-3891-${"c".repeat(40)}`), 3891);
  assert.equal(prNumberFromQueueRef("refs/pull/3891/merge"), null);
  assert.equal(artifactNameForTree("d".repeat(40)), `ci-tree-${"d".repeat(40)}`);
  assert.throws(() => artifactNameForTree("HEAD"));
});

// The reusable jobs in the lib must be exactly the jobs ci.yml gates on `reuse`.
test("ci.yml gates exactly the always-on jobs the lib checks, and fails closed if changes fails", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const jobs = {};
  const heads = [...ci.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  heads.forEach((m, i) => { jobs[m[1]] = ci.slice(m.index, heads[i + 1]?.index ?? ci.length); });
  const GATE = "    if: ${{ !cancelled() && (needs.changes.result != 'success' || needs.changes.outputs.reuse != 'true') }}\n";
  const gated = Object.keys(jobs).filter((n) => jobs[n].includes(GATE)).sort();
  assert.deepEqual(gated, ["backend-typecheck", "e2e-contract", "file-size", "lint"]);
  for (const rollup of ["backend", "frontend"]) {
    assert.match(jobs[rollup], /needs: \[changes, /, `${rollup} roll-up needs changes`);
    assert.match(jobs[rollup], /must_succeed changes "\$\{\{ needs\.changes\.result \}\}"/, `${rollup} roll-up requires changes to succeed`);
  }
});
