// Stale-branch report — the classification, kept pure so it can be unit-tested
// without a network, a token or a repo.
//
// NO SHEBANG, ON PURPOSE — this module is imported by a test. See the CLAUDE.md
// note about vitest inlining on Windows (BUG-HISTORY #2062).
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// On 2026-08-13 this repo had 183 remote branches. 101 of them belonged to pull
// requests that had already merged or been closed — 55% dead. A branch list that
// is mostly dead is a list nobody reads, and a genuinely stale branch (work
// somebody abandoned half-finished) hides in it perfectly.
//
// The permanent fix is `delete_branch_on_merge` at the repository level, which
// removes the MERGED half automatically. This report covers what that setting
// cannot: branches whose PR was CLOSED without merging, branches that predate
// the setting, and branches with no PR at all.
//
// IT ONLY EVER REPORTS. Deleting a branch on a timer is how somebody's parked
// work disappears overnight; the whole point of a 30-day report is that a human
// reads the list and decides. Nothing in this file or its caller deletes.

export const DEFAULT_STALE_DAYS = 30;

/** Branch names that are infrastructure, never cleanup candidates. */
export const PROTECTED_BRANCHES = new Set(['main', 'staging', 'master', 'develop', 'production']);

/**
 * @param {object} args
 * @param {string[]} args.branches                 remote branch names
 * @param {Array<{number, state, merged_at, closed_at, head_ref}>} args.pulls
 * @param {Date} args.now
 * @param {number} args.staleDays
 * @returns {{stale: [], recentlyClosed: [], openPr: [], noPr: [], protectedBranches: []}}
 */
export function classifyBranches({ branches, pulls, now = new Date(), staleDays = DEFAULT_STALE_DAYS }) {
  const byRef = new Map();
  for (const pr of pulls) {
    const list = byRef.get(pr.head_ref) || [];
    list.push(pr);
    byRef.set(pr.head_ref, list);
  }

  const stale = [];
  const recentlyClosed = [];
  const openPr = [];
  const noPr = [];
  const protectedBranches = [];

  for (const branch of branches) {
    if (PROTECTED_BRANCHES.has(branch)) {
      protectedBranches.push(branch);
      continue;
    }
    const prs = (byRef.get(branch) || []).slice().sort((a, b) => b.number - a.number);
    if (prs.length === 0) {
      // Never a deletion candidate by this report: with no PR there is no record
      // of review or intent, so the only safe output is "a human should look".
      noPr.push({ branch });
      continue;
    }
    if (prs.some((p) => p.state === 'open')) {
      openPr.push({ branch, pr: prs.find((p) => p.state === 'open').number });
      continue;
    }
    // Youngest close wins: a branch reopened under a second PR is only as stale
    // as its most recent closure.
    const closedAt = prs
      .map((p) => p.merged_at || p.closed_at)
      .filter(Boolean)
      .map((d) => new Date(d))
      .sort((a, b) => b - a)[0];
    if (!closedAt) {
      noPr.push({ branch });
      continue;
    }
    const top = prs[0];
    const days = Math.floor((now - closedAt) / 86400000);
    const entry = {
      branch,
      pr: top.number,
      merged: Boolean(top.merged_at),
      closedAt: closedAt.toISOString().slice(0, 10),
      days,
    };
    if (days > staleDays) stale.push(entry);
    else recentlyClosed.push(entry);
  }

  const byAge = (a, b) => b.days - a.days;
  stale.sort(byAge);
  recentlyClosed.sort(byAge);
  return { stale, recentlyClosed, openPr, noPr, protectedBranches };
}

/** Markdown for the Actions job summary. */
export function formatReport(result, { staleDays = DEFAULT_STALE_DAYS, totalBranches } = {}) {
  const { stale, recentlyClosed, openPr, noPr } = result;
  const out = [];
  out.push('# Stale branch report');
  out.push('');
  out.push(`${totalBranches} remote branches. **This report never deletes anything.**`);
  out.push('');
  out.push('| bucket | count |');
  out.push('|---|---|');
  out.push(`| PR closed/merged > ${staleDays} days ago | **${stale.length}** |`);
  out.push(`| PR closed/merged within ${staleDays} days | ${recentlyClosed.length} |`);
  out.push(`| open PR | ${openPr.length} |`);
  out.push(`| no PR at all | ${noPr.length} |`);
  out.push('');

  if (stale.length) {
    out.push(`## Safe to delete — PR closed more than ${staleDays} days ago`);
    out.push('');
    out.push('| branch | PR | outcome | closed | age (days) |');
    out.push('|---|---|---|---|---|');
    for (const s of stale) {
      out.push(`| \`${s.branch}\` | #${s.pr} | ${s.merged ? 'merged' : 'closed'} | ${s.closedAt} | ${s.days} |`);
    }
    out.push('');
    out.push('Delete one with:');
    out.push('');
    out.push('```sh');
    out.push('git push origin --delete <branch>');
    out.push('```');
    out.push('');
  } else {
    out.push(`No branch has a PR that closed more than ${staleDays} days ago. Nothing to clean up.`);
    out.push('');
  }

  if (noPr.length) {
    out.push('## Branches with NO pull request — needs a human');
    out.push('');
    out.push('These have no PR, so nothing records what they were for or whether the work landed.');
    out.push('Do not delete them on the strength of this report; ask the author.');
    out.push('');
    for (const n of noPr) out.push(`- \`${n.branch}\``);
    out.push('');
  }
  return out.join('\n');
}
