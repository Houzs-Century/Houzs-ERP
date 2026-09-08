#!/usr/bin/env node
// Delete a TEST Sales Order (2990- or bare) + all its child rows.
//
// Purpose: on 2990 POS you sometimes need to run a real handover to
// smoke-test the flow, which mints a real doc_no + eats a sequence slot.
// This removes that row and every child it owns.
//
// IT DOES NOT GIVE THE NUMBER BACK. Since migration 0316 the doc_no comes
// from scm.doc_number_counters, which only ever goes UP; the surviving rows
// are a FLOOR, not the source. So the deleted number becomes a permanent
// gap and the run says so at the end, reading the counter rather than
// reasoning about it. To reclaim the number, run scripts/reclaim-doc-no.mjs
// (Actions -> "Reclaim a document number"), which refuses unless the number
// is genuinely free.
//
// SAFETY:
//   - MODE=plan by default: prints every row it would touch AND the FULL
//     content of the document, every column, and writes nothing. MODE=apply
//     deletes. APPLY=1 is still accepted as the older spelling of MODE=apply.
//   - APPLY additionally requires CONFIRM_DOC to equal DOC_NO — a
//     destructive prod write should never ride on one typed field
//   - REFUSES if the SO has ANY downstream document (DO / SI / etc.) or
//     more than one payment row — a real customer order, not a test
//   - REFUSES if the SO is CLOSED / INVOICED / DELIVERED — same reason
//   - REFUSES if a PWP voucher this SO issued was already USED, or if a
//     voucher earned elsewhere was redeemed ON this SO (see the PWP
//     section below) — deleting either would destroy the audit trail of
//     a voucher that is still in circulation
//   - SWEEPS THE LIVE SCHEMA for every column that could name this document,
//     and REFUSES on any reference it does not recognise. The hand-written
//     CHILD_TABLES list below was incomplete for a year — scm.so_revisions,
//     scm.so_amendment_lines, scm.mfg_so_item_deletions and scm.so_mirror_skips
//     all carry a sales-order doc_no and NONE of them was probed — so that list
//     is no longer the only thing standing between a delete and a silent
//     orphan. What the sweep finds is CLASSIFIED, never cascaded into: a table
//     nobody has classified stops the run instead of being deleted from.
//   - Runs the deletes in a single transaction; nothing writes unless
//     everything succeeds
//   - VERIFIES ON A FRESH CONNECTION and asserts the SHAPE — the document and
//     every child gone, the append-only audit trail deliberately still there,
//     and a CONTROL proving no OTHER sales order, line or payment moved
//
// EXIT CODE: 0 for every legitimate answer, INCLUDING a refusal — a
// refusal is a verdict, not a malfunction, and a red job reads as "the
// script broke". Only an unreachable DB or a failed transaction exits
// non-zero.
//
// Usage:  DOC_NO=2990-SO-2607-019 [CONFIRM_DOC=… APPLY=1] node scripts/delete-test-so.mjs
//
// RE-RUN: inert. A second apply finds nothing and says so; it cannot delete
// twice.
//
// THERE IS NO UNDO, AND THE RECOVERY PATH IS THE RUN LOG. Before it writes
// anything this prints the header row, every line row and every payment row as
// complete JSON — every column, including the sofa `variants` build — so the
// document can be re-keyed by hand from that output if a ruling is ever
// reversed. Keep the run URL with the bug-ledger entry, and put the JSON in the
// entry too: an Actions log is kept for 90 days, a repo file forever.
import postgres from "postgres";
/* The SQL this script cannot run anywhere but production lives here, so CI's
   postgres:16 can run it first — tests-pg/deleteTestSoRefs.pg.test.ts. */
import {
  AUDIT, AUDIT_KEEP, CHILD, DOWNSTREAM, UNCLASSIFIED,
  classifyReference, controlDrift, controlSnapshot, sweepReferences,
} from "./lib/delete-test-so-refs.mjs";

const DST = process.env.DATABASE_URL;
const DOC_NO = (process.env.DOC_NO ?? "").trim();
const CONFIRM_DOC = (process.env.CONFIRM_DOC ?? "").trim();
/* MODE=plan is the default and writes nothing. APPLY=1 stays valid because it
   is what every runbook and every previous run of this script used; it is now
   just another spelling of MODE=apply. An unrecognised MODE stops the run — a
   typo must never fall through to the writing branch. */
const MODE = (process.env.MODE || (process.env.APPLY === "1" ? "apply" : "plan")).trim().toLowerCase();
if (MODE !== "plan" && MODE !== "apply") {
  console.error(`MODE must be "plan" or "apply"; got ${JSON.stringify(process.env.MODE)}`);
  process.exit(2);
}
const APPLY = MODE === "apply";
/* An unclassified reference stops the run. Set this to leave those rows in
   place as orphans and delete anyway — a deliberate, named act. */
const ALLOW_ORPHAN_REFS = process.env.ALLOW_ORPHAN_REFS === "yes";
// A voucher earned on another order and redeemed on THIS one is money the
// customer still owns. Opt in to hand it back (status -> AVAILABLE) rather
// than letting the delete silently consume it.
const RESTORE_REDEEMED = process.env.RESTORE_REDEEMED === "1";

if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
if (!DOC_NO) { console.error("need DOC_NO env (e.g. 2990-SO-2607-019)"); process.exit(2); }

const db = postgres(DST, { ssl: "require", prepare: false, max: 1 });

// A refusal ends the run with a verdict and exit 0. Distinct from a thrown
// Error, which means the script itself failed.
class Refused extends Error {}
const refuse = (msg) => { throw new Refused(msg); };

// Every table that carries a reference to scm.mfg_sales_orders. Column names
// vary — items link on `doc_no`, payments on `so_doc_no` (the FK in
// 2990s-full-schema.sql), amendments on `so_doc_no` (mig 0080), and older
// trees used `doc_no` for payments too. Each entry lists the column names it
// may live under and the runner resolves the real one against the LIVE
// schema, so a rename downgrades to "skip" rather than silently counting 0 —
// which is what made the payments guard below unreachable before.
const CHILD_TABLES = [
  { table: "scm.mfg_sales_order_items",    cols: ["doc_no"] },
  { table: "scm.mfg_sales_order_payments", cols: ["so_doc_no", "doc_no"] },
  { table: "scm.mfg_sales_order_activity", cols: ["doc_no"] },
  { table: "scm.so_amendments",            cols: ["so_doc_no"] },
];

// Resolve which of `cols` actually exists on (schema, table) in THIS database.
// Returns null when the table or every candidate column is absent (D1 mirror,
// pre-migration, or a rename we haven't caught yet). Uses information_schema —
// cheap, and it is the live DB talking, not a migration file.
async function resolveCol(db, qualified, cols) {
  const [schema, table] = qualified.split(".");
  const rows = await db`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = ${schema} AND table_name = ${table}
       AND column_name = ANY(${cols}::text[])`;
  const found = new Set(rows.map((r) => r.column_name));
  return cols.find((c) => found.has(c)) ?? null;
}

async function main() {
  console.log(`\n== delete-test-so :: DOC_NO=${DOC_NO} MODE=${MODE} ==\n`);

  if (APPLY && CONFIRM_DOC !== DOC_NO) {
    refuse(
      `CONFIRM_DOC must repeat the doc_no exactly to apply. ` +
      `Got DOC_NO="${DOC_NO}" CONFIRM_DOC="${CONFIRM_DOC || "(empty)"}".`,
    );
  }

  // (1) Load the parent row + its critical state fields. has_children is a
  // COMPUTED field on this codebase (stamped at query time from downstream
  // tables — see scm/routes/consignment-notes.ts et al.), NOT a stored
  // column. The check runs below via direct downstream-table scans.
  const [so] = await db`
    SELECT doc_no, status, proceeded_at, company_id, created_at
      FROM scm.mfg_sales_orders
     WHERE doc_no = ${DOC_NO}`;
  if (!so) {
    console.log(`SO ${DOC_NO} NOT FOUND. Nothing to delete.`);
    return;
  }
  console.log(`Parent  : ${DOC_NO}  status=${so.status}  company_id=${so.company_id}  proceeded_at=${so.proceeded_at ?? "—"}`);

  /* (1b) THE RECOVERY PATH. There is no undo, so the only way back is to be
     able to re-key the document by hand — which needs every column, not the
     handful printed above. This runs in BOTH modes and BEFORE the delete, so
     the apply run's own log carries the document it removed. */
  const capture = {};
  for (const [label, table, cols] of [
    ["header", "scm.mfg_sales_orders", ["doc_no"]],
    ["items", "scm.mfg_sales_order_items", ["doc_no"]],
    ["payments", "scm.mfg_sales_order_payments", ["so_doc_no", "doc_no"]],
    ["activity", "scm.mfg_sales_order_activity", ["doc_no"]],
  ]) {
    /* resolveCol asks information_schema, so a table that is not in this
       database yields null rather than "relation does not exist". Production
       has no scm.mfg_sales_order_activity (run 34220089049), and a capture
       that assumed it did would have thrown before printing a single row. */
    const c = await resolveCol(db, table, cols);
    if (!c) { capture[label] = `(${table} is not in this database — nothing to capture)`; continue; }
    capture[label] = await db.unsafe(`SELECT * FROM ${table} WHERE ${c} = $1`, [DOC_NO]);
  }
  console.log("");
  console.log(`CONTENT OF ${DOC_NO} — the complete record, printed BEFORE any write.`);
  console.log("If a ruling is reversed, this JSON is what the document is re-keyed from.");
  console.log("---8<--- capture begin ---8<---");
  console.log(JSON.stringify(capture, null, 2));
  console.log("---8<--- capture end ---8<---");
  console.log("");

  // (2) Refuse on any signal this is not a fresh test SO.
  const finalStatuses = new Set(["INVOICED", "DELIVERED", "CLOSED", "SHIPPED"]);
  if (finalStatuses.has(String(so.status).toUpperCase())) {
    refuse(`status=${so.status} — this SO has moved past CONFIRMED. Not a test row.`);
  }

  // Downstream-doc check: probe delivery_orders + sales_invoices + delivery_returns
  // for any row that references this SO. Any hit → real order, not a test.
  // Tables are read via to_regclass so a missing schema element (D1 mirror,
  // pre-migration) doesn't blow the script — the probe just returns 0.
  // delivery_returns is transitive via delivery_orders (a DR can't exist
  // without a DO), so probing DOs covers it. If DOs are 0, DRs are 0 by FK.
  // Both FKs are ON DELETE SET NULL, so a hit here would not block the delete —
  // it would silently orphan a real document. That is exactly why this refuses.
  const downstreamProbes = [
    { table: "scm.delivery_orders",    col: "so_doc_no" },
    { table: "scm.sales_invoices",     col: "so_doc_no" },
  ];
  let downstreamTotal = 0;
  for (const p of downstreamProbes) {
    const exists = await db.unsafe(`SELECT to_regclass('${p.table}') AS t`);
    if (!exists[0].t) { console.log(`Probe   : ${p.table.padEnd(40)} (schema absent — skip)`); continue; }
    const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${p.table} WHERE ${p.col} = $1`, [DOC_NO]);
    downstreamTotal += rows[0].n;
    console.log(`Probe   : ${p.table.padEnd(40)} downstream rows=${rows[0].n}`);
  }
  if (downstreamTotal > 0) {
    refuse(`${downstreamTotal} downstream doc row(s) reference ${DOC_NO}. Not a test SO.`);
  }

  /* (2b) THE SWEEP. The two probes above are a hand-written list, and this
     script's hand-written lists have been incomplete before. Ask the live
     schema instead: every text column in scm/public whose name could hold a
     document number, counted against this one. Then classify what came back.
     Nothing here deletes; the sweep decides whether the delete may proceed. */
  const sweep = await sweepReferences(db, DOC_NO);
  console.log("");
  console.log(`REFERENCE SWEEP — ${sweep.scanned} candidate columns in the live schema`);
  if (sweep.failed.length) {
    for (const f of sweep.failed) console.log(`  UNREADABLE  ${f.table}.${f.column}  ${f.why}`);
  }
  if (sweep.hits.length === 0) {
    console.log(`  nothing anywhere in the database names ${DOC_NO}`);
  }
  const childTableNames = new Set(CHILD_TABLES.map((t) => t.table));
  const LEGEND = {
    [CHILD]: "CHILD        — deleted with the order",
    [AUDIT]: "AUDIT        — deliberately KEPT (append-only record)",
    [DOWNSTREAM]: "DOWNSTREAM   — a real document; this REFUSES",
    [UNCLASSIFIED]: "UNCLASSIFIED — nobody has said what this is",
  };
  const orphans = [];
  for (const h of sweep.hits) {
    const kind = classifyReference(h.table, childTableNames);
    console.log(`  ${String(h.n).padStart(5)} row(s)  ${`${h.table}.${h.column}`.padEnd(46)} ${LEGEND[kind]}`);
    if (kind === UNCLASSIFIED) orphans.push(h);
    if (kind === DOWNSTREAM) {
      refuse(`${h.n} row(s) in ${h.table}.${h.column} reference ${DOC_NO}. That is a real downstream document.`);
    }
  }
  console.log("");
  if (sweep.failed.length > 0) {
    refuse(
      `${sweep.failed.length} column(s) could not be counted (${sweep.failed.map((f) => `${f.table}.${f.column}`).join(", ")}). ` +
      "A count that did not run is not a zero.",
    );
  }
  if (orphans.length > 0 && !ALLOW_ORPHAN_REFS) {
    refuse(
      `${orphans.length} reference(s) nobody has classified: ` +
      orphans.map((h) => `${h.table}.${h.column} (${h.n})`).join(", ") +
      ". Deleting would leave them pointing at a document that does not exist. Classify them in " +
      "CHILD_TABLES / AUDIT_KEEP / DOWNSTREAM_TABLES, or re-run with ALLOW_ORPHAN_REFS=yes to " +
      "leave them behind on purpose.",
    );
  }
  if (orphans.length > 0) {
    console.log(`ALLOW_ORPHAN_REFS=yes — ${orphans.length} unclassified reference(s) will be LEFT BEHIND as orphans.`);
    console.log("");
  }

  // (3) Discover every row that references it. Print BEFORE deleting so the
  // dry-run is a complete picture, not a summary that hides something.
  // A (table, col) that isn't in the live schema logs "skip" rather than
  // crashing — but it is reported as a skip, never as a zero count.
  const childCounts = {};
  const childCols = {};
  for (const t of CHILD_TABLES) {
    const col = await resolveCol(db, t.table, t.cols);
    childCols[t.table] = col;
    if (!col) {
      console.log(`Child   : ${t.table.padEnd(40)} ${t.cols.join("|").padEnd(12)} (table/column missing — skip)`);
      childCounts[t.table] = null;
      continue;
    }
    const rows = await db.unsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${col} = $1`, [DOC_NO]);
    childCounts[t.table] = rows[0].n;
    console.log(`Child   : ${t.table.padEnd(40)} ${col.padEnd(12)} rows=${rows[0].n}`);
  }

  // Payments guard — a test SO usually has one drafted payment (the tap on
  // "Cash 100%" in the handover). Refuse on multiple payments — that hints
  // at a real customer that partially paid. A null count means the column
  // could not be resolved: refuse rather than pass a guard we did not run.
  const paymentCount = childCounts["scm.mfg_sales_order_payments"];
  if (paymentCount === null) {
    refuse("could not resolve the payments doc-no column — the payments guard did not run.");
  }
  if (paymentCount > 1) {
    refuse(`${paymentCount} payments recorded — likely a real order (more than one transaction). Manual review needed.`);
  }

  // (4) PWP vouchers. scm.pwp_codes carries NO foreign key to the SO
  // (source_doc_no / redeemed_doc_no are plain text — 2990s-full-schema.sql
  // :1220), so nothing cascades here: deleting the SO would leave a live,
  // redeemable voucher pointing at a doc_no that no longer exists. A POS
  // handover mints these at Confirm (RESERVED -> AVAILABLE), which is exactly
  // what a smoke-test order leaves behind.
  //
  //   issued BY this SO  (source_doc_no)    -> deleted with the order
  //     · any of them already USED          -> REFUSE (someone spent it on a
  //       real order; deleting the origin row erases where it came from)
  //   redeemed ON this SO (redeemed_doc_no) -> earned elsewhere, still the
  //     customer's. REFUSE unless RESTORE_REDEEMED=1, which hands it back
  //     (status -> AVAILABLE, redemption fields cleared).
  const pwpTable = await db.unsafe(`SELECT to_regclass('scm.pwp_codes') AS t`);
  const havePwp = Boolean(pwpTable[0].t);
  let issued = [];
  let redeemedHere = [];
  if (!havePwp) {
    console.log(`PWP     : ${"scm.pwp_codes".padEnd(40)} (table absent — skip)`);
  } else {
    issued = await db`
      SELECT code, status FROM scm.pwp_codes WHERE source_doc_no = ${DOC_NO} ORDER BY code`;
    redeemedHere = await db`
      SELECT code, status FROM scm.pwp_codes WHERE redeemed_doc_no = ${DOC_NO} ORDER BY code`;
    console.log(`PWP     : issued by this SO   rows=${issued.length}${issued.length ? "  " + issued.map((r) => `${r.code}(${r.status})`).join(" ") : ""}`);
    console.log(`PWP     : redeemed on this SO rows=${redeemedHere.length}${redeemedHere.length ? "  " + redeemedHere.map((r) => `${r.code}(${r.status})`).join(" ") : ""}`);

    const spent = issued.filter((r) => String(r.status).toUpperCase() === "USED");
    if (spent.length > 0) {
      refuse(
        `${spent.length} voucher(s) issued by ${DOC_NO} were already USED ` +
        `(${spent.map((r) => r.code).join(", ")}). They were spent on another order — ` +
        `deleting this SO would erase where they came from.`,
      );
    }
    if (redeemedHere.length > 0 && !RESTORE_REDEEMED) {
      refuse(
        `${redeemedHere.length} voucher(s) earned elsewhere were redeemed ON ${DOC_NO} ` +
        `(${redeemedHere.map((r) => r.code).join(", ")}). Deleting the order would consume them ` +
        `for nothing. Re-run with RESTORE_REDEEMED=1 to hand them back as AVAILABLE.`,
      );
    }
  }

  /* (4b) THE CONTROL. "Nothing else moved" is a claim, and a row count of the
     thing you deleted is not evidence for it. This fingerprints the whole
     sales-order corpus EXCLUDING this document, before and after, so the
     verification can assert that every OTHER order, line and payment is
     byte-for-byte the same set. */
  /* The header's document total, whatever this schema calls it. `local_total_sen`
     is FIRST because it is what production actually has — the earlier list led
     with `total_sen`, which is not a column on scm.mfg_sales_orders at all, so
     the money arm of the control would have resolved to null and quietly proved
     nothing (measured from the captured header, run 34220446297).

     NOT a payment column. `paid_sen`, `deposit_sen` and `balance_sen` are
     deliberately absent from this list and from everything else here. */
  const moneyCol = await resolveCol(db, "scm.mfg_sales_orders",
    ["local_total_sen", "total_revenue_sen", "total_sen", "grand_total_sen",
      "net_total_sen", "total_amount_sen"]);
  if (!moneyCol) {
    console.log("NOTE    : no document-total column resolved — the CONTROL's money arm is inert on this schema.");
  }
  const payCol = childCols["scm.mfg_sales_order_payments"];
  const control = (client) => controlSnapshot(client, DOC_NO, { moneyCol, payCol });
  const beforeCtl = await control(db);
  console.log("CONTROL (every sales order EXCEPT this one) — BEFORE");
  console.log(`  orders=${beforeCtl.so_rows}  lines=${beforeCtl.item_rows}  payments=${beforeCtl.pay_rows ?? "n/a"}`);
  console.log(`  ${moneyCol ?? "money"}=${beforeCtl.money_sum ?? "n/a"}  fingerprint=${beforeCtl.so_fingerprint}`);
  console.log("");

  if (!APPLY) {
    console.log(`PLAN complete. Nothing was written.`);
    console.log(`To actually delete: MODE=apply CONFIRM_DOC=${DOC_NO}`);
    return;
  }

  // (5) Delete in one transaction. FK CASCADEs will do their work; the manual
  // deletes here cover the tables that don't declare CASCADE, and are safe
  // no-ops on the ones that do. Skip any (table, col) missing from the
  // live schema — reusing the columns resolved in (3).
  await db.begin(async (sql) => {
    if (havePwp) {
      if (redeemedHere.length > 0) {
        const r = await sql`
          UPDATE scm.pwp_codes
             SET status = 'AVAILABLE', redeemed_doc_no = NULL, redeemed_item_code = NULL,
                 updated_at = now()
           WHERE redeemed_doc_no = ${DOC_NO}`;
        console.log(`Restored: ${"scm.pwp_codes (redeemed here)".padEnd(40)} rows=${r.count} -> AVAILABLE`);
      }
      const r = await sql`DELETE FROM scm.pwp_codes WHERE source_doc_no = ${DOC_NO}`;
      console.log(`Deleted : ${"scm.pwp_codes (issued by)".padEnd(40)} rows=${r.count}`);
    }
    for (const t of CHILD_TABLES) {
      const col = childCols[t.table];
      if (!col) continue;
      const r = await sql.unsafe(`DELETE FROM ${t.table} WHERE ${col} = $1`, [DOC_NO]);
      console.log(`Deleted : ${t.table.padEnd(40)} rows=${r.count}`);
    }
    const r = await sql`DELETE FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`;
    console.log(`Deleted : ${"scm.mfg_sales_orders".padEnd(40)} rows=${r.count}`);
    if (r.count !== 1) throw new Error(`expected to delete exactly 1 SO row, deleted ${r.count} — rolled back`);
  });

  /* (6) AFTER-STATE PROOF, ON A FRESH CONNECTION. The connection that did the
     writing can answer from its own session state; a second client cannot. And
     the assertion is the SHAPE, not a row count: the document and every child
     gone, the append-only audit trail still there, and the control set
     unchanged to the byte. A mismatch THROWS — an exit 1 here means the
     database is not in the state this run reported, which is not a verdict. */
  const verify = postgres(DST, { ssl: "require", prepare: false, max: 1 });
  const shape = [];
  try {
    const [check] = await verify`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`;
    console.log(`\nAfter (fresh connection):`);
    console.log(`  parent ${DOC_NO} rows=${check.n}  ${check.n === 0 ? "gone" : "STILL PRESENT"}`);
    if (check.n !== 0) shape.push(`the parent row is still present (${check.n})`);

    for (const t of CHILD_TABLES) {
      const col = childCols[t.table];
      if (!col) continue;
      const [r] = await verify.unsafe(`SELECT count(*)::int AS n FROM ${t.table} WHERE ${col} = $1`, [DOC_NO]);
      console.log(`  ${t.table.padEnd(40)} ${col.padEnd(12)} rows=${r.n}`);
      if (r.n !== 0) shape.push(`${t.table}.${col} still has ${r.n} row(s)`);
    }

    if (havePwp) {
      const [pwpLeft] = await verify`
        SELECT count(*)::int AS n FROM scm.pwp_codes
         WHERE source_doc_no = ${DOC_NO} OR redeemed_doc_no = ${DOC_NO}`;
      console.log(`  vouchers still pointing at ${DOC_NO}: ${pwpLeft.n}`);
      if (pwpLeft.n !== 0) shape.push(`${pwpLeft.n} voucher(s) still point at ${DOC_NO}`);
    }

    /* Re-sweep. Everything that survives must be something AUDIT_KEEP names, or
       an orphan the operator asked for out loud. Anything else is a table this
       script deleted the parent out from under. */
    const after = await sweepReferences(verify, DOC_NO);
    console.log(`  reference sweep: ${after.hits.length} table(s) still name ${DOC_NO}`);
    for (const h of after.hits) {
      const kept = AUDIT_KEEP.has(h.table);
      console.log(`    ${String(h.n).padStart(5)}  ${h.table}.${h.column}  ${kept ? "AUDIT — kept on purpose" : "UNEXPECTED"}`);
      if (!kept && !ALLOW_ORPHAN_REFS) shape.push(`${h.table}.${h.column} still names the deleted document`);
    }
    if (after.failed.length) shape.push(`${after.failed.length} column(s) could not be re-read`);

    const afterCtl = await control(verify);
    console.log("  CONTROL (every sales order EXCEPT this one) — AFTER");
    console.log(`    orders=${afterCtl.so_rows}  lines=${afterCtl.item_rows}  payments=${afterCtl.pay_rows ?? "n/a"}`);
    console.log(`    ${moneyCol ?? "money"}=${afterCtl.money_sum ?? "n/a"}  fingerprint=${afterCtl.so_fingerprint}`);
    for (const k of controlDrift(beforeCtl, afterCtl)) {
      shape.push(`CONTROL ${k} moved: ${beforeCtl[k]} -> ${afterCtl[k]} — another document changed`);
    }
    if (shape.length === 0) {
      console.log("  SHAPE OK: the document and its children are gone, the audit trail is intact,");
      console.log("  and every other sales order, line and payment is unchanged.");
    }
  } finally {
    await verify.end();
  }
  if (shape.length > 0) {
    throw new Error(`VERIFICATION FAILED — ${shape.join("; ")}`);
  }

  // (7) What the next save will ACTUALLY take. Read the counter, do not reason
  // about it: since migration 0316 the number comes from
  // scm.doc_number_counters and `scm.next_doc_no_n` returns
  // GREATEST(next_n, liveMax + 1), so the surviving rows are only a FLOOR and a
  // delete cannot pull the counter down.
  //
  // CORRECTED 2026-08-30. This block used to end "next mint reclaims the gap on
  // its own", which was true before 0316 and false after it. It printed that
  // sentence to the operator on the run that deleted 2990-SO-2608-067 while the
  // counter sat at 68, so the number was skipped and the report said it was
  // not. A stale claim a tool PRINTS is worse than one in a doc — nobody can
  // ask the tool whether it checked.
  const prefix = DOC_NO.replace(/\d+$/, "%");
  const [maxRow] = await db.unsafe(
    `SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`,
    [prefix],
  );
  const liveMax = Number(/(\d+)$/.exec(maxRow?.doc_no ?? "")?.[1] ?? 0);
  console.log(`Highest ${prefix} now : ${maxRow?.doc_no ?? "(none)"}`);

  const series = DOC_NO.replace(/-\d+$/, "");
  const [haveCounter] = await db`
    SELECT count(*)::int AS n FROM information_schema.tables
     WHERE table_schema = 'scm' AND table_name = 'doc_number_counters'`;
  if (!haveCounter.n) {
    console.log(`Counter : scm.doc_number_counters ABSENT (pre-migration 0316) — the next mint is max+1, so it reclaims ${DOC_NO}.`);
    return;
  }
  const [counter] = await db`
    SELECT next_n FROM scm.doc_number_counters WHERE series = ${series}`;
  if (!counter) {
    console.log(`Counter : no row for series ${series} — it self-seeds from the live max, so the next mint reclaims ${DOC_NO}.`);
    return;
  }
  const nextSuffix = Math.max(Number(counter.next_n), liveMax + 1);
  const nextDocNo = `${series}-${String(nextSuffix).padStart(3, "0")}`;
  console.log(`Counter : ${series} next_n=${counter.next_n} — the NEXT save will take ${nextDocNo}.`);
  if (nextDocNo !== DOC_NO) {
    console.log(`WARNING : ${DOC_NO} is now a PERMANENT GAP. The counter only ever goes up (migration 0316),`);
    console.log(`WARNING : so deleting the newest document of a month does NOT return its number.`);
    console.log(`WARNING : To hand it back:  SERIES=${series} TARGET_N=${Number(/(\d+)$/.exec(DOC_NO)[1])} node scripts/reclaim-doc-no.mjs`);
    console.log(`WARNING : (or Actions -> "Reclaim a document number"). It refuses unless the number is genuinely free.`);
  }
}

main().then(() => db.end()).catch(async (e) => {
  if (e instanceof Refused) {
    console.log(`\nREFUSED: ${e.message}`);
    console.log("Nothing was written. This is a verdict, not a failure.");
    await db.end();
    return;
  }
  console.error("DELETE_FAIL:", e.message);
  await db.end();
  process.exit(1);
});
