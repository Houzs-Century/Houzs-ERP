// Merge-queue reuse: may the merge-queue run of ci.yml skip work that the PR's own
// run already did, on exactly the same tree? Owner approved 2026-09-15
// (docs/ci-fast-lane.md §3.1).
//
// Measured before this existed: every PR ran the whole suite twice, once on the PR
// and again in the queue, and in 28 of 60 merged PRs the queue's tree was the one
// the PR run had already turned green.
//
// A job is only skipped when a PR run PROVES it passed on this tree. Every other
// answer — no such run, a run still going, a failed or cancelled run, a run for a
// different head, a half the PR run skipped by path — runs it. Unknown means run it.
//
// The tree identity is carried by an artifact the PR run's `changes` job uploads,
// named `ci-tree-<tree sha>`. The NAME is written by that run's own ci.yml, so a PR
// that edits ci.yml could lie in it — but the queue runs that same edited ci.yml,
// so trusting it adds nothing the author could not already do. What the name must
// not do is let one PR vouch for ANOTHER: hence the run's head_sha has to be the
// head of the PR this queue group was built from.

export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";

export function artifactNameForTree(tree) {
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error(`not a tree sha: ${tree}`);
  return `ci-tree-${tree}`;
}

// refs/heads/gh-readonly-queue/main/pr-3891-<base sha>
export function prNumberFromQueueRef(ref) {
  const m = /^refs\/heads\/gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{40}$/.exec(ref ?? "");
  return m ? Number(m[1]) : null;
}

// Jobs that must have SUCCEEDED (not skipped) for each reusable unit. A matrix
// job appears once per leg as "name (leg)"; every leg must be present and green.
const UNITS = {
  // Always-on jobs. One flag: the queue skips all four or none.
  shared: { exact: ["backend-typecheck", "file-size", "e2e-contract"], legs: { lint: ["backend", "frontend"] } },
  backend: { exact: ["backend-postgres"], matrix: ["backend-tests"] },
  frontend: { exact: ["frontend-checks", "frontend-typecheck", "frontend-build", "frontend-perf"], matrix: ["frontend-tests"] },
};

function unitPassed(unit, jobs) {
  const ok = (name) => jobs.some((j) => j.name === name && j.conclusion === "success");
  for (const name of unit.exact ?? []) if (!ok(name)) return false;
  for (const [name, legs] of Object.entries(unit.legs ?? {})) {
    for (const leg of legs) if (!ok(`${name} (${leg})`)) return false;
  }
  for (const name of unit.matrix ?? []) {
    const legs = jobs.filter((j) => j.name.startsWith(`${name} (`));
    if (legs.length === 0 || legs.some((j) => j.conclusion !== "success")) return false;
  }
  return true;
}

/**
 * @param {{ prHeadSha: string | null, runs: Array<{ id: number, path: string, event: string,
 *   status: string, conclusion: string | null, head_sha: string,
 *   jobs: Array<{ name: string, conclusion: string | null }> }> }} input
 * @returns {{ reuse: boolean, backend: boolean, frontend: boolean, runId: number | null, reasons: string[] }}
 *   `backend` / `frontend` = the queue must RUN that half.
 */
export function decideQueueReuse({ prHeadSha, runs }) {
  const none = (reasons) => ({ reuse: false, backend: true, frontend: true, runId: null, reasons });
  if (!prHeadSha) return none(["no PR head sha resolved"]);
  const reasons = [];
  for (const run of runs) {
    const why = [];
    if (!(run.path === CI_WORKFLOW_PATH || run.path?.startsWith(`${CI_WORKFLOW_PATH}@`))) why.push(`path ${run.path}`);
    if (run.event !== "pull_request") why.push(`event ${run.event}`);
    if (run.status !== "completed") why.push(`status ${run.status}`);
    if (run.conclusion !== "success") why.push(`conclusion ${run.conclusion}`);
    if (run.head_sha !== prHeadSha) why.push(`head ${run.head_sha} is not the PR head ${prHeadSha}`);
    if (why.length === 0 && !unitPassed(UNITS.shared, run.jobs)) why.push("an always-on job did not succeed");
    if (why.length > 0) {
      reasons.push(`run ${run.id}: ${why.join("; ")}`);
      continue;
    }
    const backendRan = unitPassed(UNITS.backend, run.jobs);
    const frontendRan = unitPassed(UNITS.frontend, run.jobs);
    return {
      reuse: true,
      backend: !backendRan,
      frontend: !frontendRan,
      runId: run.id,
      reasons: [`run ${run.id}: passed on this tree; backend half ${backendRan ? "reused" : "runs"}, frontend half ${frontendRan ? "reused" : "runs"}`],
    };
  }
  return none(reasons.length ? reasons : ["no PR run recorded this tree"]);
}
