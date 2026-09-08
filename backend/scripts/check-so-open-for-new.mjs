#!/usr/bin/env node
// Read-only: "have new sales orders actually started saving, and are the old
// ones still shut?" — the verification for lifting scm.sales.orders out of the
// write freeze.
//
// WHY IT IS SEPARATE FROM check-write-freeze.mjs. That one reads the SWITCH.
// This one reads the CONSEQUENCE. A switch flipped is intention; an order that
// saved is observation, and this repo's rule is that only the second one counts
// (CLAUDE.md, "Verification is observation, not intention"). Two switches stack
// here — scm.write_freeze decides whether the sales-order MODULE may save at
// all, scm.migrated_so_lock decides whether THIS DOCUMENT may — so this prints
// both rows and then the two facts they are supposed to produce:
//
//   1. NEW orders (linked_ac_docno IS NULL) created inside the window. If this
//      is zero after a lift, staff cannot save and the lift did not work.
//   2. Staff actions recorded against MIGRATED orders inside the window. If this
//      is non-zero after a lift, the migrated lock is NOT holding, and that is
//      the alarm this check exists to raise.
//
// It CANNOT save an order itself, and does not pretend to: a check that wrote
// would not be this pattern. What it proves is that a HUMAN's save landed. The
// step it does not replace is still the runbook's: one ordinary member of staff,
// not an scm.admin account, saves one real order.
//
// Strictly SELECTs. No DDL, no writes, no transaction. Exits 0 for every
// legitimate answer, including "nothing yet" — a red job would read as "the
// check broke". Only an unreachable database exits non-zero.
//
// RE-RUN: safe and expected — the whole point is to run it again a few minutes
// after the lift, and again the next morning. It is a snapshot; re-read it at
// the moment you quote it.
//
// Usage:
//   node scripts/check-so-open-for-new.mjs             # last 24 hours
//   HOURS=2 node scripts/check-so-open-for-new.mjs     # last 2 hours
//   COMPANY_ID=1 node scripts/check-so-open-for-new.mjs
import { readFileSync } from "node:fs";
import postgres from "postgres";

const HOURS = Number(process.env.HOURS || 24);
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error(`HOURS must be a positive number; got ${JSON.stringify(process.env.HOURS)}`);
  process.exit(1);
}
if (!Number.isInteger(COMPANY_ID) || COMPANY_ID <= 0) {
  console.error(`COMPANY_ID must be a positive integer; got ${JSON.stringify(process.env.COMPANY_ID)}`);
  process.exit(1);
}

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
const warn = (m) => console.log(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);

/* Malaysia is the only clock the floor uses, and a UTC timestamp in a go-live
   report has already caused an argument about when something happened. Print
   both, label both. */
const myt = (d) => (d ? new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour12: false }) : "-");

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  const cfg = await sql`
    SELECT key, value, description, updated_at
      FROM scm.app_config
     WHERE key IN ('scm.write_freeze', 'scm.migrated_so_lock')
     ORDER BY key
  `;
  for (const key of ["scm.migrated_so_lock", "scm.write_freeze"]) {
    const row = cfg.find((r) => r.key === key);
    if (!row) {
      /* Evidence, not a setting. An absent row is a real answer and it is a
         DIFFERENT answer for each of these two keys — read the runbooks before
         concluding anything from it. Never insert one to tidy this output. */
      log(`${key}: ROW ABSENT`);
    } else {
      log(`${key} = ${JSON.stringify(row.value)}   (updated ${myt(row.updated_at)} MYT)`);
    }
  }

  const [made] = await sql`
    SELECT count(*)::int AS n,
           max(created_at) AS newest
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID}
       AND linked_ac_docno IS NULL
       AND created_at > now() - make_interval(hours => ${HOURS}::int)
  `;
  const [everNative] = await sql`
    SELECT count(*)::int AS n
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID} AND linked_ac_docno IS NULL
  `;

  const newest = await sql`
    SELECT doc_no, status, created_at
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID}
       AND linked_ac_docno IS NULL
       AND created_at > now() - make_interval(hours => ${HOURS}::int)
     ORDER BY created_at DESC
     LIMIT 10
  `;

  log(
    `NEW orders saved in the last ${HOURS}h (company ${COMPANY_ID}): ${made.n}`
    + ` — of ${everNative.n} ERP-created orders in all`,
  );
  if (made.n === 0) {
    warn(
      "No new order has been saved in this window. After a lift that means staff"
      + " still cannot save; before one it is simply the expected answer.",
    );
  } else {
    log(`newest: ${myt(made.newest)} MYT`);
    for (const r of newest) log(`  ${r.doc_no}  ${r.status}  ${myt(r.created_at)} MYT`);
  }

  /* The other half, and the one nobody would think to look at: is the migrated
     lock actually holding? A staff action on a migrated order lands in the SO
     audit log. System recomputes do not go through it, so this is close to a
     pure staff signal — but read the actions before calling it a breach. */
  const touched = await sql`
    SELECT a.so_doc_no, a.action, a.actor_name_snapshot, a.source, a.created_at
      FROM scm.mfg_so_audit_log a
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
     WHERE so.company_id = ${COMPANY_ID}
       AND so.linked_ac_docno IS NOT NULL
       AND a.created_at > now() - make_interval(hours => ${HOURS}::int)
     ORDER BY a.created_at DESC
     LIMIT 50
  `;
  if (touched.length === 0) {
    log(`MIGRATED orders touched by a staff action in the last ${HOURS}h: 0 — the lock is holding.`);
  } else {
    warn(`MIGRATED orders touched by a staff action in the last ${HOURS}h: ${touched.length} (capped at 50).`);
    warn("An scm.admin / owner account BYPASSES the lock by design, so check WHO before calling this a breach.");
    for (const t of touched) {
      warn(`  ${t.so_doc_no}  ${t.action}  by ${t.actor_name_snapshot ?? "(unnamed)"}  via ${t.source ?? "?"}  ${myt(t.created_at)} MYT`);
    }
  }

  log("read-only: this script never writes, and it cannot save an order for you.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
