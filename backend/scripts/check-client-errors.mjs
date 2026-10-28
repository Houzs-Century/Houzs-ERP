// Read-only dump of recent client-side error reports — the same rows the
// System Health "Client Errors" panel shows (GET /api/client-errors/summary),
// printed to a workflow run so nobody has to open that (heavy) page or a SQL
// console.
//
// WHY A SCRIPT + WORKFLOW (the repo's standard, see check-soak-gate.mjs):
// the answer lives only in production's `client_errors` table. Reading it any
// other way means a human holding the production DSN pasting a SELECT into a
// console. Actions already holds `secrets.DATABASE_URL` for the deploy, so the
// read runs there and nobody handles the credential.
//
// Strictly ONE SELECT. No DDL, no writes, no transaction. Exits 0 whether or
// not there are rows — ZERO rows is a legitimate answer ("nothing broke"), not
// a failure; a red job would read as "the check broke", and the ANSWER is the
// output. Only an unreachable database or a query error exits non-zero.
//
// The query mirrors routes/clientErrors.ts GET /summary verbatim (group by
// dedup_hash, newest-busiest first) so this and the panel can never disagree.
// PRIVACY: message + route PATHNAME + build id + counts only — the same
// sanitized fields the panel shows; no stacks, no query strings, no identity.
//
// Window defaults to 3 days (env DAYS overrides, clamped 1..30) because the
// question that prompted this — "what were those 11 errors?" — is about the
// last day or two.
//
// RE-RUN: idempotent. It reads and prints; running it again prints the current
// state. It changes nothing.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
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

const DAYS = Math.min(Math.max(parseInt(process.env.DAYS || "3", 10) || 3, 1), 30);
const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

// `notice` surfaces the headline on the run's summary page, readable without
// opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT dedup_hash,
           MAX(message)            AS message,
           MAX(route)              AS route,
           MAX(build_id)           AS build_id,
           SUM(count)              AS n,
           COUNT(DISTINCT user_id) AS affected_users,
           MAX(last_seen_at)       AS last_seen_at
      FROM client_errors
     WHERE last_seen_at >= ${cutoff}
     GROUP BY dedup_hash
     ORDER BY n DESC
     LIMIT 50`;

  const totalOccurrences = rows.reduce((s, r) => s + Number(r.n), 0);

  if (rows.length === 0) {
    notice(`Client errors: NONE in the last ${DAYS} day(s). Nothing broke.`);
    await pg.end();
    process.exit(0);
  }

  notice(
    `Client errors: ${rows.length} distinct signature(s), ${totalOccurrences} occurrence(s) in the last ${DAYS} day(s). Details below.`,
  );
  console.log("");
  console.log(`Distinct signatures: ${rows.length}   Total occurrences: ${totalOccurrences}   Window: ${DAYS}d\n`);
  for (const r of rows) {
    console.log(`[${String(r.n).padStart(4)}x · ${r.affected_users} user(s)] ${r.route || "(no route)"}`);
    console.log(`        ${String(r.message || "(no message)").slice(0, 300)}`);
    console.log(`        build ${r.build_id || "?"} · last seen ${r.last_seen_at}`);
    console.log("");
  }

  await pg.end();
  process.exit(0);
} catch (e) {
  console.error(`Client-errors read FAILED (DB unreachable or query error): ${e?.message || e}`);
  try { await pg.end(); } catch { /* already closing */ }
  process.exit(1);
}
