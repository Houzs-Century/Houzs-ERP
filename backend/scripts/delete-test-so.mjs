#!/usr/bin/env node
// Delete a TEST Sales Order (2990- or bare) + all its child rows.
//
// Purpose: on 2990 POS you sometimes need to run a real handover to
// smoke-test the flow, which mints a real doc_no + eats a sequence slot.
// This removes that row so the sequence self-heals — the minter's
// `.like('2990-SO-2607-%')` fetch reads max+1 fresh next time, and the
// gap closes naturally.
//
// SAFETY:
//   - DRY-RUN by default (prints every row it would touch)
//   - APPLY additionally requires CONFIRM_DOC to equal DOC_NO — a
//     destructive prod write should never ride on one typed field
//   - REFUSES if the SO has ANY downstream document (DO / SI / etc.) or
//     more than one payment row — a real customer order, not a test
//   - REFUSES if the SO is CLOSED / INVOICED / DELIVERED — same reason
//   - REFUSES if a PWP voucher this SO issued was already USED, or if a
//     voucher earned elsewhere was redeemed ON this SO (see the PWP
//     section below) — deleting either would destroy the audit trail of
//     a voucher that is still in circulation
//   - Runs the deletes in a single transaction; nothing writes unless
//     everything succeeds
//
// EXIT CODE: 0 for every legitimate answer, INCLUDING a refusal — a
// refusal is a verdict, not a malfunction, and a red job reads as "the
// script broke". Only an unreachable DB or a failed transaction exits
// non-zero.
//
// Usage:  DOC_NO=2990-SO-2607-019 [CONFIRM_DOC=… APPLY=1] node scripts/delete-test-so.mjs
//
// RE-RUN: inert. The documents it removes are gone.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
const DOC_NO = (process.env.DOC_NO ?? "").trim();
const CONFIRM_DOC = (process.env.CONFIRM_DOC ?? "").trim();
const APPLY = process.env.APPLY === "1";
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
  console.log(`\n== delete-test-so :: DOC_NO=${DOC_NO} mode=${APPLY ? "APPLY" : "DRY-RUN"} ==\n`);

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

  if (!APPLY) {
    console.log(`\nDRY-RUN complete. To actually delete, re-run with APPLY=1 and CONFIRM_DOC=${DOC_NO}.`);
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

  // (6) After-state proof. If the parent is truly gone, the next minter's
  // .like('2990-SO-YYMM-%') max will drop back and the sequence slot reopens.
  const [check] = await db`SELECT count(*)::int AS n FROM scm.mfg_sales_orders WHERE doc_no = ${DOC_NO}`;
  console.log(`\nAfter   : ${DOC_NO} present? ${check.n > 0 ? "STILL PRESENT (delete failed?)" : "gone"}`);
  if (havePwp) {
    const [pwpLeft] = await db`
      SELECT count(*)::int AS n FROM scm.pwp_codes
       WHERE source_doc_no = ${DOC_NO} OR redeemed_doc_no = ${DOC_NO}`;
    console.log(`After   : vouchers still pointing at ${DOC_NO}: ${pwpLeft.n}`);
  }

  // Peek current max for the same month prefix so operator sees what the
  // next mint will now be.
  const prefix = DOC_NO.replace(/\d+$/, "%");
  const [maxRow] = await db.unsafe(
    `SELECT doc_no FROM scm.mfg_sales_orders WHERE doc_no LIKE $1 ORDER BY doc_no DESC LIMIT 1`,
    [prefix],
  );
  console.log(`Highest ${prefix} now : ${maxRow?.doc_no ?? "(none)"} — next mint reclaims the gap on its own.`);
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
