#!/usr/bin/env node
/* clear-orphan-price-so-010916 - ONE LINE, ONE ORDER, ONE OWNER RULING.
 *
 * HC-SO-010916 line 2 (AutoCount SO-010916, DtlKey 758652,
 * EG-ERGOLITE MATT (SS)) carries RM 2,817.00 in the ERP. The book states
 * NOTHING for that line: qty 1, UnitPrice 0.0000, SubTotal 0.00. The order is
 * therefore RM 8,905.00 in the ERP and RM 6,088.00 in the book, and the gap is
 * exactly this line.
 *
 * THE STANDING RULE SAYS LEAVE IT. The owner's default is that a blank never
 * overwrites a value - the book holding 0.00 is the book holding NO price, not
 * a price of zero - which is why repair-so-price-from-autocount put this line
 * under HELD (run 34137116270) and did not touch it.
 *
 * THE OWNER OVERRODE THAT RULE FOR THIS LINE, 2026-09-07: 「跟账本，清成空白」.
 *
 * THIS IS AN EXCEPTION FOR ONE LINE. IT IS NOT A REPEAL.
 * The blank-never-overwrites rule still governs everywhere else and this script
 * is built so it CANNOT be turned into a sweep: the document, the DtlKey and
 * the amount it expects to find are constants below, and every one of them is
 * asserted against production before anything is written. There is no input
 * that widens it. Others of the same shape are LISTED, not cleared -
 * probe-so-payment-reconcile.mjs is the census, and each one is his call.
 *
 * WHAT IT WRITES, and nothing else:
 *   scm.mfg_sales_order_items   unit_price_sen, total_sen, balance_sen -> 0
 *   scm.mfg_sales_orders        local_total_sen + the five bucket columns,
 *                               RE-SUMMED from the lines
 *
 * WHAT IT DOES NOT TOUCH. paid_sen and balance_sen ON THE HEADER. What a
 * customer paid is not an arithmetic consequence of a corrected total. Those
 * two columns are the owner's to rule on and this script has no opinion.
 * (It happens that after this write HC-SO-010916 reads
 * paid 1,859.00 + balance 4,229.00 = 6,088.00 = the total, because the balance
 * is the book's own UDF_BALANCE and the book's total is 6,088.00. That is a
 * consequence, not a goal, and the script asserts nothing about it.)
 *
 * THE GUARDS, each of which REFUSES rather than adapts:
 *   1. the book must state 0.00 for DtlKey 758652 - the ruling's premise;
 *   2. the book document must be MYR - a non-MYR document's amounts are not
 *      comparable and reading one as a difference took RM 13,068.55 off a live
 *      purchase order (docs/bugs/0665, 0666);
 *   3. the DtlKey must map to EXACTLY ONE ERP row. linked_ac_dtlkey is NOT
 *      unique: a sofa is one book line and one ERP row per compartment, and a
 *      keyed repair that ignored that proposed RM 2,216,501 of invented revenue
 *      (docs/bugs/0673);
 *   4. that row must still hold exactly RM 2,817.00. If someone else has moved
 *      it, the ruling was made about a number that no longer exists and this
 *      script stops.
 *
 *   DATABASE_URL   required
 *   APPLY=1        write. PLAN (dry-run) otherwise, which is the default.
 *   CONFIRM        must equal "I HAVE REVIEWED THE PLAN" to write.
 *
 * RE-RUN: convergent and self-disarming. After a successful run guard 4 finds
 * 0.00 instead of RM 2,817.00, so a second run reports ALREADY CLEARED and
 * writes nothing. It never re-applies and it never widens.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/* The whole scope of this script, and it is not configurable. */
const DOC = "HC-SO-010916";
const AC_DOC = "SO-010916";
const DTLKEY = "758652";
const EXPECT_SEN = 281700; // RM 2,817.00 - what the ruling was made about
const BOOK_TOTAL_SEN = 608800; // RM 6,088.00 - what the order should come to

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const APPLY = process.env.APPLY === "1";
const CONFIRM_PHRASE = "I HAVE REVIEWED THE PLAN";
if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
  console.error(`APPLY=1 needs CONFIRM="${CONFIRM_PHRASE}". Read the plan first: it names the one line, the one amount, and the order total before and after.`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
const refuse = async (sql, why) => {
  log("");
  log(`REFUSING: ${why}`);
  log("Nothing was written. This is the script working, not failing.");
  await sql.end();
  process.exit(0);
};

const BUCKET = {
  mattress: "mattress_sofa_sen", sofa: "mattress_sofa_sen", bedframe: "bedframe_sen",
  accessory: "accessories_sen", service: "service_sen", others: "others_sen",
};

async function main() {
  const snap = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", "ac-reconcile-truth.json.gz"))).toString("utf8"));
  const li = Object.fromEntries(snap.line_fields.map((f, i) => [f, i]));
  const hi = Object.fromEntries(snap.header_fields.map((f, i) => [f, i]));

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  log(`mode=${APPLY ? "APPLY" : "PLAN"}; AutoCount snapshot cut ${snap.exported_at} (${new Date(new Date(snap.exported_at).getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC+8)`);
  log(`scope: ${DOC} / AutoCount ${AC_DOC} / DtlKey ${DTLKEY}. One line. There is no input that widens this.`);
  log("");

  /* GUARD 1 - the ruling's premise: the book states nothing for this line. */
  const bookLine = snap.types.SO.lines.find((r) => String(r[li.dtlKey]) === DTLKEY);
  if (!bookLine) await refuse(sql, `DtlKey ${DTLKEY} is not in the AutoCount snapshot at all. The premise cannot be checked.`);
  if (String(bookLine[li.docNo]) !== AC_DOC) {
    await refuse(sql, `DtlKey ${DTLKEY} belongs to AutoCount ${bookLine[li.docNo]}, not ${AC_DOC}.`);
  }
  const bookUpSen = Math.round(Number(bookLine[li.unitPrice]) * 100);
  const bookSubSen = Math.round(Number(bookLine[li.subTotal]) * 100);
  log(`GUARD 1 - the book on DtlKey ${DTLKEY}: ${String(bookLine[li.itemKey])}, qty ${Number(bookLine[li.qty])}, unit price ${rm(bookUpSen)}, sub total ${rm(bookSubSen)}`);
  if (bookUpSen !== 0 || bookSubSen !== 0) {
    await refuse(sql, `the book STATES a price for this line (${rm(bookUpSen)}). The owner's ruling was 跟账本 - follow the book - and the book is not blank. Copying it is repair-so-price-from-autocount's job, not this script's.`);
  }
  log("   the book states nothing. The premise holds.");

  /* GUARD 2 - currency. */
  const bookHead = snap.types.SO.headers.find((r) => String(r[hi.docNo]) === AC_DOC);
  if (!bookHead) await refuse(sql, `AutoCount ${AC_DOC} has no header in the snapshot.`);
  const cur = String(bookHead[hi.currency] ?? "").trim();
  log(`GUARD 2 - currency: the book states ${AC_DOC} in ${cur || "(blank)"}, net total ${rm(Math.round(Number(bookHead[hi.netTotal]) * 100))} (LOCAL/MYR)`);
  if (cur !== "MYR") {
    await refuse(sql, `${AC_DOC} is not in MYR. Its amounts are not comparable to the ERP's and no money is repaired on a non-MYR document. (docs/bugs/0665, 0666)`);
  }
  const bookTotalSen = Math.round(Number(bookHead[hi.netTotal]) * 100);
  if (bookTotalSen !== BOOK_TOTAL_SEN) {
    await refuse(sql, `the book now says ${AC_DOC} is worth ${rm(bookTotalSen)}, not the ${rm(BOOK_TOTAL_SEN)} this ruling was made about. The book moved; take the ruling again.`);
  }
  log("   MYR, and the book's total is the one the ruling named.");

  /* GUARD 3 - one book line must be one ERP row. */
  const claimants = await sql`
    SELECT i.id, i.doc_no, i.line_no, i.item_code, i.item_group,
           i.qty::numeric AS qty, i.unit_price_sen::bigint AS up,
           i.total_sen::bigint AS total, i.balance_sen::bigint AS bal
      FROM scm.mfg_sales_order_items i
     WHERE i.linked_ac_dtlkey = ${DTLKEY}
     ORDER BY i.doc_no, i.line_no`;
  log(`GUARD 3 - ERP rows carrying linked_ac_dtlkey ${DTLKEY}: ${claimants.length}`);
  for (const c of claimants) log(`   ${c.doc_no} line ${c.line_no} ${c.item_code} ${Number(c.qty)} x ${rm(c.up)} = ${rm(c.total)}`);
  if (claimants.length !== 1) {
    await refuse(sql, `${claimants.length} ERP row(s) claim this DtlKey. linked_ac_dtlkey is not unique - a sofa is one book line and one ERP row per compartment - and clearing a group on the key alone is how a keyed repair proposed RM 2,216,501 of invented revenue. (docs/bugs/0673)`);
  }
  const row = claimants[0];
  if (row.doc_no !== DOC) await refuse(sql, `the one claimant is on ${row.doc_no}, not ${DOC}.`);
  log("   exactly one, on the right document.");

  /* GUARD 4 - the amount the ruling was made about is still there. */
  log(`GUARD 4 - the amount: the ERP holds ${rm(row.up)} on that row; the ruling was made about ${rm(EXPECT_SEN)}`);
  if (Number(row.up) === 0) {
    log("");
    log("ALREADY CLEARED. This line carries no price. Nothing to do; a re-run is a no-op by design.");
    await sql.end();
    return;
  }
  if (Number(row.up) !== EXPECT_SEN) {
    await refuse(sql, `the row now holds ${rm(row.up)}, not the ${rm(EXPECT_SEN)} the owner ruled on. Somebody moved it. Take the ruling again against the number that is actually there.`);
  }
  log("   unchanged since the ruling.");

  const [before] = await sql`
    SELECT local_total_sen::bigint AS total, paid_sen::bigint AS paid, balance_sen::bigint AS bal
      FROM scm.mfg_sales_orders WHERE doc_no = ${DOC}`;
  if (!before) await refuse(sql, `${DOC} is not in the ERP.`);

  const afterTotal = Number(before.total) - Number(row.total);
  log("");
  log("THE PLAN - one line, one order:");
  log(`   ${DOC} line ${row.line_no} key=${DTLKEY} ${row.item_code}`);
  log(`      unit_price_sen  ${rm(row.up)} -> ${rm(0)}`);
  log(`      total_sen       ${rm(row.total)} -> ${rm(0)}`);
  log(`      balance_sen     ${rm(row.bal)} -> ${rm(0)}`);
  log(`   ${DOC} order total ${rm(before.total)} -> ${rm(afterTotal)}   (the book says ${rm(bookTotalSen)})`);
  if (afterTotal !== bookTotalSen) {
    log(`   NOTE: that lands ${rm(afterTotal - bookTotalSen)} away from the book, not on it. The plan is still exactly this line; read it before applying.`);
  }
  log(`   paid_sen (${rm(before.paid)}) and header balance_sen (${rm(before.bal)}) are NOT touched. What the customer paid is the owner's call, not arithmetic.`);
  log(`   for reference only, after this write they read paid ${rm(before.paid)} + balance ${rm(before.bal)} = ${rm(Number(before.paid) + Number(before.bal))} against a total of ${rm(afterTotal)}.`);

  if (!APPLY) {
    log("");
    log(`PLAN ONLY - nothing written. Set APPLY=1 and CONFIRM="${CONFIRM_PHRASE}" to write.`);
    await sql.end();
    return;
  }

  let wroteLine = 0, wroteHead = 0, buckets = null;
  await sql.begin(async (tx) => {
    const u = await tx`
      UPDATE scm.mfg_sales_order_items
         SET unit_price_sen = 0, total_sen = 0, balance_sen = 0
       WHERE id = ${row.id} AND linked_ac_dtlkey = ${DTLKEY} AND unit_price_sen = ${EXPECT_SEN}
       RETURNING id`;
    wroteLine = u.length;
    if (wroteLine !== 1) throw new Error(`expected to update exactly 1 line, updated ${wroteLine}. Rolled back.`);

    const ls = await tx`SELECT item_group, total_sen::bigint AS t FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC}`;
    const b = { mattress_sofa_sen: 0, bedframe_sen: 0, accessories_sen: 0, service_sen: 0, others_sen: 0 };
    let total = 0;
    for (const l of ls) { total += Number(l.t); b[BUCKET[String(l.item_group)] ?? "others_sen"] += Number(l.t); }
    buckets = { ...b, total };
    const h = await tx`
      UPDATE scm.mfg_sales_orders
         SET local_total_sen = ${total}, mattress_sofa_sen = ${b.mattress_sofa_sen},
             bedframe_sen = ${b.bedframe_sen}, accessories_sen = ${b.accessories_sen},
             service_sen = ${b.service_sen}, others_sen = ${b.others_sen}
       WHERE doc_no = ${DOC} RETURNING doc_no`;
    wroteHead = h.length;
    if (wroteHead !== 1) throw new Error(`expected to update exactly 1 header, updated ${wroteHead}. Rolled back.`);
  });
  log("");
  log(`APPLIED - ${wroteLine} line cleared; ${wroteHead} header re-summed to ${rm(buckets.total)} from its lines.`);

  /* A SECOND connection, asserting the SHAPE rather than counting rows. */
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const bad = [];
  const [l2] = await fresh`
    SELECT unit_price_sen AS up, total_sen AS total, balance_sen AS bal, qty AS q, linked_ac_dtlkey AS k
      FROM scm.mfg_sales_order_items WHERE id = ${row.id}`;
  if (!l2) bad.push("the line did not come back on a fresh connection");
  else {
    if (Number(l2.up) !== 0) bad.push(`unit_price_sen is ${JSON.stringify(l2.up)}, expected 0`);
    if (Number(l2.total) !== 0) bad.push(`total_sen is ${JSON.stringify(l2.total)}, expected 0`);
    if (Number(l2.bal) !== 0) bad.push(`balance_sen is ${JSON.stringify(l2.bal)}, expected 0`);
    if (String(l2.k) !== DTLKEY) bad.push(`linked_ac_dtlkey is ${JSON.stringify(l2.k)}, expected ${DTLKEY}`);
  }
  const [h2] = await fresh`
    SELECT local_total_sen::bigint AS total, paid_sen::bigint AS paid, balance_sen::bigint AS bal,
           (SELECT COALESCE(SUM(total_sen), 0)::bigint FROM scm.mfg_sales_order_items WHERE doc_no = ${DOC}) AS line_sum
      FROM scm.mfg_sales_orders WHERE doc_no = ${DOC}`;
  if (!h2) bad.push("the header did not come back on a fresh connection");
  else {
    if (Number(h2.total) !== Number(h2.line_sum)) bad.push(`local_total_sen ${h2.total} is not the sum of its lines ${h2.line_sum}`);
    if (Number(h2.paid) !== Number(before.paid)) bad.push(`paid_sen moved: ${before.paid} -> ${h2.paid}. This script must not touch it.`);
    if (Number(h2.bal) !== Number(before.bal)) bad.push(`header balance_sen moved: ${before.bal} -> ${h2.bal}. This script must not touch it.`);
  }
  log(`read-back on a fresh connection: ${bad.length === 0 ? "the line is blank, the header equals the sum of its lines, and paid/balance are untouched" : "WRONG SHAPE"}`);
  for (const b of bad) log(`   WRONG SHAPE ${b}`);
  await fresh.end();

  if (h2) {
    log("");
    log(`${DOC} after the write:`);
    log(`   order total   ${rm(before.total)} -> ${rm(h2.total)}   (the book says ${rm(bookTotalSen)}${Number(h2.total) === bookTotalSen ? " - they now agree" : ""})`);
    log(`   paid ${rm(h2.paid)} + balance ${rm(h2.bal)} = ${rm(Number(h2.paid) + Number(h2.bal))} ${Number(h2.paid) + Number(h2.bal) === Number(h2.total) ? "= the total" : `does NOT equal the total; still the owner's call`}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
