#!/usr/bin/env node
// Stale-branch REPORT. Reads the branch list and every PR, and prints which
// branches belong to a pull request that closed long enough ago to be safe to
// remove. The rules live in scripts/lib/stale-branches.mjs.
//
// IT NEVER DELETES. There is no delete call in this file, and there is not
// meant to be one: a scheduled job that removes branches is a scheduled job that
// eventually removes something somebody still wanted. This produces a list; a
// human acts on it.
//
// Usage:
//   GITHUB_TOKEN=... node scripts/report-stale-branches.mjs
//   ... --days 60          # change the staleness threshold
//   ... --json out.json    # machine-readable, for a follow-up step
//
// In CI it is driven by .github/workflows/stale-branch-report.yml and writes to
// the job summary, so the answer is on the run page rather than in a log nobody
// opens.

import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { DEFAULT_STALE_DAYS, classifyBranches, formatReport } from './lib/stale-branches.mjs';

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
}

const REPO = process.env.GITHUB_REPOSITORY || 'hello-houzs/Houzs-ERP';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const STALE_DAYS = Number(flag('--days', DEFAULT_STALE_DAYS));
const JSON_OUT = flag('--json', null);

// A repo cannot legitimately have zero branches. If the scan comes back empty
// the API call, the token or the repo name is wrong — and a report that says
// "nothing to clean up" because it FETCHED nothing is worse than no report,
// because it reads exactly like a clean bill of health.
const MIN_EXPECTED_BRANCHES = 1;

if (!TOKEN) {
  console.error('report-stale-branches: no GITHUB_TOKEN/GH_TOKEN in the environment.');
  process.exit(2);
}

async function api(path) {
  const out = [];
  let url = `https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'houzs-stale-branch-report',
      },
    });
    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    out.push(...(await res.json()));
    const link = res.headers.get('link') || '';
    const next = link.split(',').find((p) => p.includes('rel="next"'));
    url = next ? next.slice(next.indexOf('<') + 1, next.indexOf('>')) : null;
  }
  return out;
}

async function main() {
  const [branchRows, prRows] = await Promise.all([
    api(`/repos/${REPO}/branches`),
    api(`/repos/${REPO}/pulls?state=all`),
  ]);

  const branches = branchRows.map((b) => b.name);
  if (branches.length < MIN_EXPECTED_BRANCHES) {
    console.error('STALE-BRANCH REPORT: the branch scan returned NOTHING — this is a broken report, not a clean repo.');
    console.error(`  repo=${REPO} branches=${branches.length} pulls=${prRows.length}`);
    process.exit(2);
  }

  const pulls = prRows.map((p) => ({
    number: p.number,
    state: p.state,
    merged_at: p.merged_at,
    closed_at: p.closed_at,
    head_ref: p.head.ref,
  }));

  const result = classifyBranches({ branches, pulls, now: new Date(), staleDays: STALE_DAYS });
  const md = formatReport(result, { staleDays: STALE_DAYS, totalBranches: branches.length });

  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify({ ...result, totalBranches: branches.length }, null, 2)}\n`);

  console.log(
    `\nscanned ${branches.length} branches against ${pulls.length} pull requests; ` +
      `${result.stale.length} stale, ${result.noPr.length} with no PR.`,
  );
  // Exit 0 even with findings: this is a report, and a red X every week trains
  // people to ignore the job. Only a BROKEN scan fails (above).
}

main().catch((err) => {
  console.error(`STALE-BRANCH REPORT FAILED: ${err.message}`);
  process.exit(2);
});
