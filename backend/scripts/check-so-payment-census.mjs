#!/usr/bin/env node
/* check-so-payment-census - how many migrated sales orders disagree with the
 * account book about MONEY ALREADY COLLECTED, and which way?  READ-ONLY.
 * SELECT only, no writes, no DDL, no transaction.
 *
 * WHY IT EXISTS.  docs/bugs/0675 proved, on ONE order, that the ERP would chase
 * a customer for money the book says is already paid: HC-SO-002309 (CHOW AH
 * SIN) is SETTLED in AutoCount - UDF_BALANCE 0, the header edited 2026-09-04
 * 14:03 local - and the ERP still shows RM 4,279.00 outstanding, because the
 * customer paid after the 2026-08-28 import and nothing flowed back.  Nobody
 * had asked how many MORE orders are in that state.  This counts them.
 *
 * THE FACT THAT MAKES THE COLUMNS READABLE.  `mfg_sales_orders.paid_sen` was
 * NEVER OBSERVED.  import-ac-outstanding-so.mjs:328 wrote
 *
 *     const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);
 *
 * so BALANCE is the copied fact (AutoCount's own UDF_BALANCE, what the book
 * says is still owed) and PAID is total-minus-balance evaluated against the
 * ERP's line total AT IMPORT TIME.  `paid + balance = total` is an identity the
 * importer creates, not a reconciliation anything checks.  Nothing here writes
 * either column; a payment write is the owner's call and not a script's.
 *
 * WHICH ERP NUMBER IS "WHAT WE WOULD CHASE".  Two exist and they are not the
 * same:
 *   balance_sen        the header column, copied from UDF_BALANCE at import
 *   balance_sen_live   local_total_sen - SUM(payments), the figure the SO list,
 *                      the delivery board and the ASSR intake actually show
 *                      (scm.mfg_sales_orders_with_payment_totals, mig 0084/0189)
 * The CHASE figure is the live one, so the buckets below are cut on it and the
 * stored column is printed beside every row.  The view CLAMPS at zero
 * (GREATEST(total - paid, 0)), so this script recomputes it unclamped from the
 * payment rows - an over-collected order is a real answer and must not be
 * rounded away into "settled".
 *
 * TWO SNAPSHOTS, TWO VINTAGES, AND THE GAP IS PRINTED BEFORE ANY FINDING.
 *   ac-doc-headers.json.gz      UDF_BALANCE, UDF_PAYEMENT, DebtorName, LastModified
 *   ac-reconcile-truth.json.gz  the book's net total, its currency, its line prices
 * docs/bugs/0672 is the entry where a checker called 86 receipts invented
 * because it never subtracted its snapshot's age from today.  A payment
 * recorded in AutoCount AFTER the older cut is INVISIBLE here and the header
 * says so in words, with the age in hours.
 *
 * CURRENCY.  netTotal is the LOCAL (MYR) amount, docTotal the document-currency
 * one.  A document the book does not state in MYR is REPORTED AND NEVER
 * SUBTRACTED - reading one as a difference is what took RM 13,068.55 off a live
 * purchase order (docs/bugs/0665, 0666).
 *
 *   DATABASE_URL   required
 *   LIST_LIMIT     rows to enumerate per bucket (default 400; 0 = all)
 *   GIVEAWAY       "0" to skip the dropped-line census
 *
 * RE-RUN: freely.  It reads.  The answer moves only when production or the
 * committed snapshots move.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const LIST_LIMIT = process.env.LIST_LIMIT === "0" ? Infinity : Number(process.env.LIST_LIMIT || 400);
const GIVEAWAY = process.env.GIVEAWAY !== "0";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (s) => `RM ${(Number(s) / 100).toFixed(2)}`;
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8"));
const sen = (v) => Math.round(Number(v || 0) * 100);

/* Malaysia is UTC+8 and has no DST.  Every time this prints is LOCAL. */
const local = (iso) => {
  const raw = String(iso);
  const tzAware = /[+-]\d{2}:?\d{2}$|Z$/.test(raw);
  const d = new Date(tzAware ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return raw;
  const shift = tzAware ? 8 * 3600 * 1000 : 0; // a naive stamp from the book is already local
  return new Date(d.getTime() + shift).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
};
const parseStamp = (iso) => {
  const raw = String(iso);
  const tzAware = /[+-]\d{2}:?\d{2}$|Z$/.test(raw);
  return new Date(tzAware ? raw.replace(" ", "T") : `${raw.replace(" ", "T")}+08:00`);
};

async function main() {
  const truth = gz("ac-reconcile-truth.json.gz");
  const heads = gz("ac-doc-headers.json.gz").rows;
  const outstanding = gz("ac-outstanding-so.json.gz");

  const hi = Object.fromEntries(truth.header_fields.map((f, i) => [f, i]));
  const li = Object.fromEntries(truth.line_fields.map((f, i) => [f, i]));
  const fi = Object.fromEntries(heads.so_fields.map((f, i) => [f, i]));

  if (!("currency" in hi)) {
    log("REFUSING: this snapshot predates the currency columns, so it cannot say which amounts are MYR. Re-cut ac-reconcile-truth.json.gz. (docs/bugs/0665)");
    process.exit(0);
  }

  const tTruth = parseStamp(truth.exported_at);
  const tHeads = parseStamp(heads.exportedAt);
  const now = new Date();
  const ageTruth = (now - tTruth) / 3600000;
  const ageHeads = (now - tHeads) / 3600000;

  log("=".repeat(78));
  log("SNAPSHOT VINTAGES - read these before any finding below");
  log("=".repeat(78));
  log(`   ac-doc-headers.json.gz      cut ${local(heads.exportedAt)}   ${ageHeads.toFixed(1)} h ago   <- UDF_BALANCE, the book's ONLY payment fact`);
  log(`   ac-reconcile-truth.json.gz  cut ${local(truth.exported_at)}   ${ageTruth.toFixed(1)} h ago   <- the book's net total and its currency`);
  log(`   they are ${(Math.abs(tTruth - tHeads) / 3600000).toFixed(1)} h apart. Production is read LIVE, now.`);
  log("");
  log(`   A PAYMENT RECORDED IN AUTOCOUNT IN THE LAST ${ageHeads.toFixed(1)} HOURS IS INVISIBLE TO THIS COUNT.`);
  log("   Every figure below is a floor, never a ceiling: the balance snapshot only ages.");
  log("");

  const bookHead = new Map();       // AutoCount DocNo -> truth header row
  for (const h of truth.types.SO.headers) {
    const d = String(h[hi.docNo]).trim();
    if (d) bookHead.set(d, h);
  }
  const bookUdf = new Map();        // AutoCount DocNo -> ac-doc-headers row
  for (const r of heads.so) {
    const d = String(r[fi.DocNo]).trim();
    if (d) bookUdf.set(d, r);
  }
  const bookLines = new Map();      // AutoCount DocNo -> truth line rows
  for (const r of truth.types.SO.lines) {
    const d = String(r[li.docNo]).trim();
    if (!d) continue;
    if (!bookLines.has(d)) bookLines.set(d, []);
    bookLines.get(d).push(r);
  }
  /* The extract sync-ac-delta.mjs's payment lane reads.  Its population is the
     DELIVERY-outstanding one (SODTL.Qty > TransferedQty and no invoice), NOT
     the unpaid one - 620 of its 2,789 documents already carry UDF_BALANCE 0.
     A document that has left it can never be seen by that lane again. */
  const inOutstanding = new Set(outstanding.map((r) => String(r.DocNo).trim()));

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  /* One statement: every migrated company-1 sales order, its stored money, and
     its payment rows summed.  The view's balance_sen_live is GREATEST(...,0);
     this recomputes it unclamped so an over-collection stays visible. */
  const rows = await sql`
    SELECT o.doc_no,
           o.linked_ac_docno                       AS ac_doc,
           o.status::text                          AS status,
           o.currency,
           o.debtor_name,
           o.so_date::text                         AS so_date,
           o.local_total_sen::bigint               AS total,
           o.paid_sen::bigint                      AS paid,
           o.balance_sen::bigint                   AS stored_bal,
           o.updated_at::text                      AS updated_at,
           COALESCE(p.paid_total, 0)::bigint       AS pay_sum,
           COALESCE(p.n_rows, 0)::int              AS pay_rows,
           COALESCE(p.n_human, 0)::int             AS pay_human
      FROM scm.mfg_sales_orders o
      LEFT JOIN (
             SELECT so_doc_no,
                    SUM(amount_sen)::bigint AS paid_total,
                    COUNT(*)::int           AS n_rows,
                    COUNT(*) FILTER (
                      WHERE method IS DISTINCT FROM 'imported'
                         OR COALESCE(note, '') NOT LIKE 'imported from AutoCount%'
                    )::int                  AS n_human
               FROM scm.mfg_sales_order_payments
              WHERE company_id = 1
              GROUP BY so_doc_no
           ) p ON p.so_doc_no = o.doc_no
     WHERE o.company_id = 1 AND o.linked_ac_docno IS NOT NULL
     ORDER BY o.doc_no`;

  log("=".repeat(78));
  log("POPULATION");
  log("=".repeat(78));
  log(`   migrated company-1 sales orders in the ERP (linked_ac_docno set)   ${rows.length}`);

  const noBook = [], foreign = [], bookCancelled = [];
  const cmp = [];
  for (const r of rows) {
    const ac = String(r.ac_doc).trim();
    const bh = bookHead.get(ac);
    const uh = bookUdf.get(ac);
    if (!bh || !uh) { noBook.push({ ...r, why: !bh ? "absent from the truth cut" : "absent from the header cut" }); continue; }
    const cur = String(bh[hi.currency] ?? "").trim() || "(blank)";
    if (cur !== "MYR") { foreign.push({ ...r, cur }); continue; }
    const cancelled = String(bh[hi.cancelled]).trim().toUpperCase() === "T";
    if (cancelled) bookCancelled.push({ ...r });
    const bookTotal = sen(bh[hi.netTotal]);
    const bookBal = sen(uh[fi.UDF_BALANCE]);
    cmp.push({
      doc: r.doc_no, ac,
      name: String(uh[fi.DebtorName] ?? r.debtor_name ?? "").trim(),
      soDate: r.so_date,
      status: r.status,
      erpTotal: Number(r.total),
      erpPaid: Number(r.paid),
      erpStoredBal: Number(r.stored_bal),
      paySum: Number(r.pay_sum),
      payRows: Number(r.pay_rows),
      payHuman: Number(r.pay_human),
      /* THE CHASE FIGURE.  Unclamped on purpose. */
      erpOwes: Number(r.total) - Number(r.pay_sum),
      bookTotal, bookBal,
      bookPaid: bookTotal - bookBal,
      bookEdited: String(uh[fi.LastModified] ?? "").trim(),
      bookCancelled: cancelled,
      erpCancelled: /cancel/i.test(String(r.status)),
      inOutstanding: inOutstanding.has(ac),
    });
  }
  log(`   comparable (the book states them, and states them in MYR)          ${cmp.length}`);
  log(`   NOT IN THE BOOK SNAPSHOT - reported, never compared                ${noBook.length}`);
  for (const n of noBook.slice(0, 30)) log(`      ${n.doc_no} (${n.ac_doc})  ${n.why}`);
  if (noBook.length > 30) log(`      ... and ${noBook.length - 30} more`);
  log(`   NOT IN MYR - reported, never subtracted (docs/bugs/0665, 0666)     ${foreign.length}`);
  for (const f of foreign.slice(0, 30)) log(`      ${f.doc_no} (${f.ac_doc}) ${f.cur}`);
  log(`   the book marks CANCELLED (still counted below, flagged per row)    ${bookCancelled.length}`);
  log("");

  const D = cmp.length;
  const pct = (n) => `${n} of ${D} (${D ? ((n / D) * 100).toFixed(1) : "0.0"}%)`;
  const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
  const enumerate = (title, arr, fmt) => {
    log("");
    log("-".repeat(78));
    log(title);
    log("-".repeat(78));
    if (!arr.length) { log("   none."); return; }
    const shown = arr.slice(0, LIST_LIMIT);
    for (const x of shown) log("   " + fmt(x));
    if (arr.length > shown.length) log(`   ... and ${arr.length - shown.length} more (LIST_LIMIT=${LIST_LIMIT})`);
  };

  /* ── the four buckets, cut on the CHASE figure ── */
  const A = cmp.filter((c) => c.bookBal === 0 && c.erpOwes > 0);
  const B = cmp.filter((c) => c.bookBal > 0 && c.erpOwes <= 0);
  const C = cmp.filter((c) => c.bookBal > 0 && c.erpOwes > 0 && c.erpOwes !== c.bookBal);
  const AGREE = cmp.filter((c) => c.erpOwes === c.bookBal);
  /* (d) the identity the importer created, broken: a total moved and neither
     stored column followed it.  Overlaps the others BY CONSTRUCTION and is
     reported as its own view, never added to them. */
  const Dbroken = cmp.filter((c) => c.erpPaid + c.erpStoredBal !== c.erpTotal);
  const totalMoved = cmp.filter((c) => c.erpTotal !== c.bookTotal);

  log("=".repeat(78));
  log("THE ANSWER - four buckets, each on the same denominator");
  log("=".repeat(78));
  log(`   denominator: ${D} migrated company-1 sales orders the book states in MYR`);
  log("");
  log(`   (a) THE BOOK SAYS SETTLED, THE ERP SAYS OWING   ${pct(A.length)}   ${rm(sum(A, (x) => x.erpOwes))}`);
  log("       -> we would chase customers for money the book says is already collected.");
  log(`   (b) the ERP says settled, the book says owing    ${pct(B.length)}   ${rm(sum(B, (x) => x.bookBal - Math.max(0, x.erpOwes)))}`);
  log("       -> we would miss a collection the book is still expecting.");
  log(`   (c) both say owing, different amounts            ${pct(C.length)}   net ${rm(sum(C, (x) => x.erpOwes - x.bookBal))}`);
  log(`       (gross: the ERP over-states by ${rm(sum(C.filter((x) => x.erpOwes > x.bookBal), (x) => x.erpOwes - x.bookBal))} on ${C.filter((x) => x.erpOwes > x.bookBal).length} order(s), under-states by ${rm(sum(C.filter((x) => x.erpOwes < x.bookBal), (x) => x.bookBal - x.erpOwes))} on ${C.filter((x) => x.erpOwes < x.bookBal).length})`);
  log(`   (d) the stored pair no longer adds up            ${pct(Dbroken.length)}   paid_sen + balance_sen <> local_total_sen`);
  log("       -> a total moved after the import and neither stored column followed it.");
  log(`   ... they agree                                   ${pct(AGREE.length)}`);
  log("");
  log(`   for reference: the ERP's total differs from the book's on ${pct(totalMoved.length)}`);
  log("");

  /* ── (a) in full: the bucket with a real-world consequence ── */
  const Asorted = [...A].sort((x, y) => y.erpOwes - x.erpOwes);
  enumerate(
    `BUCKET (a) IN FULL - ${A.length} order(s), ${rm(sum(A, (x) => x.erpOwes))} we would wrongly chase`,
    Asorted,
    (x) => `${x.doc} ${String(x.name).slice(0, 28).padEnd(28)} ordered ${x.soDate}  ` +
           `we would chase ${rm(x.erpOwes).padStart(14)}  book says still owed RM 0.00  ` +
           `(stored balance_sen ${rm(x.erpStoredBal)}, book edited ${x.bookEdited || "?"}` +
           `${x.erpCancelled ? ", ERP CANCELLED" : ""}${x.bookCancelled ? ", BOOK CANCELLED" : ""}` +
           `${x.payHuman ? `, ${x.payHuman} human payment row(s)` : ""})`,
  );

  const Alive = A.filter((x) => !x.erpCancelled && !x.bookCancelled);
  log("");
  log(`   of those, NEITHER side has cancelled: ${Alive.length} order(s), ${rm(sum(Alive, (x) => x.erpOwes))}`);
  log(`   a PERSON owns payment rows on:        ${A.filter((x) => x.payHuman > 0).length} of ${A.length} - those are never a script's to touch`);
  log("");
  log("   WHY THIS CANNOT FIX ITSELF, measured on this very bucket:");
  log(`      still inside ac-outstanding-so.json.gz (the extract the delta lane reads)  ${A.filter((x) => x.inOutstanding).length} of ${A.length}`);
  log(`      NO LONGER in it, so sync-ac-delta.mjs's payment lane cannot see them       ${A.filter((x) => !x.inOutstanding).length} of ${A.length}`);
  log("      That extract's population is the DELIVERY-outstanding one (SODTL.Qty >");
  log("      TransferedQty and no invoice), so an order AutoCount has finished delivering");
  log("      has left it - and a customer usually pays the balance ON delivery.");

  /* ── (b), (c) and (d) ── */
  enumerate(
    `BUCKET (b) - ${B.length} order(s) the ERP shows as settled while the book still expects ${rm(sum(B, (x) => x.bookBal - Math.max(0, x.erpOwes)))}`,
    [...B].sort((x, y) => y.bookBal - x.bookBal),
    (x) => `${x.doc} ${String(x.name).slice(0, 28).padEnd(28)} we would chase ${rm(Math.max(0, x.erpOwes)).padStart(14)}  book still owed ${rm(x.bookBal).padStart(14)}  (book edited ${x.bookEdited || "?"})`,
  );
  enumerate(
    `BUCKET (c) - ${C.length} order(s) where both say owing and the figures differ`,
    [...C].sort((x, y) => Math.abs(y.erpOwes - y.bookBal) - Math.abs(x.erpOwes - x.bookBal)),
    (x) => `${x.doc} ${String(x.name).slice(0, 28).padEnd(28)} we would chase ${rm(x.erpOwes).padStart(14)}  book ${rm(x.bookBal).padStart(14)}  out by ${rm(x.erpOwes - x.bookBal).padStart(14)}  (book edited ${x.bookEdited || "?"})`,
  );
  enumerate(
    `BUCKET (d) - ${Dbroken.length} order(s) whose stored paid + balance no longer equals the stored total`,
    [...Dbroken].sort((x, y) => Math.abs(y.erpPaid + y.erpStoredBal - y.erpTotal) - Math.abs(x.erpPaid + x.erpStoredBal - x.erpTotal)),
    (x) => `${x.doc} ${String(x.name).slice(0, 28).padEnd(28)} total ${rm(x.erpTotal).padStart(14)}  paid ${rm(x.erpPaid).padStart(14)} + balance ${rm(x.erpStoredBal).padStart(14)} = ${rm(x.erpPaid + x.erpStoredBal).padStart(14)}  (book total ${rm(x.bookTotal)})`,
  );

  /* ── the second figure, so nobody reads one for the other ── */
  const storedA = cmp.filter((c) => c.bookBal === 0 && c.erpStoredBal > 0);
  log("");
  log("=".repeat(78));
  log("THE SAME QUESTION ASKED OF THE STORED COLUMN, so the two are never confused");
  log("=".repeat(78));
  log("   Above is cut on the CHASE figure (local_total_sen - SUM(payments)), the one the");
  log("   SO list, the delivery board and the ASSR intake show.  The header also carries");
  log("   balance_sen, copied from UDF_BALANCE at import.  On that column instead:");
  log(`      book settled, stored balance_sen still owing   ${pct(storedA.length)}   ${rm(sum(storedA, (x) => x.erpStoredBal))}`);
  log(`      stored balance_sen = the book's UDF_BALANCE    ${pct(cmp.filter((c) => c.erpStoredBal === c.bookBal).length)}`);
  log("");

  /* ── the give-away lines ── */
  if (GIVEAWAY) {
    log("=".repeat(78));
    log("DROPPED BOOK LINES - is HC-SO-004188's missing RM 0.00 pair a pattern?");
    log("=".repeat(78));
    const items = await sql`
      SELECT i.doc_no, i.linked_ac_dtlkey AS k
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
       WHERE o.company_id = 1 AND o.linked_ac_docno IS NOT NULL
         AND COALESCE(i.cancelled, false) = false`;
    const keysByDoc = new Map();
    for (const it of items) {
      if (!keysByDoc.has(it.doc_no)) keysByDoc.set(it.doc_no, new Set());
      if (it.k != null) keysByDoc.get(it.doc_no).add(String(it.k));
    }
    let freeMissing = 0, pricedMissing = 0;
    const docsFree = new Set(), docsPriced = new Set();
    const freeRows = [], pricedRows = [];
    for (const c of cmp) {
      const have = keysByDoc.get(c.doc) ?? new Set();
      for (const b of bookLines.get(c.ac) ?? []) {
        const key = String(b[li.dtlKey]);
        if (have.has(key)) continue;
        const up = sen(b[li.unitPrice]);
        const row = { doc: c.doc, ac: c.ac, name: c.name, key, item: String(b[li.itemKey] ?? "").trim(), qty: Number(b[li.qty]), up };
        if (up === 0) { freeMissing++; docsFree.add(c.doc); freeRows.push(row); }
        else { pricedMissing++; docsPriced.add(c.doc); pricedRows.push(row); }
      }
    }
    log(`   book lines with NO ERP row, priced RM 0.00 (give-aways)   ${freeMissing} line(s) on ${docsFree.size} of ${D} order(s)`);
    log(`   book lines with NO ERP row, PRICED ABOVE ZERO             ${pricedMissing} line(s) on ${docsPriced.size} of ${D} order(s)   ${rm(sum(pricedRows, (r) => r.up * (r.qty || 1)))}`);
    log("   A line the ERP holds under a DIFFERENT DtlKey, or with none at all, counts as");
    log("   missing here.  That is deliberate: an entitlement nothing links to the book is");
    log("   the same problem as one that is absent.");
    enumerate(`give-away lines the customer is owed and our document does not show (${freeMissing})`,
      freeRows, (r) => `${r.doc} ${String(r.name).slice(0, 22).padEnd(22)} key=${r.key} ${String(r.item).slice(0, 28).padEnd(28)} book ${r.qty} x RM 0.00`);
    enumerate(`PRICED book lines with no ERP row (${pricedMissing}) - money, not a give-away`,
      [...pricedRows].sort((a, b) => b.up * (b.qty || 1) - a.up * (a.qty || 1)),
      (r) => `${r.doc} ${String(r.name).slice(0, 22).padEnd(22)} key=${r.key} ${String(r.item).slice(0, 28).padEnd(28)} book ${r.qty} x ${rm(r.up)} = ${rm(r.up * (r.qty || 1))}`);
  }

  log("");
  log("=".repeat(78));
  log("READ-ONLY.  Nothing above was written.  Every amount is MYR; every time is UTC+8.");
  log("Whether any of this is CORRECTED, and how, is the owner's ruling and not this");
  log("script's.  Saying a customer paid when they did not is worse than every other");
  log("error on this cutover.");
  log("=".repeat(78));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
