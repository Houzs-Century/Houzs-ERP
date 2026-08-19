// Read-only report on the MRP stored-planning snapshot (option B, 2026-08-19):
// is the */15 cron actually refreshing scm.mrp_snapshots, per company?
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW. "Is the MRP auto-refresh running?"
// is a claim about PRODUCTION runtime, and CLAUDE.md rule 3 says a claim about an
// operation is UNTESTED until something was run. Reading the source proves the
// cron branch exists; it does NOT prove the slot fired. The freshness of
// computed_at is the evidence, and it lives only in prod — so this runs in
// Actions (which already holds secrets.DATABASE_URL) rather than costing an owner
// an interruption and a SQL console.
//
// THE TIMESTAMP IS EVIDENCE, NOT A SETTING. Three outcomes, and the third matters:
//
//   fresh (age <= 20 min)  -> the */15 cron is refreshing this company. Good.
//   stale (age >  20 min)  -> a row exists but is not being refreshed — the cron
//                             is not firing, or refreshMrpSnapshot is erroring.
//                             Read the Worker's [cron mrp-snapshot] logs.
//   NO ROW (or no table)   -> not populated yet: before the first cron/Regenerate,
//                             or before 0309 deployed. The MRP page falls back to
//                             live compute, so this is "not yet on", not "broken".
//                             Do NOT insert a row by hand — that forges the very
//                             evidence this check exists to read.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 in every
// legitimate case — a red job would read as "the check broke", and the ANSWER is
// the output. Only an unreachable database exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

// ~15-min cron + slack for a slow run / cold slot.
const FRESH_MAX_SECONDS = 20 * 60;

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

const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  let rows;
  try {
    rows = await pg`
      SELECT company_id,
             computed_at,
             EXTRACT(EPOCH FROM (now() - computed_at))::bigint AS age_seconds
      FROM scm.mrp_snapshots
      ORDER BY company_id`;
  } catch (e) {
    // 42P01 = undefined_table: 0309 has not reached this database yet. That is a
    // legitimate "not deployed" answer, not a broken check.
    if (e && e.code === "42P01") {
      notice("MRP snapshot: table scm.mrp_snapshots does not exist yet (0309 not deployed). Page computes live.");
      process.exit(0);
    }
    throw e;
  }

  if (rows.length === 0) {
    notice("MRP snapshot: 0 rows — not populated yet (no cron/Regenerate has run since deploy). Page computes live; this is not a fault.");
    process.exit(0);
  }

  const fmtAge = (s) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
  const lines = rows.map((r) => {
    const age = Number(r.age_seconds);
    const state = age <= FRESH_MAX_SECONDS ? "FRESH" : "STALE";
    return `company ${r.company_id}: ${state} (as of ${new Date(r.computed_at).toISOString()}, ${fmtAge(age)} ago)`;
  });
  const anyStale = rows.some((r) => Number(r.age_seconds) > FRESH_MAX_SECONDS);
  notice(`MRP snapshot freshness — ${lines.join(" | ")}`);
  if (anyStale) {
    notice("At least one company is STALE (> 20 min): the */15 cron may not be firing or refreshMrpSnapshot is erroring. Read the Worker's [cron mrp-snapshot] logs. (Still exit 0 — the answer is the output.)");
  }
  process.exit(0);
} catch (e) {
  console.error("MRP snapshot check could not reach the database:", e instanceof Error ? e.message : String(e));
  process.exit(1);
} finally {
  await pg.end({ timeout: 5 });
}
