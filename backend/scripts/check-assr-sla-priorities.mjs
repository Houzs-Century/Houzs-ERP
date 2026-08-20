// Read-only report: what the Service priority SLA windows are in PRODUCTION,
// beside the hardcoded fallback the code used to use unconditionally.
//
// WHY THIS EXISTS
//
// Until 2026-08-20 `slaHoursFor()` read only `SLA_HOURS_BY_PRIORITY` in
// `src/services/assr.ts`; `assr_priorities.sla_hours` was saved by Service
// Maintenance and never read back. Making it live means production's stored
// values START DECIDING new case deadlines. Whether that changes anything
// depends on one fact that lives only in production — have those rows been
// edited away from the mig 065 seed? — and reading code cannot answer it.
//
// The alternative was pasting a SELECT into chat for the owner to run. That
// costs an interruption and puts the production DSN in front of a person for a
// read. Actions already holds `secrets.DATABASE_URL` for the deploy.
//
// THE OUTPUT IS THE ANSWER, not a pass/fail. Three shapes, and none of them is
// an error:
//
//   AGREES   -> stored value == the fallback. Nothing changes for that priority.
//   DIFFERS  -> a manager's edit that was being ignored. It now takes effect on
//               NEW cases and on priority changes. Existing deadlines are NOT
//               recomputed (mig 065 says so, and that stays true).
//   BLANK    -> sla_hours IS NULL. The fallback is used, exactly as the UI's
//               "blank = use module default" promises.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job would read as "the check broke". Only an
// unreachable database or a query error exits non-zero.
//
// RE-RUN: safe and identical. It writes nothing.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// Must stay equal to SLA_HOURS_BY_PRIORITY in src/services/assr.ts. Pinned by
// backend/tests/assrSlaFallbackMirror.test.ts, which fails if they drift.
export const FALLBACK_SLA_HOURS = {
  low: 336,
  normal: 168,
  high: 72,
  urgent: 24,
};

// Same resolution order as pg-migrate.mjs: env wins so CI needs no .dev.vars.
function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

/** Pure classifier so the verdict logic is testable without a database. */
export function classify(row, fallback = FALLBACK_SLA_HOURS) {
  const stored = row.sla_hours == null ? null : Number(row.sla_hours);
  const known = Object.prototype.hasOwnProperty.call(fallback, row.slug);
  const effective = stored != null && Number.isFinite(stored) && stored > 0
    ? stored
    : (known ? fallback[row.slug] : 168);
  if (stored == null) return { verdict: "BLANK", effective };
  if (!known) return { verdict: "CUSTOM", effective };
  if (effective === fallback[row.slug]) return { verdict: "AGREES", effective };
  return { verdict: "DIFFERS", effective };
}

// Only run the database half when executed directly, so a test can import the
// pure parts above without opening a connection.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const url = resolveUrl();
  if (!url) {
    console.error("DATABASE_URL not set (env var or .dev.vars). Aborting.");
    process.exit(1);
  }

  const notice = (msg) =>
    console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

  const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = await pg`
      SELECT slug, name, sla_hours, active
        FROM assr_priorities
       ORDER BY sort_order, slug
    `;

    if (rows.length === 0) {
      // Evidence is not a setting: an empty lookup table is its own finding.
      // Do NOT seed it to make this read tidier.
      notice("assr_priorities is EMPTY in production. Every case falls back to the hardcoded window. That is the finding — do not seed rows to tidy this output.");
      process.exit(0);
    }

    console.log("slug            active  stored  fallback  effective  verdict");
    const differs = [];
    for (const r of rows) {
      const { verdict, effective } = classify(r);
      const fb = FALLBACK_SLA_HOURS[r.slug] ?? "-";
      console.log(
        `${String(r.slug).padEnd(15)} ${String(r.active).padEnd(6)}  ${String(r.sla_hours ?? "-").padEnd(6)}  ${String(fb).padEnd(8)}  ${String(effective).padEnd(9)}  ${verdict}`,
      );
      if (verdict === "DIFFERS" || verdict === "CUSTOM") differs.push(`${r.slug}: ${effective}h`);
    }

    notice(
      differs.length === 0
        ? `All ${rows.length} priorities match the hardcoded fallback. Making the column live changes NO deadline.`
        : `${differs.length} of ${rows.length} priorities carry an edited window that was being ignored and now takes effect on NEW cases: ${differs.join(", ")}. Deadlines already on existing cases are NOT recomputed.`,
    );
    process.exit(0);
  } catch (e) {
    console.error("Query failed:", e?.message ?? e);
    process.exit(1);
  } finally {
    await pg.end({ timeout: 5 });
  }
}
