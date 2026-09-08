#!/usr/bin/env node
/* repair-so-payment-from-book - bring the ERP's payment picture back to the
 * account book's, ONE OWNER RULING AT A TIME.  PLAN BY DEFAULT.
 *
 * WHY IT EXISTS, and why it does nothing until told.  check-so-payment-census
 * counts the migrated sales orders whose money the ERP and the book disagree
 * about.  The bucket that matters is (a): the book says SETTLED and the ERP
 * still shows a balance, so we would chase a customer for money already
 * collected - HC-SO-002309 (CHOW AH SIN) is the proven one, docs/bugs/0675.
 *
 * SAYING A CUSTOMER PAID WHEN THEY DID NOT IS WORSE THAN EVERY OTHER ERROR ON
 * THIS CUTOVER.  So this script has no default ruling.  `RULING` must be named
 * in full, and each ruling writes a DIFFERENT thing:
 *
 *   RULING=balance-only
 *       Refresh the header's stored `balance_sen` from the book's UDF_BALANCE
 *       and re-derive `paid_sen` as total-minus-balance.  NO payment row is
 *       created, changed or deleted.
 *       READ THIS BEFORE CHOOSING IT: it does NOT stop the wrong chase.  The SO
 *       list, the delivery board and the ASSR intake all show
 *       balance_sen_live = local_total_sen - SUM(payments), which this ruling
 *       does not move.  It makes the stored pair agree with the book and
 *       nothing else.
 *
 *   RULING=settle-collected
 *       Bucket (a) ONLY.  For an order the book says is settled, append ONE
 *       payment row for the amount the ERP still shows outstanding, dated the
 *       book's own LastModified (a real date the book carries - NOT the order
 *       date the cutover used, docs/bugs/0675), and set balance_sen = 0,
 *       paid_sen = local_total_sen.
 *       THIS IS A PAYMENT WRITE.  It asserts that a customer paid.  It is
 *       correct only if UDF_BALANCE is the book's maintained record of what is
 *       owed - which the census establishes per document, with the date the
 *       book was last edited printed beside every row.
 *       LastModified is a real stamp but it is an EDIT date, not a receipt
 *       date, so every row this writes carries the same "DATE NOT OBSERVED"
 *       label that label-migrated-payment-dates.mjs puts on the cutover's
 *       rows.  One grep then finds every date on this ledger nobody observed.
 *
 *   RULING=both
 *       settle-collected on bucket (a), balance-only on everything else that
 *       passes the guards.
 *
 * THE GUARDS.  Every one REFUSES an order rather than adapting to it, and every
 * refusal is printed with its reason and its count:
 *   1. THE SNAPSHOT MUST BE FRESH.  UDF_BALANCE is the whole premise; a stale
 *      one would settle an order the customer has since been billed more on.
 *      MAX_SNAPSHOT_AGE_DAYS (default 2) refuses the WHOLE RUN, not a row.
 *   2. The book must state the document, in BOTH snapshots, and in MYR.  A
 *      non-MYR document's amounts are not comparable and reading one as a
 *      difference took RM 13,068.55 off a live purchase order (docs/bugs/0665,
 *      0666).
 *   3. THE TWO SIDES MUST AGREE WHAT THE ORDER IS WORTH.  If local_total_sen
 *      differs from the book's NetTotal we do not agree on the total, so we
 *      cannot agree on what is left of it.  Those orders are a PRICE question
 *      first and are listed, never settled.
 *   4. No PERSON may own the order's payment rows, and no person may have
 *      edited its money in scm.mfg_so_audit_log.  A silent overwrite of the
 *      owner's own data is not an outcome this repo accepts.
 *   5. Neither side may have cancelled the order.
 *   6. settle-collected additionally requires the (a) shape exactly - the book
 *      at UDF_BALANCE 0 and the ERP still showing a positive live balance.  It
 *      never invents a PARTIAL payment, because the book records no partial
 *      payment to copy.
 *
 * EVERY UPDATE IS GUARDED ON THE VALUE THE PLAN READ.  A row somebody moved
 * between the plan and the write is skipped and counted, never overwritten.
 *
 *   DATABASE_URL   required
 *   RULING         balance-only | settle-collected | both.  No default.
 *   MODE           plan (default) | apply
 *   CONFIRM        must equal "I HAVE REVIEWED THE PLAN" to write
 *   DOCS           optional comma-separated ERP doc_no allow-list; narrows the
 *                  plan, never widens it
 *   MAX_SNAPSHOT_AGE_DAYS   default 2
 *
 * RE-RUN: convergent and self-disarming.  Every candidate is selected by the
 * DIFFERENCE it still carries, so a written order no longer qualifies and a
 * second run reports it as already in agreement and writes nothing.  The
 * refusal list is recomputed from scratch each run and is never persisted.
 * settle-collected never appends a second payment row to an order whose live
 * balance is already zero.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const RULINGS = ["balance-only", "settle-collected", "both"];
const RULING = String(process.env.RULING || "").trim();
const MODE = String(process.env.MODE || "plan").toLowerCase();
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
const APPLY = MODE === "apply";
const MAX_AGE = Number(process.env.MAX_SNAPSHOT_AGE_DAYS || 2);
const ONLY = new Set(String(process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean));

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8"));
const sen = (v) => Math.round(Number(v || 0) * 100);
const parseStamp = (iso) => {
  const raw = String(iso);
  const tzAware = /[+-]\d{2}:?\d{2}$|Z$/.test(raw);
  return new Date(tzAware ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}+08:00`);
};
const localOf = (iso) => new Date(parseStamp(iso).getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";

/* The money fields a PERSON editing the order would have written. */
const MONEY_NEEDLES = [
  "balance_sen", "paid_sen", "deposit_sen", "payment", "payments",
  "local_total_sen", "total_sen", "unit_price_sen",
].map((n) => `%${n}%`);

async function main() {
  log(`repair-so-payment-from-book  mode=${MODE}  ruling=${RULING || "(none given)"}`);
  if (!RULINGS.includes(RULING)) {
    log("");
    log("NO RULING GIVEN, so nothing is planned and nothing is written.");
    log(`RULING must be one of: ${RULINGS.join(" | ")}`);
    log("");
    log("This script deliberately has no default. What a customer paid is not an");
    log("arithmetic consequence of anything, and the three rulings write three");
    log("different things - read the header of this file before choosing one.");
    log("Run 'SO payment census (read-only)' first; it is the evidence.");
    process.exit(0);
  }
  if (APPLY && process.env.CONFIRM !== "I HAVE REVIEWED THE PLAN") {
    console.error('MODE=apply needs CONFIRM="I HAVE REVIEWED THE PLAN" - refusing.');
    process.exit(2);
  }

  const truth = gz("ac-reconcile-truth.json.gz");
  const heads = gz("ac-doc-headers.json.gz").rows;
  const hi = Object.fromEntries(truth.header_fields.map((f, i) => [f, i]));
  const fi = Object.fromEntries(heads.so_fields.map((f, i) => [f, i]));
  if (!("currency" in hi)) {
    console.error("REFUSED: this truth snapshot predates the currency columns, so it cannot say which amounts are MYR. Re-cut it. (docs/bugs/0665)");
    process.exit(2);
  }

  /* GUARD 1 - the whole run, not a row. */
  const ageHeads = (Date.now() - parseStamp(heads.exportedAt)) / 86400000;
  const ageTruth = (Date.now() - parseStamp(truth.exported_at)) / 86400000;
  log(`   ac-doc-headers.json.gz      cut ${localOf(heads.exportedAt)}   ${(ageHeads * 24).toFixed(1)} h old`);
  log(`   ac-reconcile-truth.json.gz  cut ${localOf(truth.exported_at)}   ${(ageTruth * 24).toFixed(1)} h old`);
  const SKEW = 1 / 24;
  const oldest = Math.max(ageHeads, ageTruth);
  if (!(oldest >= -SKEW) || oldest > MAX_AGE) {
    console.error(`REFUSED: the AutoCount balance snapshot is ${oldest.toFixed(2)} days old (limit ${MAX_AGE}). UDF_BALANCE is this repair's whole premise; re-cut it first.`);
    process.exit(2);
  }

  const bookHead = new Map();
  for (const h of truth.types.SO.headers) { const d = String(h[hi.docNo]).trim(); if (d) bookHead.set(d, h); }
  const bookUdf = new Map();
  for (const r of heads.so) { const d = String(r[fi.DocNo]).trim(); if (d) bookUdf.set(d, r); }

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  const rows = await sql`
    SELECT o.doc_no, o.linked_ac_docno AS ac_doc, o.status::text AS status,
           o.local_total_sen::bigint AS total, o.paid_sen::bigint AS paid,
           o.balance_sen::bigint AS stored_bal, o.deposit_sen::bigint AS dep,
           o.debtor_name,
           COALESCE(p.paid_total, 0)::bigint AS pay_sum,
           COALESCE(p.n_human, 0)::int       AS pay_human
      FROM scm.mfg_sales_orders o
      LEFT JOIN (
             SELECT so_doc_no, SUM(amount_sen)::bigint AS paid_total,
                    COUNT(*) FILTER (
                      WHERE method IS DISTINCT FROM 'imported'
                         OR COALESCE(note, '') NOT LIKE 'imported from AutoCount%'
                    )::int AS n_human
               FROM scm.mfg_sales_order_payments
              WHERE company_id = 1 GROUP BY so_doc_no
           ) p ON p.so_doc_no = o.doc_no
     WHERE o.company_id = 1 AND o.linked_ac_docno IS NOT NULL
     ORDER BY o.doc_no`;

  const docNos = rows.map((r) => r.doc_no);
  const touched = new Set();
  for (let i = 0; i < docNos.length; i += 2000) {
    const hit = await sql`SELECT DISTINCT so_doc_no FROM scm.mfg_so_audit_log
       WHERE so_doc_no = ANY(${docNos.slice(i, i + 2000)})
         AND field_changes::text ILIKE ANY(${MONEY_NEEDLES})`;
    for (const h of hit) touched.add(h.so_doc_no);
  }

  const refused = new Map();
  const refuse = (why, doc) => { if (!refused.has(why)) refused.set(why, []); refused.get(why).push(doc); };

  const planBalance = [], planSettle = [], agreed = [];
  for (const r of rows) {
    if (ONLY.size && !ONLY.has(r.doc_no)) continue;
    const ac = String(r.ac_doc).trim();
    const bh = bookHead.get(ac), uh = bookUdf.get(ac);
    if (!bh || !uh) { refuse("the book snapshot does not state this document", r.doc_no); continue; }
    if ((String(bh[hi.currency] ?? "").trim() || "(blank)") !== "MYR") { refuse("the book does not state this document in MYR", r.doc_no); continue; }
    if (String(bh[hi.cancelled]).trim().toUpperCase() === "T") { refuse("the book has cancelled this document", r.doc_no); continue; }
    if (/cancel/i.test(String(r.status))) { refuse("the ERP has cancelled this order", r.doc_no); continue; }
    if (r.pay_human > 0) { refuse("a person owns this order's payment rows", r.doc_no); continue; }
    if (touched.has(r.doc_no)) { refuse("a person edited this order's money (mfg_so_audit_log)", r.doc_no); continue; }

    const bookTotal = sen(bh[hi.netTotal]);
    const bookBal = sen(uh[fi.UDF_BALANCE]);
    const total = Number(r.total);
    const owes = total - Number(r.pay_sum);
    if (total !== bookTotal) { refuse(`the two sides disagree what the order is WORTH (ERP ${rm(total)} vs book ${rm(bookTotal)}) - a price question first`, r.doc_no); continue; }

    const wantPaid = Math.max(0, bookTotal - bookBal);
    const c = {
      doc: r.doc_no, ac, name: String(uh[fi.DebtorName] ?? r.debtor_name ?? "").trim(),
      total, bookTotal, bookBal, owes,
      was: { paid: Number(r.paid), bal: Number(r.stored_bal), dep: Number(r.dep), paySum: Number(r.pay_sum) },
      wantPaid,
      bookEdited: String(uh[fi.LastModified] ?? "").trim(),
    };

    const isA = bookBal === 0 && owes > 0;
    if ((RULING === "settle-collected" || RULING === "both") && isA) { planSettle.push(c); continue; }
    if (RULING === "settle-collected") { if (!isA) refuse("not the (a) shape - settle-collected never invents a partial payment", r.doc_no); continue; }
    if (Number(r.stored_bal) === bookBal && Number(r.paid) === wantPaid) { agreed.push(c); continue; }
    planBalance.push(c);
  }

  const roll = (a) => a.reduce((t, x) => t + (x.owes - Math.max(0, x.bookBal)), 0);
  log("");
  log("=".repeat(78));
  log(`PLAN - ruling ${RULING}`);
  log("=".repeat(78));
  log(`   candidates read                                   ${rows.length}${ONLY.size ? ` (DOCS narrowed to ${ONLY.size})` : ""}`);
  log(`   already in agreement with the book, nothing to do ${agreed.length}`);
  log(`   balance-only updates planned                      ${planBalance.length}`);
  log(`   settle-collected payment rows planned             ${planSettle.length}   ${rm(roll(planSettle))}`);
  log("");
  for (const [why, docs] of [...refused.entries()].sort((a, b) => b[1].length - a[1].length)) {
    log(`   REFUSED ${String(docs.length).padStart(5)}  ${why}`);
    for (const d of docs.slice(0, 8)) log(`             ${d}`);
    if (docs.length > 8) log(`             ... and ${docs.length - 8} more`);
  }
  log("");
  for (const c of planSettle.slice(0, 200)) {
    log(`   SETTLE  ${c.doc} ${String(c.name).slice(0, 26).padEnd(26)} payment row ${rm(c.owes)} dated ${String(c.bookEdited).slice(0, 10)}; balance ${rm(c.was.bal)} -> RM 0.00; paid ${rm(c.was.paid)} -> ${rm(c.total)}`);
  }
  if (planSettle.length > 200) log(`   ... and ${planSettle.length - 200} more`);
  for (const c of planBalance.slice(0, 200)) {
    log(`   BALANCE ${c.doc} ${String(c.name).slice(0, 26).padEnd(26)} balance ${rm(c.was.bal)} -> ${rm(c.bookBal)}; paid ${rm(c.was.paid)} -> ${rm(c.wantPaid)}`);
  }
  if (planBalance.length > 200) log(`   ... and ${planBalance.length - 200} more`);

  if (!APPLY) {
    log("");
    log("PLAN ONLY - nothing was written. To write:");
    log(`   MODE=apply CONFIRM="I HAVE REVIEWED THE PLAN" RULING=${RULING}`);
    await sql.end();
    return;
  }

  /* ── the write.  Every statement guarded on the value the plan read. ── */
  let wroteSettle = 0, wroteBalance = 0, skipped = 0;
  /* THE DATE THIS WRITES IS NOT A PAYMENT DATE EITHER, and the row has to say
     so.  AutoCount records only what is still OWED; it carries no date on
     which money arrived.  The nearest real stamp the book holds is
     LastModified - when the header was last edited - so that is what goes in
     paid_at, and the label stops `backend/src/acc/daily-close.ts:55-63`, which
     buckets payments by paid_at, from reading an edit date as counted cash.
     Same marker as label-migrated-payment-dates.mjs, so one grep finds every
     date on this ledger that was not observed. */
  const DATE_LABEL = "DATE NOT OBSERVED: dated the book's LastModified (when the AutoCount header was last edited), not a payment date - AutoCount records no payment date";
  const note = `book settlement carried back from AutoCount (${path.basename("ac-doc-headers.json.gz")} cut ${localOf(heads.exportedAt)})`;
  for (const c of planSettle) {
    const done = await sql.begin(async (tx) => {
      const upd = await tx`
        UPDATE scm.mfg_sales_orders
           SET balance_sen = 0, paid_sen = ${c.total}
         WHERE doc_no = ${c.doc} AND company_id = 1
           AND local_total_sen = ${c.total}
           AND paid_sen = ${c.was.paid}
           AND balance_sen = ${c.was.bal}
        RETURNING doc_no`;
      if (upd.length !== 1) return false;
      await tx`
        INSERT INTO scm.mfg_sales_order_payments
          (so_doc_no, paid_at, method, amount_sen, is_deposit, company_id, note)
        VALUES (${c.doc}, ${String(c.bookEdited).slice(0, 10) || null}, 'imported', ${c.owes}, false, 1,
                ${`${note}; AutoCount ${c.ac} UDF_BALANCE 0 [${DATE_LABEL}]`})`;
      return true;
    });
    if (done) wroteSettle++; else { skipped++; log(`   SKIPPED ${c.doc} - it moved between the plan and the write`); }
  }
  for (const c of planBalance) {
    const upd = await sql`
      UPDATE scm.mfg_sales_orders
         SET balance_sen = ${c.bookBal}, paid_sen = ${c.wantPaid}
       WHERE doc_no = ${c.doc} AND company_id = 1
         AND local_total_sen = ${c.total}
         AND paid_sen = ${c.was.paid}
         AND balance_sen = ${c.was.bal}
      RETURNING doc_no`;
    if (upd.length === 1) wroteBalance++; else { skipped++; log(`   SKIPPED ${c.doc} - it moved between the plan and the write`); }
  }
  log("");
  log(`APPLIED - ${wroteSettle} order(s) settled from the book, ${wroteBalance} stored balance(s) refreshed, ${skipped} skipped because the row moved.`);

  /* ── the read-back, on a FRESH CONNECTION ── */
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const wrote = [...planSettle, ...planBalance].map((c) => c.doc);
  const bad = [];
  if (wrote.length) {
    const back = await fresh`
      SELECT o.doc_no, o.local_total_sen::bigint AS total, o.paid_sen::bigint AS paid,
             o.balance_sen::bigint AS bal,
             COALESCE((SELECT SUM(amount_sen)::bigint FROM scm.mfg_sales_order_payments
                        WHERE so_doc_no = o.doc_no AND company_id = 1), 0)::bigint AS pay_sum
        FROM scm.mfg_sales_orders o
       WHERE o.doc_no = ANY(${wrote}) AND o.company_id = 1`;
    const byDoc = new Map(back.map((r) => [r.doc_no, r]));
    for (const c of planSettle) {
      const r = byDoc.get(c.doc);
      if (!r) { bad.push(`${c.doc} did not come back on a fresh connection`); continue; }
      if (Number(r.bal) !== 0) bad.push(`${c.doc} balance_sen is ${r.bal}, expected 0`);
      if (Number(r.paid) !== Number(r.total)) bad.push(`${c.doc} paid_sen ${r.paid} is not the total ${r.total}`);
      if (Number(r.pay_sum) !== Number(r.total)) bad.push(`${c.doc} payment rows sum to ${r.pay_sum}, not the total ${r.total}`);
    }
    for (const c of planBalance) {
      const r = byDoc.get(c.doc);
      if (!r) { bad.push(`${c.doc} did not come back on a fresh connection`); continue; }
      if (Number(r.bal) !== c.bookBal) bad.push(`${c.doc} balance_sen is ${r.bal}, expected the book's ${c.bookBal}`);
      if (Number(r.paid) + Number(r.bal) !== Number(r.total)) bad.push(`${c.doc} paid + balance ${Number(r.paid) + Number(r.bal)} does not equal the total ${r.total}`);
      if (Number(r.pay_sum) !== Number(c.was.paySum)) bad.push(`${c.doc} payment rows moved: ${c.was.paySum} -> ${r.pay_sum}. balance-only must never touch a payment row.`);
    }
  }
  log(`read-back on a fresh connection: ${bad.length === 0 ? "every written order holds the book's figure and its payment rows sum to it" : "WRONG SHAPE"}`);
  for (const b of bad) log(`   WRONG SHAPE ${b}`);
  await fresh.end();
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
