#!/usr/bin/env node
// Runs in ci.yml's `changes` job on merge_group. Writes reuse/backend/frontend to
// $GITHUB_OUTPUT. Any error writes NOTHING, so the job's outputs fall back to
// running everything. Rules: scripts/lib/ci-queue-reuse.mjs.
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { artifactNameForTree, decideQueueReuse, prNumberFromQueueRef } from "./lib/ci-queue-reuse.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

try {
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const pr = prNumberFromQueueRef(process.env.GITHUB_REF);
  console.log(`tree ${tree}, queue ref ${process.env.GITHUB_REF}, PR ${pr}`);
  const prHeadSha = pr ? (await api(`pulls/${pr}`)).head.sha : null;
  const arts = await api(`actions/artifacts?name=${artifactNameForTree(tree)}&per_page=100`);
  const runIds = [...new Set(arts.artifacts.filter((a) => !a.expired).map((a) => a.workflow_run?.id).filter(Boolean))];
  const runs = [];
  for (const id of runIds) {
    const run = await api(`actions/runs/${id}`);
    const jobs = (await api(`actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs;
    runs.push({ ...run, jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })) });
  }
  const d = decideQueueReuse({ prHeadSha, runs });
  for (const r of d.reasons) console.log(r);
  console.log(`::notice title=merge-queue reuse::${d.reuse ? `REUSED run ${d.runId}` : "nothing reused"} — backend half ${d.backend ? "runs" : "skipped"}, frontend half ${d.frontend ? "runs" : "skipped"}`);
  if (d.reuse) {
    appendFileSync(process.env.GITHUB_OUTPUT, `reuse=true\nbackend=${d.backend}\nfrontend=${d.frontend}\n`);
  }
} catch (e) {
  console.log(`::warning title=merge-queue reuse::lookup failed, running everything: ${e.message}`);
}
