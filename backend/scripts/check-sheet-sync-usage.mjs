#!/usr/bin/env node
// Read-only report on scm.sheet_sync_usage — how often the HC Delivery sheet
// calls each /api/delivery-sheet endpoint, and how much it carries.
//
// WHY THIS IS A SCRIPT AND NOT A QUERY IN CHAT. Standing rule in CLAUDE.md:
// never ask the owner to run SQL. The answer lives only in production, so it
// runs on the shared runner (Actions -> "Run a backend script on production",
// script = check-sheet-sync-usage.mjs, mode = plan), which already holds
// secrets.DATABASE_URL. No workflow file of its own: one runner, not one per
// script.
//
// WHAT IT IS FOR. Owner 2026-09-24, auditing the sheet's Apps Script: a script
// unused for a MONTH gets isolated and backed up; one unused for THREE MONTHS
// comes back to him for a delete decision. That rule needs evidence that does
// not expire, which is what the counter table is (see its migration header).
//
// The SQL and the verdict rule live in scripts/lib/sheet-sync-usage-report.mjs
// so tests-pg can run the statement against real Postgres before anyone
// dispatches this.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer — a red job would read as "the check broke", and the
// answer IS the output. Only an unreachable database exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  DELETE_DECISION_AFTER,
  ISOLATE_AFTER,
  SHEET_USAGE_REPORT_SQL,
  usageVerdicts,
} from "./lib/sheet-sync-usage-report.mjs";

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

const notice = (msg) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg.unsafe(SHEET_USAGE_REPORT_SQL);

  if (rows.length === 0) {
    notice("scm.sheet_sync_usage is EMPTY — no authenticated call has been counted yet.");
    notice(
      "That is the expected state until the deploy carrying the counter has been live " +
        "for one sync cycle (the sheet's scheduledErpSync fires every 15 minutes). " +
        "It is NOT evidence that the sheet has stopped calling.",
    );
  } else {
    const age = Number(rows[0].table_age_days);
    notice(`recording since : ${rows[0].recording_since} (${age} day(s) of evidence)`);
    notice("endpoint | calls 7d | rows 7d | calls 30d | errors 30d | calls all | rows all | last call | idle days");
    for (const r of rows) {
      notice(
        `${r.endpoint} | ${r.calls_7} | ${r.rows_7} | ${r.calls_30} | ${r.errors_30} | ` +
          `${r.calls_all} | ${r.rows_all} | ${r.last_day} | ${r.days_idle}`,
      );
    }

    const { stale, dead, failing } = usageVerdicts(rows, age);
    if (stale.length) {
      notice(`ISOLATE CANDIDATES (no call in ${ISOLATE_AFTER}+ days): ${stale.join(", ")}`);
      notice("Back the caller up into reference/ BEFORE emptying it in the live Apps Script project.");
    }
    if (dead.length) {
      notice(`DELETE DECISION DUE (no call in ${DELETE_DECISION_AFTER}+ days): ${dead.join(", ")}`);
      notice("Take this list to the owner; nothing is deleted without his call.");
    }
    if (!stale.length && !dead.length) {
      notice(
        age >= ISOLATE_AFTER
          ? `Every counted endpoint has been called within ${ISOLATE_AFTER} days. Nothing to isolate.`
          : `No endpoint is idle; the table is ${age} day(s) old, so the ${ISOLATE_AFTER}-day rule cannot bite yet.`,
      );
    }

    // An endpoint the sheet still calls but that answers 4xx/5xx is a
    // different failure from an unused one, and the counter is the only place
    // it shows up without opening `wrangler tail`.
    if (failing.length) notice(`ERRORS in the last 30 days: ${failing.join(", ")}`);
  }
} finally {
  await pg.end({ timeout: 5 });
}
