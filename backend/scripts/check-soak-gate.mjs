// Read-only report on the idempotency phase-1 soak marker — the merge gate for
// PR #912 (and therefore #927, whose migrations stack on #912's).
//
// WHY THIS EXISTS AS A SCRIPT AND A WORKFLOW
//
// The answer lives in production's `app_settings` and nowhere else, so every
// time somebody asked "can #912 merge yet?" the only way to answer was for a
// human holding the production password to open a SQL console and paste a
// query. That made a routine yes/no question cost an owner interruption, and
// it put the production DSN in front of a person for a SELECT. Both are
// avoidable: GitHub Actions already holds `secrets.DATABASE_URL` for the
// deploy, so the check can run there and nobody needs the credential.
//
// THE MARKER IS EVIDENCE, NOT A SETTING. It is written by the phase-1 worker
// when it goes live. Three outcomes, and the third is the one that matters:
//
//   gate_will_pass = true   -> 24h have elapsed. #912 may merge.
//   gate_will_pass = false  -> not soaked long enough yet. Wait.
//   ZERO ROWS               -> the phase-1 worker NEVER recorded itself live.
//                              That is a DIFFERENT failure from "not soaked
//                              yet", and it must not be papered over. Do not
//                              merge, and do NOT insert the row by hand:
//                              writing it would forge the very evidence this
//                              gate exists to check, and #912's constraints
//                              would then be applied against a phase-1 that
//                              was never actually running in production.
//
// Strictly one SELECT. No DDL, no writes, no transaction. Exits 0 in all three
// cases — a red job would read as "the check broke", and the whole point is
// that the ANSWER is the output. Only an unreachable database or a query error
// exits non-zero.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const KEY = "rollout.idempotency_phase1_worker_live";

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

// `notice` surfaces the verdict on the workflow run's summary page, so the
// answer is readable without opening the log.
const notice = (msg) =>
  console.log(process.env.GITHUB_ACTIONS ? `::notice::${msg}` : msg);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });

try {
  const rows = await pg`
    SELECT updated_at,
           (now() - (updated_at::timestamp AT TIME ZONE 'UTC')) AS elapsed,
           (now() - (updated_at::timestamp AT TIME ZONE 'UTC')) >= interval '24 hours'
             AS gate_will_pass
    FROM app_settings
    WHERE key = ${KEY}`;

  if (rows.length === 0) {
    notice(`SOAK MARKER MISSING — key '${KEY}' has zero rows.`);
    notice(
      "DO NOT merge #912, and DO NOT insert this row by hand. Zero rows means " +
        "the phase-1 worker never recorded itself live, which is a different " +
        "failure from 'not soaked yet'. Investigate why phase 1 is not running.",
    );
  } else {
    const { updated_at, elapsed, gate_will_pass } = rows[0];
    notice(`marker written at : ${updated_at}`);
    notice(`elapsed since     : ${elapsed}`);
    notice(
      gate_will_pass
        ? "GATE WILL PASS — 24h soak complete. #912 may merge, then #927."
        : "NOT YET — the 24h soak is still running. Re-run this later.",
    );
  }
} finally {
  await pg.end({ timeout: 5 });
}
