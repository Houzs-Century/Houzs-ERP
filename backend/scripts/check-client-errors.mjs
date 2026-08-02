// check-client-errors.mjs — what is actually FAILING in the SPA for real users.
//
// WHY. Owner, 2026-08-02: "不要有页面卡顿 或者还 pages load 不过去". Jank is
// measurable from the browser; a page that fails to LOAD for someone else, on
// another machine, at 3pm, is not. `client_errors` (mig 0151) is the only record
// of that — the SPA's error boundary and reporter POST every crash there, keyed
// by build_id, so it can tell a fault in the CURRENT deploy from one in a stale
// service-worker build.
//
// This is the read-only check that turns "the pages don't load" into a list of
// what broke, where, how often, and on which build. Optimise what it names, not
// what the dev machine happens to reproduce.
//
// READ-ONLY. SELECTs only — no DDL, no writes, no transaction. Manual trigger
// only, own concurrency group, exit 0 for every legitimate answer including "no
// errors at all" (a red job reads as "the check broke"; the answer is the
// output). House pattern: backend/scripts/check-soak-gate.mjs.
//
//   DATABASE_URL   required (env, or .dev.vars for local use)
//   DAYS           lookback window in days (default 14)
//   LIMIT          rows per section (default 20)

import { readFileSync } from "node:fs";
import postgres from "postgres";

const DAYS = Math.max(1, Number(process.env.DAYS || 14));
const LIMIT = Math.max(1, Number(process.env.LIMIT || 20));

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}
const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

/* A chunk/asset load failure is the "page did not load" shape specifically —
   the same predicate the SPA's own isStaleChunkError uses, so the check and the
   product agree on what counts. */
const CHUNK_RE = "(dynamically imported|Loading chunk|module script|MIME type|Unable to preload|Failed to fetch dynamic)";

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
  log(`Window: last ${DAYS} day(s), from ${since}. Read-only.`);

  const [{ n: total } = { n: 0 }] = await pg`
    SELECT COALESCE(SUM(count), 0)::int AS n FROM client_errors WHERE day >= ${since}`;
  const [{ n: distinct } = { n: 0 }] = await pg`
    SELECT COUNT(*)::int AS n FROM client_errors WHERE day >= ${since}`;
  log(`TOTAL occurrences: ${total} across ${distinct} deduped row(s).`);

  if (total === 0) {
    log("No client errors reported in the window. Nothing to act on.");
    return;
  }

  // ── 1. "The page did not load" — chunk/asset failures, the owner's complaint
  const chunk = await pg`
    SELECT route, build_id, SUM(count)::int AS n, MAX(last_seen_at) AS last_seen,
           MIN(message) AS sample
      FROM client_errors
     WHERE day >= ${since} AND message ~* ${CHUNK_RE}
     GROUP BY route, build_id
     ORDER BY n DESC
     LIMIT ${LIMIT}`;
  log(`\n== PAGE-DID-NOT-LOAD (chunk / asset failures) : ${chunk.length} group(s)`);
  if (chunk.length === 0) {
    log("  None. Whatever the owner saw, it was NOT a failed chunk load in this window.");
  }
  for (const r of chunk) {
    log(`  ${r.n}x  route=${r.route || "(none)"}  build=${r.build_id || "(none)"}  last=${r.last_seen}`);
    log(`        ${String(r.sample).replace(/\s+/g, " ").slice(0, 150)}`);
  }

  // ── 2. Everything else, worst first
  const top = await pg`
    SELECT route, SUM(count)::int AS n, COUNT(DISTINCT user_id)::int AS users,
           MAX(last_seen_at) AS last_seen, MIN(message) AS sample
      FROM client_errors
     WHERE day >= ${since} AND message !~* ${CHUNK_RE}
     GROUP BY route
     ORDER BY n DESC
     LIMIT ${LIMIT}`;
  log(`\n== OTHER ERRORS BY ROUTE : ${top.length}`);
  for (const r of top) {
    log(`  ${r.n}x  users=${r.users}  route=${r.route || "(none)"}  last=${r.last_seen}`);
    log(`        ${String(r.sample).replace(/\s+/g, " ").slice(0, 150)}`);
  }

  // ── 3. Which BUILD. A fault concentrated on an old build_id is a stale
  //    service-worker problem (recovery), not a code problem (fix the code).
  const builds = await pg`
    SELECT build_id, SUM(count)::int AS n, MAX(last_seen_at) AS last_seen
      FROM client_errors WHERE day >= ${since}
     GROUP BY build_id ORDER BY n DESC LIMIT 10`;
  log(`\n== BY BUILD (a spike on an OLD build = stale bundle, not new code)`);
  for (const b of builds) log(`  ${b.n}x  build=${b.build_id || "(none)"}  last=${b.last_seen}`);

  // ── 4. Repeat offenders — one user hitting the same thing all day is a
  //    different problem from many users hitting it once.
  const worst = await pg`
    SELECT route, message, SUM(count)::int AS n, COUNT(DISTINCT user_id)::int AS users
      FROM client_errors WHERE day >= ${since}
     GROUP BY route, message ORDER BY n DESC LIMIT ${LIMIT}`;
  log(`\n== WORST SINGLE MESSAGES`);
  for (const w of worst) {
    log(`  ${w.n}x  users=${w.users}  route=${w.route || "(none)"}`);
    log(`        ${String(w.message).replace(/\s+/g, " ").slice(0, 170)}`);
  }

  log(`\nSUMMARY: ${total} occurrence(s), ${chunk.length} chunk-failure group(s), ${top.length} other route(s).`);
}

main()
  .then(() => pg.end())
  .catch(async (e) => {
    console.error(e);
    await pg.end();
    process.exit(1);
  });
