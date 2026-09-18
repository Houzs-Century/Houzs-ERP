#!/usr/bin/env node
// set-relink-sweep — turn the keyless-conversion sweep off / plan / apply.
//
// Writes scm.app_config['scm.autocount_relink_sweep'], which the Worker cron
// reads (scm/lib/autocount-relink-sweep.ts): 'off'/absent = no-op, 'plan' =
// report only (writes nothing to the account book), 'apply' = stamp the book's
// line keys onto our rows then queue the keyed edit the drain sends. Both this
// AND scm.autocount_writeback must be on for anything to reach the book; the
// relink half writes only line identity either way.
//
// TWO GATES, because this ends in a switch next to a live account book:
//   MODE     plan (DEFAULT) shows what it WOULD write and writes nothing;
//            apply writes, and only with the confirm phrase.
//   CONFIRM  must equal 'set-relink-sweep' on the apply path.
// SWEEP is the value to set: off | plan | apply.
//
// RE-RUN: idempotent. A second run with the same SWEEP sets the row to the same
// value and the fresh-connection read-back proves it; nothing accumulates.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }

const KEY = "scm.autocount_relink_sweep";
const CONFIRM_PHRASE = "set-relink-sweep";
const MODE = (process.env.MODE || "plan").trim().toLowerCase();
const SWEEP = (process.env.SWEEP || "").trim().toLowerCase();
const CONFIRM = (process.env.CONFIRM || "").trim();

const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const die = (m) => { console.error(process.env.GITHUB_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };

if (!["off", "plan", "apply"].includes(SWEEP)) {
  die(`SWEEP must be off|plan|apply (got ${JSON.stringify(process.env.SWEEP ?? "")})`);
}

const describe = (v) => {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "apply") return "APPLY — stamp the book's line keys, then queue the keyed edit";
  if (s === "plan") return "PLAN — report only, writes nothing to the account book";
  return "OFF — the sweep does nothing";
};

async function main() {
  const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [before] = await sql`SELECT value FROM scm.app_config WHERE key = ${KEY}`;
  log(`current: ${before ? JSON.stringify(before.value) : "(row absent)"} -> ${describe(before?.value)}`);
  log(`target : ${JSON.stringify(SWEEP)} -> ${describe(SWEEP)}`);

  if (MODE !== "apply") {
    log(`PLAN: nothing written. Re-run with MODE=apply CONFIRM=${CONFIRM_PHRASE} to set it.`);
    await sql.end();
    return;
  }
  if (CONFIRM !== CONFIRM_PHRASE) { await sql.end(); die(`apply needs CONFIRM=${CONFIRM_PHRASE}`); }

  const description = "Keyless-conversion relink sweep (scm/lib/autocount-relink-sweep.ts): off/plan/apply.";
  await sql`INSERT INTO scm.app_config (key, value, description, updated_at)
    VALUES (${KEY}, ${SWEEP}, ${description}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`;
  await sql.end();

  /* Verify on a FRESH connection and assert the SHAPE — the exact value, not a
     row count. "I set it" and "it is set" must not be able to disagree. */
  const sql2 = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const [after] = await sql2`SELECT value FROM scm.app_config WHERE key = ${KEY}`;
  const got = String(after?.value ?? "");
  await sql2.end();
  if (got !== SWEEP) die(`verify FAILED: ${KEY} = ${JSON.stringify(got)}, expected ${JSON.stringify(SWEEP)}. Nothing to trust.`);
  log(`APPLIED: ${KEY} = ${JSON.stringify(got)} -> ${describe(got)} (verified on a fresh connection)`);
  log("takes effect on the next 5-minute cron; watch the 'AutoCount outbox health' workflow after it runs.");
}
main().catch((e) => { console.error(e); process.exit(1); });
