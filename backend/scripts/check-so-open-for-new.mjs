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
//   1. NEW orders created inside the window. If this is zero after a lift,
//      staff cannot save and the lift did not work. "NEW" is decided by
//      soIsMigratedShape — the SAME module the guard decides with — and NOT by
//      `linked_ac_docno IS NULL`, which is what it used to be: the AutoCount
//      write-back sets that column on the ERP's own order, so a successful send
//      deleted the very evidence this check exists to produce
//      (docs/bugs/0703-a-brand-new-sales-order-becomes-read-only-minutes-after-it-i.md).
//   2. Actions recorded against MIGRATED orders inside the window, split into
//      SYSTEM rows (the allocation recompute writes these constantly) and rows
//      a PERSON is credited with. Only the second number is the alarm. The
//      split was added after a real run showed 50 of 50 were the cron.
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
/* The person-vs-machine rule, in its ONE home. */
import { auditMachineSql } from "../src/scm/shared/audit-author.ts";
/* And the came-FROM-AutoCount rule, in ITS one home — the same module the
   middleware decides with, so this check cannot answer a different question
   from the thing it is checking. That is exactly what it used to do: it counted
   NEW orders as `linked_ac_docno IS NULL`, and the AutoCount write-back sets
   that column on the ERP's own order, so a successful send DELETED the evidence
   that the lift had worked (docs/bugs/0703). */
import { soIsMigratedShape } from "../src/scm/lib/so-is-migrated.ts";

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

  /* CLASSIFIED IN JS, BY THE REAL RULE, not by a second copy of it in SQL. The
     corpus is one company's sales-order headers — thousands of rows, three
     columns — so reading them and asking the module is cheap, and it is the
     only way this check can be guaranteed to agree with the guard. */
  const headers = await sql`
    SELECT doc_no, status, linked_ac_docno, created_at
      FROM scm.mfg_sales_orders
     WHERE company_id = ${COMPANY_ID}
  `;
  const native = headers.filter((r) => !soIsMigratedShape(r.doc_no, r.linked_ac_docno));
  const cutoff = Date.now() - HOURS * 3_600_000;
  const inWindow = native
    .filter((r) => new Date(r.created_at).getTime() > cutoff)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const made = { n: inWindow.length, newest: inWindow[0]?.created_at ?? null };
  const everNative = { n: native.length };
  const newest = inWindow.slice(0, 10);

  /* The RAW column count as well, because it is what the old version of this
     check reported and somebody will compare the two. They differ by exactly
     the orders the write-back has sent. */
  const linked = headers.length - native.length;
  log(`(raw \`linked_ac_docno IS NOT NULL\` count, which is NOT the predicate: ${linked} of ${headers.length})`);

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
     lock actually holding?

     CORRECTED 2026-09-08 BY RUNNING IT. The first version of this query said
     "system recomputes do not go through the audit log, so this is close to a
     pure staff signal". Run 34183368917 refuted that in its first line: it
     reported 50 touched migrated orders, every one of them
     `system (auto-allocate)` via `auto-allocation` / `automation` — the stock
     allocation recompute writes UPDATE_LINE and UPDATE_STATUS rows exactly like
     a person does (scm/lib/so-stock-allocation.ts:998 and :1082). A check that
     cries wolf on every cron tick is a check nobody reads by Wednesday.

     The classification is the audit row's OWN attribution, which is the only
     honest one available: the system rows carry `actor_id IS NULL` AND an
     actor name beginning "system". Everything else is a row a PERSON is
     credited with, and those are the ones printed. An unattributed row that is
     not named "system" counts as a person, deliberately — the permissive
     direction here would be to hide it.
     MOVED TO ONE HOME 2026-09-08. The predicate used to be written out here,
     and two other callers asked the same question with two other answers — the
     delta sync's was wrong in the direction that destroys a salesperson's work
     (docs/bugs/0702). It now comes from src/scm/shared/audit-author.ts, and the
     rule GENERALISED slightly in the move: the `actor_id IS NULL` arm is gone,
     because that column is a constant (middleware/auth.ts pins one uuid onto
     every authenticated caller) and it made so-delivery-sync's own rows read as
     people. Every row this check called system, it still calls system. */
  const SYSTEM_ROW = auditMachineSql("a.actor_name_snapshot");
  /* sql.unsafe with BOUND PARAMETERS, not string interpolation of the values.
     The only thing spliced in is SYSTEM_ROW, which auditMachineSql validates as
     a plain column reference before it builds anything. */
  /* MIGRATED here means the same thing the guard means: it came FROM AutoCount.
     `linked_ac_docno IS NOT NULL` would count the ERP's own written-back orders
     as migrated, which is how HC-SO-2609-001 appeared in this check's "touched
     by a PERSON" alarm on the day it was created (docs/bugs/0703). The doc
     numbers are resolved above, so the SQL takes a list. */
  const migratedDocs = headers
    .filter((r) => soIsMigratedShape(r.doc_no, r.linked_ac_docno))
    .map((r) => r.doc_no);
  const WINDOW = `
      FROM scm.mfg_so_audit_log a
      JOIN scm.mfg_sales_orders so ON so.doc_no = a.so_doc_no
     WHERE so.company_id = $1
       AND so.doc_no = ANY($3)
       AND a.created_at > now() - make_interval(hours => $2::int)`;

  const [systemCount] = await sql.unsafe(
    `SELECT count(*)::int AS n ${WINDOW} AND ${SYSTEM_ROW}`,
    [COMPANY_ID, HOURS, migratedDocs],
  );

  const touched = await sql.unsafe(
    `SELECT a.so_doc_no, a.action, a.actor_name_snapshot, a.source, a.created_at ${WINDOW}
       AND NOT ${SYSTEM_ROW}
     ORDER BY a.created_at DESC
     LIMIT 50`,
    [COMPANY_ID, HOURS, migratedDocs],
  );

  log(
    `MIGRATED orders touched by the SYSTEM in the last ${HOURS}h: ${systemCount.n}`
    + " (stock-allocation recompute and friends — expected, not a breach)",
  );
  if (touched.length === 0) {
    log(`MIGRATED orders touched by a PERSON in the last ${HOURS}h: 0 — the lock is holding.`);
  } else {
    warn(`MIGRATED orders touched by a PERSON in the last ${HOURS}h: ${touched.length} (capped at 50).`);
    warn("An scm.admin / owner account BYPASSES the lock by design, so check WHO before calling this a breach.");
    for (const t of touched) {
      warn(`  ${t.so_doc_no}  ${t.action}  by ${t.actor_name_snapshot ?? "(unnamed)"}  via ${t.source ?? "?"}  ${myt(t.created_at)} MYT`);
    }
  }

  log("read-only: this script never writes, and it cannot save an order for you.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
