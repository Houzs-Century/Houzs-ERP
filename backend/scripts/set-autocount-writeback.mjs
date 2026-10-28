#!/usr/bin/env node
// Turn the ERP -> AutoCount write-back ON or OFF (owner 2026-08-12: "这个帮我 on").
//
// Writes scm.app_config['scm.autocount_writeback']. The runtime reads it with a
// 30s cache (scm/lib/autocount-writeback-flag.ts), so a change takes effect
// within half a minute WITHOUT a deploy — which is the whole reason it is a row
// and not an env var: this switch decides whether ERP documents are written
// into a LIVE licensed AutoCount account book, and it has to be stoppable in
// seconds by somebody who cannot deploy.
//
//   STATE=on|off  COMPANIES="1"|"all"
//
// GRAMMAR, same as the write freeze one line away in the same table:
//   'off' / '' / row absent -> nothing is queued or sent
//   'all'                   -> every company
//   '1' / '1,2'             -> only those companies
//
// VALIDATED BEFORE IT WRITES, and this flag's parser fails CLOSED: a value it
// cannot read means OFF, not ON. That is the safe direction, but it also means
// a typo turns the feature off SILENTLY while looking like it was turned on. So
// the composed value is checked here and a bad one exits non-zero having
// written nothing. The parser also refuses an area clause ('1 - scm.sales.orders'),
// because that is the freeze row's grammar pasted into the wrong key — the two
// rows sit one line apart in app_config.
//
// TURNING IT ON IS NOT THE WHOLE STORY. The send also needs AC_SYNC_URL (a var
// in wrangler.toml) and the AC_SYNC_KEY secret, and neither is visible from the
// database. This script says so on the way out rather than leaving the operator
// to discover it as a wall of failed rows.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }

const STATE = (process.env.STATE || "").trim().toLowerCase();
if (STATE !== "on" && STATE !== "off") { console.error("need STATE=on|off"); process.exit(2); }

const COMPANIES = (process.env.COMPANIES || "1").trim() || "1";
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const fail = (m) => {
  console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`);
  process.exit(2);
};

const value = STATE === "on" ? COMPANIES.toLowerCase() : "off";

/* Mirrors readWritebackScope's acceptance set exactly. Anything it would resolve
   to 'off' is refused here instead, so "I turned it on" and "it is on" cannot
   disagree. */
if (STATE === "on") {
  if (value.includes("-")) {
    fail(
      `COMPANIES ${JSON.stringify(COMPANIES)} contains '-', which is the write-FREEZE row's ` +
      "area grammar. This switch has no per-module meaning and its parser would read the " +
      "whole value as OFF. Pass company ids ('1', '1,2') or 'all'.",
    );
  }
  if (value !== "all" && !/^[0-9]+(\s*,\s*[0-9]+)*$/.test(value)) {
    fail(`COMPANIES ${JSON.stringify(COMPANIES)} is neither 'all' nor a comma-separated id list. Nothing written.`);
  }
}

const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });

const describe = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s || s === "off") return "OFF — nothing is queued or sent";
  if (s === "all") return "ON for EVERY company";
  if (/^[0-9]+(\s*,\s*[0-9]+)*$/.test(s)) return `ON for company ${s}`;
  return "unparseable -> the runtime reads this as OFF";
};

async function main() {
  const [before] = await sql`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  log(`current: ${before ? JSON.stringify(before.value) : "(row absent)"} -> ${describe(before?.value)}`);
  log(`writing: ${JSON.stringify(value)} -> ${describe(value)}`);

  const description = STATE === "on"
    ? "ERP documents are pushed into the live AutoCount account book. Turn off with the same workflow, STATE=off."
    : "ERP -> AutoCount write-back is off. Documents are saved in the ERP only.";

  await sql`INSERT INTO scm.app_config (key, value, description, updated_at)
    VALUES ('scm.autocount_writeback', ${value}, ${description}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;

  const [after] = await sql`SELECT value FROM scm.app_config WHERE key = 'scm.autocount_writeback'`;
  const stored = String(after?.value ?? "off");
  log(`DONE. value=${JSON.stringify(stored)} -> ${describe(stored)}`);
  log("takes effect within ~30s (flag cache TTL)");

  if (STATE === "on") {
    log("NEXT, and none of it is visible from this database:");
    log("  1. AC_SYNC_URL must be set (backend/wrangler.toml) and AC_SYNC_KEY must exist as a Worker secret — `wrangler secret list`. A missing key reaches the host and returns 401 'bad key', which lands as FAILED outbox rows.");
    log("  2. The AutoCount host must be running a build of AcSyncService that returns line keys from create; an older one leaves every new line keyless and its later edits are REFUSED (safe, but they will not sync).");
    log("  3. Watch it: run the 'AutoCount outbox health' workflow after the first document. Rows are the evidence, not this message.");
  } else {
    log("Rows already queued stay PENDING rather than failing — off is not a failure. They resume if it is turned back on.");
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
