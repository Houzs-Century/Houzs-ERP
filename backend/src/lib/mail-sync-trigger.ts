import type { Env } from "../types";

/** Starts the mail-sync GitHub workflow (Gmail IMAP -> Mail Center). GitHub's own
 *  `*\/5` schedule really fires every 6-9 h, so the worker's 5-minute cron asks
 *  for a run instead. No-op until the GITHUB_TOKEN secret (Actions: write on the
 *  repo) is set. The workflow's concurrency group keeps runs from overlapping. */
export async function triggerMailSync(env: Env): Promise<{ skipped: true } | { ok: boolean; status: number }> {
  if (!env.GITHUB_TOKEN) return { skipped: true };
  const repo = env.GITHUB_REPO || "Houzs-Century/Houzs-ERP";
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/mail-sync.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "houzs-erp-worker",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  return { ok: res.ok, status: res.status };
}
