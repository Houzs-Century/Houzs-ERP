#!/usr/bin/env node
/* check-do-payment-book-gap - money a driver collected at the door, that the
 * ACCOUNT BOOK has never been told about.  READ-ONLY.  SELECT only, no writes,
 * no DDL, no transaction.
 *
 * WHY IT EXISTS.  The owner's go-live requirement, in his words: 「然后确保
 * Autocount也会钱收到」.  A payment keyed on the SALES ORDER is covered - it
 * rides the sales-order write-back into AutoCount's UDF_BALANCE and
 * UDF_PAYEMENT.  A payment keyed on the DELIVERY ORDER is not, and the gap is
 * structural rather than a bug in one branch:
 *
 *   scm/lib/autocount-read.ts  readSoOutstandingSen  -> mfg_sales_order_payments
 *   scm/lib/autocount-read.ts  readSoPaymentRefs     -> mfg_sales_order_payments
 *   composePaymentUdf feeders: scm/lib/so-edit-header.ts, services/autocount-writeback.ts
 *
 * Nothing anywhere reads scm.delivery_order_payments on any AutoCount path,
 * while scm/routes/delivery-orders-mfg.ts POST /:id/payments writes it and the
 * DO Create + Detail screens render the same PaymentsTable the SO does
 * (frontend/src/vendor/scm/lib/delivery-order-queries.ts).  So the screen is
 * reachable and the money it takes stops at our database.
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE.  Whether the answer is "route DO payments
 * into the write-back", "close the screen for company 1" or "the money is
 * already on the SO as well, so nothing is missing" depends on the numbers
 * below, and the ruling belongs to the owner.  Saying a customer paid when they
 * did not is the worst error available on this cutover, so nothing here writes.
 *
 * THE QUESTION THAT DECIDES THE HANDLING, and it is the one diag-do-payments.mjs
 * asked for company 2 in July: is each DO payment a DUPLICATE of one already
 * recorded on its sales order (so the book already knows the money and there is
 * no gap), or is it ADDITIONAL - a balance collected at the door that exists
 * nowhere else (so the book is overstating what that customer owes)?  Matched
 * on amount + date against scm.mfg_sales_order_payments for the same so_doc_no.
 *
 * A DO WITH NO so_doc_no CANNOT BE MATCHED AT ALL and is reported as its own
 * bucket rather than folded into either answer - an unmatched row is not
 * evidence of additional money, only evidence that this script cannot tell.
 *
 *   DATABASE_URL   required
 *   COMPANY_ID     default 1
 *   LIST_LIMIT     rows to enumerate per bucket (default 200; 0 = all)
 *
 * Exit 0 for every legitimate answer - the ANSWER is the output, not the exit
 * code.  Non-zero only when the database is unreachable.
 *
 * RE-RUN: freely.  It reads.  The answer moves only when production moves.
 */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL not set. Aborting."); process.exit(1); }

const COMPANY = Number(process.env.COMPANY_ID || 1);
if (!Number.isInteger(COMPANY) || COMPANY <= 0) {
  console.error(`COMPANY_ID must be a positive integer, got ${process.env.COMPANY_ID}`);
  process.exit(1);
}
const RAW_LIMIT = (process.env.LIST_LIMIT ?? "").trim();
const LIMIT = RAW_LIMIT === "" ? 200 : Number(RAW_LIMIT);
if (!Number.isInteger(LIMIT) || LIMIT < 0) {
  console.error(`LIST_LIMIT must be a non-negative integer or blank, got ${RAW_LIMIT}`);
  process.exit(1);
}

const rm = (sen) => `RM ${(Number(sen || 0) / 100).toLocaleString("en-MY", {
  minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const log = (s = "") => console.log(s);
const day = (v) => String(v ?? "").slice(0, 10);

const sql = postgres(DSN, { max: 1, prepare: false, idle_timeout: 20, connect_timeout: 30 });

try {
  log(`check-do-payment-book-gap - company ${COMPANY}`);
  log("Money keyed on a DELIVERY ORDER. Nothing on any AutoCount path reads this table.");
  log("");

  /* Every company-scoped DO payment, its parent DO, that DO's sales order, and
     whether the SAME amount on the SAME day is also recorded on the sales order.
     Company scope comes from the PARENT DO: the payment row carries no
     company_id of its own, which is exactly why the 2990 importer dropped 13 of
     these - root cause traced in diag-do-payments.mjs. */
  const rows = await sql`
    SELECT p.id,
           p.paid_at,
           p.amount_sen,
           p.method,
           d.do_number,
           d.status        AS do_status,
           d.so_doc_no,
           o.linked_ac_docno,
           EXISTS (
             SELECT 1 FROM scm.mfg_sales_order_payments s
              WHERE s.so_doc_no   = d.so_doc_no
                AND s.company_id  = ${COMPANY}
                AND s.amount_sen  = p.amount_sen
                AND s.paid_at     = p.paid_at
           ) AS also_on_so
      FROM scm.delivery_order_payments p
      JOIN scm.delivery_orders d ON d.id = p.delivery_order_id
      LEFT JOIN scm.mfg_sales_orders o
             ON o.doc_no = d.so_doc_no AND o.company_id = ${COMPANY}
     WHERE d.company_id = ${COMPANY}
     ORDER BY p.paid_at DESC, p.id DESC`;

  const total = rows.length;
  log(`   delivery-order payment rows on company ${COMPANY}                 ${total}`);

  /* Deliberately NOT process.exit here. The finally below closes the pool with
     an await, and process.exit would cut that await short - the same shape that
     made a probe report success while it had died (docs/bugs/0687). */
  if (total === 0) {
    log("");
    log("   ZERO. No money has ever been keyed on a delivery order for this company.");
    log("   The gap is therefore a HOLE TO CLOSE BEFORE STAFF USE IT, not a repair:");
    log("   the screen is reachable and the first payment taken on it would be");
    log("   invisible to AutoCount. Nothing is currently wrong in the book.");
  } else {

  const sum = (a) => a.reduce((n, r) => n + Number(r.amount_sen || 0), 0);
  const noSo       = rows.filter((r) => !r.so_doc_no);
  const withSo     = rows.filter((r) => r.so_doc_no);
  const dup        = withSo.filter((r) => r.also_on_so);
  const additional = withSo.filter((r) => !r.also_on_so);
  const inBook     = additional.filter((r) => r.linked_ac_docno);

  log(`   total money on them                                     ${rm(sum(rows))}`);
  log(`   oldest / newest                                         ${day(rows[total - 1].paid_at)} .. ${day(rows[0].paid_at)}`);
  log("");
  log("BUCKETS");
  log(`   a) also recorded on the sales order (book already knows)  ${dup.length}  ${rm(sum(dup))}`);
  log(`   b) NOT on the sales order - the book has never seen it    ${additional.length}  ${rm(sum(additional))}`);
  log(`        of which the order IS in the book (linked_ac_docno)  ${inBook.length}  ${rm(sum(inBook))}`);
  log(`   c) the delivery order carries no sales order - CANNOT TELL ${noSo.length}  ${rm(sum(noSo))}`);
  log("");
  log(`   Bucket (b)-in-book is the honest exposure: ${rm(sum(inBook))} that AutoCount`);
  log(`   still shows as owing, across ${new Set(inBook.map((r) => r.so_doc_no)).size} order(s).`);

  const show = (name, list) => {
    if (list.length === 0) return;
    log("");
    log(`${name} (${list.length})`);
    const take = LIMIT === 0 ? list : list.slice(0, LIMIT);
    for (const r of take) {
      log(`   ${day(r.paid_at)}  ${rm(r.amount_sen).padStart(16)}  ${String(r.method || "").padEnd(12)} ` +
          `DO ${r.do_number || "?"}  SO ${r.so_doc_no || "(none)"}  book ${r.linked_ac_docno || "(not in book)"}`);
    }
    if (take.length < list.length) log(`   ... ${list.length - take.length} more (LIST_LIMIT=${LIMIT}, 0 = all)`);
  };

  show("b) money the account book has never been told about", additional);
  show("c) delivery order with no sales order - undecidable here", noSo);

  log("");
  log("NOTHING WAS WRITTEN. The ruling on what to do with bucket (b) is the owner's.");
  }
} finally {
  await sql.end({ timeout: 5 });
}
