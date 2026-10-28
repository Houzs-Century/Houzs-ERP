#!/usr/bin/env node
/* label-migrated-payment-dates - say, on the row itself, that a migrated
 * payment's date is the ORDER date and not a payment date.  PLAN BY DEFAULT.
 *
 * WHY IT EXISTS.  The 2026-08-28 cutover created one payment row per migrated
 * sales order and had no payment date to put on it.  AutoCount records only
 * what is still OWED (UDF_BALANCE); it carries no date on which money arrived.
 * So import-ac-outstanding-so.mjs:476 wrote the ORDER date instead - the row's
 * paid_at is `h.DocDate`, the document date, with the current date as its only
 * fallback.
 *
 * The owner ruled on 2026-09-08: leave the dates, but LABEL them.  This is that
 * label and nothing else: it appends a sentence to `note` and touches no
 * amount, no date and no status.
 *
 * WHY A LABEL IS WORTH A PR.  backend/src/acc/daily-close.ts:55-63 buckets
 * payments with `.gte('paid_at', dayStart).lte('paid_at', dayEnd)`.  An
 * unlabelled fabricated date therefore lands in a day's cash close as though
 * that money were counted that day, and any ageing of a receivable off paid_at
 * reads an order date as a receipt date.  Nothing in the row says otherwise
 * today.
 *
 * WHAT IT REFUSES.  A row is labelled ONLY where its `paid_at` provably equals
 * its order's `so_date` - that equality is the evidence that the date IS the
 * fabricated one.  A migrated row whose date differs from the order date came
 * from somewhere this script cannot name, so it is listed and left alone.  A
 * row a person owns (any method other than 'imported', or a note that is not
 * the importer's) is never selected at all.
 *
 * SAFE FOR EVERY READER, checked by enumeration rather than assumed.  All six
 * code sites that key on this note match it by PREFIX -
 * check-so-payment-census.mjs:168 and repair-so-payment-from-book.mjs:177
 * (`LIKE 'imported from AutoCount%'`), check-so-version-provenance.mjs:410 and
 * sync-ac-delta.mjs:455 (`/^imported from AutoCount/`),
 * probe-so-payment-reconcile.mjs:205 (`startsWith`) and
 * remove-delivered-imported-so.mjs:63 (`LIKE 'imported from AutoCount%'`).  A
 * SUFFIX leaves every one of them matching exactly as before, which is why the
 * label is appended and the note is never rewritten.
 *
 *   DATABASE_URL   required
 *   MODE           plan (default) | apply
 *   CONFIRM        must equal "label-fabricated-payment-dates" to write
 *   COMPANY_ID     default 1
 *   LIST_LIMIT     rows to enumerate (default 40; 0 = all)
 *
 * RE-RUN: idempotent and self-disarming.  A labelled row no longer matches the
 * selection, so a second run reports nothing to do and writes nothing.
 */
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }

const MODE = String(process.env.MODE || "plan").toLowerCase();
if (!["plan", "apply"].includes(MODE)) { console.error(`MODE must be plan or apply, got ${MODE}`); process.exit(2); }
const APPLY = MODE === "apply";
const CONFIRM_PHRASE = "label-fabricated-payment-dates";
const COMPANY_ID = Number(process.env.COMPANY_ID || 1);
const LIST_LIMIT = process.env.LIST_LIMIT === "0" ? Infinity : Number(process.env.LIST_LIMIT || 40);

/* The label itself.  MARKER is what makes the run idempotent, so it must stay
   byte-stable once anything has been written with it. */
const MARKER = "DATE NOT OBSERVED";
const LABEL = ` [${MARKER}: this is the ORDER date, not a payment date - the AutoCount cutover had no payment date to copy]`;

const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;

async function main() {
  log(`label-migrated-payment-dates  mode=${MODE}  company_id=${COMPANY_ID}`);
  if (APPLY && process.env.CONFIRM !== CONFIRM_PHRASE) {
    console.error(`MODE=apply needs CONFIRM=${CONFIRM_PHRASE} - refusing.`);
    process.exit(2);
  }

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  /* One statement.  The join is what supplies the EVIDENCE: an order's own
     so_date, so "the date is the order date" is proven per row and never
     assumed from the fact that the importer wrote them together. */
  const rows = await sql`
    SELECT p.id,
           p.so_doc_no,
           p.note,
           p.amount_sen::bigint    AS amount,
           p.paid_at::date::text   AS paid_on,
           o.so_date::date::text   AS ordered_on
      FROM scm.mfg_sales_order_payments p
      JOIN scm.mfg_sales_orders o
        ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
     WHERE p.company_id = ${COMPANY_ID}
       AND p.method = 'imported'
       AND p.note LIKE 'imported from AutoCount%'
     ORDER BY p.so_doc_no`;

  const already = rows.filter((r) => String(r.note).includes(MARKER));
  const rest = rows.filter((r) => !String(r.note).includes(MARKER));
  const proven = (r) => Boolean(r.paid_on) && Boolean(r.ordered_on) && r.paid_on === r.ordered_on;
  const todo = rest.filter(proven);
  const notProven = rest.filter((r) => !proven(r));

  log("");
  log("=".repeat(78));
  log("PLAN - label the cutover's fabricated payment dates");
  log("=".repeat(78));
  log(`   cutover payment rows read (method 'imported', importer's note)   ${rows.length}`);
  log(`   already carry the label, nothing to do                           ${already.length}`);
  log(`   paid_at PROVABLY equals the order's so_date - will be labelled   ${todo.length}   ${rm(todo.reduce((t, r) => t + Number(r.amount), 0))}`);
  log(`   paid_at differs from the order date - LISTED, never touched      ${notProven.length}`);
  log("");
  for (const r of notProven.slice(0, LIST_LIMIT)) {
    log(`   LEFT ALONE ${r.so_doc_no}  paid_at ${r.paid_on}  order date ${r.ordered_on}  ${rm(r.amount)}`);
  }
  if (notProven.length > LIST_LIMIT) log(`   ... and ${notProven.length - LIST_LIMIT} more (LIST_LIMIT=${LIST_LIMIT})`);
  log("");
  log("   the note becomes, verbatim:");
  log(`      imported from AutoCount SO-XXXXXX${LABEL}`);

  if (!APPLY) {
    log("");
    log("PLAN ONLY - nothing was written. To write:");
    log(`   MODE=apply CONFIRM=${CONFIRM_PHRASE}`);
    await sql.end();
    return;
  }
  if (!todo.length) {
    log("");
    log("Nothing to label. Exiting without writing.");
    await sql.end();
    return;
  }

  /* Guarded on the exact note the plan read, so a row somebody edited between
     the plan and the write is skipped and counted, never overwritten. */
  let wrote = 0, skipped = 0;
  const CHUNK = 200;
  for (let i = 0; i < todo.length; i += CHUNK) {
    for (const r of todo.slice(i, i + CHUNK)) {
      const upd = await sql`
        UPDATE scm.mfg_sales_order_payments
           SET note = ${String(r.note) + LABEL}
         WHERE id = ${r.id} AND company_id = ${COMPANY_ID} AND note = ${r.note}
        RETURNING id`;
      if (upd.length === 1) wrote++; else skipped++;
    }
    log(`   ..${Math.min(i + CHUNK, todo.length)}/${todo.length}`);
  }
  log("");
  log(`APPLIED - ${wrote} payment row(s) labelled, ${skipped} skipped because the row moved.`);
  await sql.end();

  /* Read back on a FRESH connection and assert the SHAPE, not the write's own
     row count: nothing provable is left unlabelled, and no amount or date
     moved while the note was appended to. */
  const fresh = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
  const back = await fresh`
    SELECT p.id, p.note, p.amount_sen::bigint AS amount, p.paid_at::date::text AS paid_on
      FROM scm.mfg_sales_order_payments p
     WHERE p.id = ANY(${todo.map((r) => r.id)}) AND p.company_id = ${COMPANY_ID}`;
  const byId = new Map(back.map((r) => [String(r.id), r]));
  const bad = [];
  for (const r of todo) {
    const g = byId.get(String(r.id));
    if (!g) { bad.push(`${r.so_doc_no} row ${r.id} did not come back on a fresh connection`); continue; }
    if (!String(g.note).includes(MARKER)) bad.push(`${r.so_doc_no} row ${r.id} still carries no label`);
    if (Number(g.amount) !== Number(r.amount)) bad.push(`${r.so_doc_no} row ${r.id} AMOUNT MOVED ${r.amount} -> ${g.amount}`);
    if (g.paid_on !== r.paid_on) bad.push(`${r.so_doc_no} row ${r.id} DATE MOVED ${r.paid_on} -> ${g.paid_on}`);
  }
  const [{ unlabelled }] = await fresh`
    SELECT count(*)::int AS unlabelled
      FROM scm.mfg_sales_order_payments p
      JOIN scm.mfg_sales_orders o ON o.doc_no = p.so_doc_no AND o.company_id = p.company_id
     WHERE p.company_id = ${COMPANY_ID} AND p.method = 'imported'
       AND p.note LIKE 'imported from AutoCount%'
       AND p.note NOT LIKE ${"%" + MARKER + "%"}
       AND p.paid_at::date = o.so_date::date`;
  log(`read-back on a fresh connection: ${bad.length === 0 ? "every labelled row holds its label, and no amount or date moved" : "WRONG SHAPE"}`);
  for (const b of bad) log(`   WRONG SHAPE ${b}`);
  log(`provably-fabricated dates still unlabelled: ${unlabelled}`);
  await fresh.end();
  if (bad.length || unlabelled !== 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
