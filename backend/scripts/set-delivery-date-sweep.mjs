#!/usr/bin/env node
// set-delivery-date-sweep — turn the delivery-date sweep off / plan / apply.
//
// Writes scm.app_config['scm.autocount_delivery_date_sweep'], which the Worker
// cron reads (scm/lib/autocount-delivery-date-sweep.ts): 'off'/absent = no-op,
// 'plan' = read the book and report, 'apply' = write the book's delivery date
// onto our rows. It writes only INTO the ERP - nothing here reaches the account
// book - which is the opposite direction from the relink sweep next door.
//
// It also needs the HOST to be on a build that serves /delivery-dates. Until
// deploy-on-host.ps1 runs, 'apply' reads a 404 and reports hostRouteMissing
// rather than failing, so setting this early is harmless.
//
// TWO GATES, because this writes dates the floor plans deliveries against:
//   MODE     plan (DEFAULT) shows what it WOULD write and writes nothing;
//            apply writes, and only with the confirm phrase.
//   CONFIRM  must equal 'set-delivery-date-sweep' on the apply path.
// SWEEP is the value to set: off | plan | apply.
//
// RE-RUN: idempotent. A second run with the same SWEEP sets the row to the same
// value and the fresh-connection read-back proves it; nothing accumulates.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }

const KEY = "scm.autocount_delivery_date_sweep";
const CONFIRM_PHRASE = "set-delivery-date-sweep";
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
  if (s === "apply") return "APPLY — write the book's delivery date onto our sales-order and delivery-order rows";
  if (s === "plan") return "PLAN — read the book and report the differences, write nothing";
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

  const description = "AutoCount delivery-date sweep (scm/lib/autocount-delivery-date-sweep.ts): off/plan/apply.";
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
  log("takes effect on the next 5-minute cron; the run logs as [cron ac-delivery-dates].");
}
main().catch((e) => { console.error(e); process.exit(1); });
