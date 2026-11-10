// Read-only report: the top browser-reported errors of the last N days, from
// production's client_errors table.
//
// WHY THIS EXISTS
//
// POST /api/client-errors is one of the heaviest routes by Worker time (23,309
// calls in a week). The System Health panel groups by dedup_hash, which is per
// message + route + BUILD, so one error splits into a row per deploy and the
// real top offenders are hidden. This groups by what the error IS: kind (thrown
// JS error vs slow/timeout/5xx/403 request note) + scrubbed message + page.
//
// THE ACTIONS LOG IS PUBLIC. Nothing identifying is printed: user ids are only
// counted, messages and pages are scrubbed by lib/top-client-errors.mjs. To see
// one group's full text, look up its sample hash privately (Supabase MCP,
// read-only): SELECT message, stack FROM client_errors WHERE dedup_hash LIKE '<hash>%'.
//
// Inputs (runner `env`, all optional): DAYS=7 (1-30), LIMIT=15 (1-50),
// KIND=js|slow|timeout|api-5xx|rbac-403 (top list of that kind only),
// BY_PAGE=0 (merge a signature across pages).
//
// One SELECT inside a READ ONLY transaction. Exits 0 for every real answer,
// including an empty window. Only an unreachable database or a query error
// exits non-zero.
//
// RE-RUN: safe and identical for the same window. It writes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { groupTopErrors } from "./lib/top-client-errors.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

function intEnv(name, dflt, min, max) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dflt;
}

const url = resolveUrl();
if (!url) {
  console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
  process.exit(1);
}

const DAYS = intEnv("DAYS", 7, 1, 30);
const LIMIT = intEnv("LIMIT", 15, 1, 50);
const KINDS = ["js", "slow", "timeout", "api-5xx", "rbac-403"];
const KIND = KINDS.includes(process.env.KIND ?? "") ? process.env.KIND : null;
if (process.env.KIND && !KIND) {
  console.error(`KIND must be one of ${KINDS.join(", ")}; got something else. Aborting.`);
  process.exit(1);
}
const BY_PAGE = process.env.BY_PAGE !== "0";
const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
let exitCode = 0;
try {
  const rows = await pg.begin("read only", async (sql) => {
    await sql`SET LOCAL statement_timeout = '60s'`;
    // dedup_hash is sha256(message + route + build_id), so message/route/build
    // are constant within a hash; MAX() just picks that one value.
    return sql`
      SELECT dedup_hash,
             MAX(message)                 AS message,
             MAX(route)                   AS route,
             MAX(build_id)                AS build_id,
             SUM(count)::bigint           AS n,
             MIN(occurred_at)             AS first_seen,
             MAX(last_seen_at)            AS last_seen,
             array_agg(DISTINCT user_id)  AS users,
             (array_agg(left(stack, 2000)) FILTER (WHERE stack IS NOT NULL))[1] AS stack
        FROM client_errors
       WHERE last_seen_at >= ${cutoff}
       GROUP BY dedup_hash`;
  });

  console.log(
    `client_errors, last ${DAYS} day(s) (last_seen_at >= ${cutoff}), kind=${KIND ?? "all"}, by_page=${BY_PAGE}`,
  );
  if (rows.length === 0) {
    notice(`No client errors recorded in the last ${DAYS} day(s).`);
  } else {
    const { top, totals } = groupTopErrors(rows, LIMIT, { kind: KIND, byPage: BY_PAGE });
    const kinds = Object.entries(totals.byKind)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    notice(
      `${totals.occurrences} occurrences, ${totals.signatures} signatures, ${totals.distinctUsers} distinct users. By kind: ${kinds}`,
    );
    console.log("");
    top.forEach((g, i) => {
      console.log(
        `#${i + 1}  [${g.kind}]  count=${g.count}  users=${g.distinctUsers}  builds=${g.distinctBuilds} (latest ${g.latestBuild || "-"})`,
      );
      console.log(`    first=${g.firstSeen}  last=${g.lastSeen}`);
      console.log(`    page=${g.page}`);
      console.log(`    message=${g.message}`);
      if (g.frame) console.log(`    frame=${g.frame}`);
      console.log(`    sample_hash=${g.sampleHash}  (${g.hashes} hash row(s) merged)`);
      console.log("");
    });
  }
} catch (e) {
  console.error("Query failed:", e?.message ?? e);
  exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
process.exit(exitCode);
