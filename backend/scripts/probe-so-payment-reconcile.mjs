#!/usr/bin/env node
/* probe-so-payment-reconcile - what does each side say this order is worth, and
 * what does it say the customer paid?  READ-ONLY.  SELECT only, no writes, no
 * DDL, no transaction.
 *
 * WHY IT EXISTS.  `repair-so-price-from-autocount` (run 34137116270, 2026-09-07
 * 23:13 local) copied the book's unit price onto 13 migrated lines and re-summed
 * the headers.  Three of the touched orders came out of it with
 * `paid_sen + balance_sen <> local_total_sen`, and the run said so.  The owner
 * asked to SEE those orders, not to have them corrected - and that is the right
 * order of operations, because WHAT A CUSTOMER PAID IS NOT AN ARITHMETIC
 * CONSEQUENCE OF A CORRECTED TOTAL.  Nothing here writes.
 *
 * THE FACT THAT MAKES THE TABLE READABLE, and it is not obvious from the
 * columns.  `mfg_sales_orders.paid_sen` was NEVER OBSERVED.  The cutover
 * (import-ac-outstanding-so.mjs:328) wrote
 *
 *     const bal = centi(h.UDF_BALANCE); const paid = Math.max(0, total - bal);
 *
 * so the BALANCE is the copied fact - AutoCount's own UDF_BALANCE field, what
 * the book says is still owed - and paid_sen is total-minus-balance computed
 * against the ERP's line total AT IMPORT TIME.  The single row this writes into
 * scm.mfg_sales_order_payments carries that same derived amount.  So when a
 * line price is later corrected, paid_sen does not BECOME wrong: it was already
 * a function of a total that has since moved.  This probe therefore prints,
 * side by side, the book's balance, the book's implied paid, the ERP's stored
 * paid, and the payment rows themselves - and never reconciles them for the
 * reader.
 *
 * THE CURRENCY GUARD.  A document not in MYR has amounts that are not
 * comparable to the ERP's; reading one as a difference is what took
 * RM 13,068.55 off a live purchase order (docs/bugs/0665, 0666).  Such a
 * document is REPORTED AND NOT COMPARED.  netTotal in the snapshot is the
 * LOCAL (MYR) amount and docTotal the document-currency one; this probe reads
 * the local pair and says which it read.
 *
 * TWO SNAPSHOTS, TWO VINTAGES, AND THE GAP IS PRINTED.  The book's line prices
 * come from ac-reconcile-truth.json.gz; UDF_BALANCE is not in it and comes from
 * ac-doc-headers.json.gz.  Both timestamps and the gap between them are printed
 * BEFORE any finding - docs/bugs/0672 is the entry where a checker called 86
 * receipts invented because it never subtracted its snapshot's age from today.
 *
 *   DATABASE_URL   required
 *   DOCS           optional, comma-separated ERP doc_no list.  Default: the
 *                  four orders the owner asked about.
 *   CENSUS         "0" to skip the blank-price census (below).  On by default.
 *
 * THE CENSUS.  Beside the named orders it counts every migrated company-1 sales
 * order line where the BOOK states 0.00 and the ERP holds a real price - the
 * population repair-so-price-from-autocount lists as HELD.  The owner granted
 * ONE exception to the blank-never-overwrites rule tonight, on HC-SO-010916
 * line 2; that rule is still the standing default everywhere else.  This census
 * exists so the others of that shape are LISTED for him, never swept.
 *
 * A DtlKey claimed by more than one ERP row is a DECOMPOSED SOFA - one book
 * line, one ERP row per compartment, the price on the first piece and 0.00 on
 * its siblings BY DESIGN.  Those are counted apart and never offered as
 * candidates; a keyed repair that ignored this proposed RM 2,216,501 of
 * invented revenue (docs/bugs/0673).
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

const DEFAULT_DOCS = ["HC-SO-002309", "HC-SO-010916", "HC-SO-013336", "HC-SO-004188"];
const DOCS = (process.env.DOCS || "").trim()
  ? process.env.DOCS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_DOCS;
const CENSUS = process.env.CENSUS !== "0";

const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m = "") => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const rm = (sen) => `RM ${(Number(sen) / 100).toFixed(2)}`;
const gunzip = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8"));

/* AutoCount doc no -> ERP doc no.  The cutover prefixes every migrated
   company-1 document with "HC-" (import-ac-outstanding-so.mjs:342). */
const toAc = (erpDoc) => String(erpDoc).replace(/^HC-/, "");

/* Malaysia is UTC+8 and has no DST.  Every time this prints is LOCAL. */
const local = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (UTC+8)";
};

async function main() {
  const truth = gunzip("ac-reconcile-truth.json.gz");
  const heads = gunzip("ac-doc-headers.json.gz").rows;

  const li = Object.fromEntries(truth.line_fields.map((f, i) => [f, i]));
  const hi = Object.fromEntries(truth.header_fields.map((f, i) => [f, i]));
  const fi = Object.fromEntries(heads.so_fields.map((f, i) => [f, i]));

  if (!("currency" in hi)) {
    log("REFUSING: this snapshot predates the currency columns, so it cannot say which amounts are MYR. Re-cut ac-reconcile-truth.json.gz. (docs/bugs/0665)");
    process.exit(0);
  }

  const tsTruth = new Date(truth.exported_at);
  const tsHeads = new Date(heads.exportedAt);
  const gapH = Math.abs(tsTruth - tsHeads) / 3600000;
  log("SNAPSHOT VINTAGES - read these before any finding below.");
  log(`   ac-reconcile-truth.json.gz  cut ${local(truth.exported_at)}  (line prices, currency, header net total)`);
  log(`   ac-doc-headers.json.gz      cut ${local(heads.exportedAt)}  (UDF_BALANCE, UDF_PAYEMENT, LastModified)`);
  log(`   they are ${gapH.toFixed(1)} hour(s) apart; production is read live, now.`);
  log("");

  const bookHead = new Map();
  for (const h of truth.types.SO.headers) bookHead.set(String(h[hi.docNo]), h);
  const bookLines = new Map();
  for (const r of truth.types.SO.lines) {
    const d = String(r[li.docNo]);
    if (!bookLines.has(d)) bookLines.set(d, []);
    bookLines.get(d).push(r);
  }
  const bookByKey = new Map();
  for (const r of truth.types.SO.lines) bookByKey.set(String(r[li.dtlKey]), r);
  const udf = new Map();
  for (const r of heads.so) udf.set(String(r[fi.DocNo]), r);

  const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });

  for (const doc of DOCS) {
    const ac = toAc(doc);
    log("=".repeat(78));
    log(`${doc}   (AutoCount ${ac})`);
    log("=".repeat(78));

    const [h] = await sql`
      SELECT doc_no, status::text AS status, currency, company_id,
             local_total_sen::bigint AS total, paid_sen::bigint AS paid,
             balance_sen::bigint AS bal, deposit_sen::bigint AS dep,
             payment_method, payment_date::text AS payment_date,
             so_date::text AS so_date, debtor_name,
             updated_at::text AS updated_at
        FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
    if (!h) { log("   NOT IN THE ERP. Nothing to compare."); log(""); continue; }

    const bh = bookHead.get(ac);
    const uh = udf.get(ac);
    if (!bh) {
      log("   NOT IN THE AutoCount SNAPSHOT. The ERP side is printed; the book side is UNKNOWN.");
    } else {
      const cur = String(bh[hi.currency] ?? "").trim() || "(blank)";
      if (cur !== "MYR") {
        log(`   THE BOOK STATES THIS DOCUMENT IN ${cur}, NOT MYR.`);
        log("   Its amounts are not comparable to the ERP's and this probe will not subtract them. (docs/bugs/0665, 0666)");
        log(`   book netTotal (LOCAL/MYR) ${rm(Math.round(Number(bh[hi.netTotal]) * 100))} | docTotal (${cur}) ${bh[hi.docTotal]} | rate ${bh[hi.rate]}`);
        log("");
        continue;
      }
    }

    const bookTotalSen = bh ? Math.round(Number(bh[hi.netTotal]) * 100) : null;
    const bookBalSen = uh ? Math.round(Number(uh[fi.UDF_BALANCE] || 0) * 100) : null;
    const bookImpliedPaid = bookTotalSen !== null && bookBalSen !== null ? bookTotalSen - bookBalSen : null;

    log("   WHAT THE BOOK SAYS");
    log(`      customer            ${h.debtor_name ?? ""}   order date ${h.so_date}`);
    if (bookTotalSen !== null) log(`      order is worth      ${rm(bookTotalSen)}   (SO.NetTotal, MYR, ${bh[hi.lineCount]} line(s), cancelled=${bh[hi.cancelled]})`);
    if (bookBalSen !== null) {
      log(`      still owed          ${rm(bookBalSen)}   (UDF_BALANCE, the ONLY payment fact the book carries)`);
      log(`      => implied paid     ${rm(bookImpliedPaid)}   (worth minus still-owed; the book records no payment row)`);
      log(`      UDF_PAYEMENT        ${JSON.stringify(uh[fi.UDF_PAYEMENT] ?? "")}   last edited in AutoCount ${uh[fi.LastModified]}`);
    }
    log("");

    const lines = await sql`
      SELECT line_no, item_code, qty::numeric AS qty, unit_price_sen::bigint AS up,
             total_sen::bigint AS total, linked_ac_dtlkey AS k
        FROM scm.mfg_sales_order_items WHERE doc_no = ${doc} ORDER BY line_no`;
    const lineSum = lines.reduce((t, l) => t + Number(l.total), 0);

    log("   WHAT THE ERP SAYS NOW (read live)");
    log(`      order total         ${rm(h.total)}   (header local_total_sen; the ${lines.length} line(s) sum to ${rm(lineSum)})`);
    log(`      stored paid         ${rm(h.paid)}   <- DERIVED at import as total minus balance, never observed`);
    log(`      stored balance      ${rm(h.bal)}   <- COPIED from the book's UDF_BALANCE at import`);
    log(`      deposit             ${rm(h.dep)}   status ${h.status}   currency ${h.currency}   company ${h.company_id}`);
    log(`      last touched        ${h.updated_at}`);
    const consistent = Number(h.total) === Number(h.paid) + Number(h.bal);
    log(`      paid + balance      ${rm(Number(h.paid) + Number(h.bal))} ${consistent ? "= the total" : `does NOT equal the total (${rm(h.total)}); out by ${rm(Number(h.paid) + Number(h.bal) - Number(h.total))}`}`);
    log("");

    const pays = await sql`
      SELECT paid_at::text AS paid_at, method, amount_sen::bigint AS amt,
             is_deposit, account_sheet, approval_code, note
        FROM scm.mfg_sales_order_payments WHERE so_doc_no = ${doc} ORDER BY paid_at, amount_sen`;
    log(`   WHAT THE CUSTOMER ACTUALLY PAID - ${pays.length} payment row(s) in scm.mfg_sales_order_payments`);
    if (pays.length === 0) {
      log("      none. The ERP holds no payment record for this order.");
    }
    for (const p of pays) {
      log(`      ${p.paid_at}  ${rm(p.amt)}  method=${p.method}  deposit=${p.is_deposit}  acct=${p.account_sheet ?? "-"}  appr=${p.approval_code ?? "-"}`);
      if (p.note) log(`         note: ${p.note}`);
    }
    const paySum = pays.reduce((t, p) => t + Number(p.amt), 0);
    const [v] = await sql`
      SELECT paid_total_sen::bigint AS paid_total, balance_sen_live::bigint AS bal_live
        FROM scm.mfg_sales_orders_with_payment_totals WHERE doc_no = ${doc}`;
    log(`      payment rows sum to ${rm(paySum)}; the list view shows paid ${rm(v?.paid_total ?? 0)} and a live balance of ${rm(v?.bal_live ?? 0)} (total minus payments)`);
    log("");

    if (bookImpliedPaid !== null) {
      const d = paySum - bookImpliedPaid;
      log("   THE DIFFERENCE, and which way it points");
      log(`      book says collected ${rm(bookImpliedPaid)}; the ERP's payment rows say ${rm(paySum)}`);
      if (d === 0) log("      they agree. Nothing to rule on here.");
      else if (d > 0) log(`      the ERP records ${rm(d)} MORE collected than the book - so as the ERP has it the customer is OVER-CREDITED and would be chased for ${rm(d)} less than the book says is outstanding.`);
      else log(`      the ERP records ${rm(-d)} LESS collected than the book - so as the ERP has it the customer is UNDER-CREDITED and would be chased for ${rm(-d)} more than the book says is outstanding.`);
      if (bookTotalSen !== null && Number(h.total) !== bookTotalSen) {
        log(`      and the ERP's own total (${rm(h.total)}) still differs from the book's (${rm(bookTotalSen)}) by ${rm(Number(h.total) - bookTotalSen)}.`);
      }
      log("");
    }

    if (bh) {
      log("   LINE BY LINE against the book (by AutoCount DtlKey)");
      const bl = bookLines.get(ac) ?? [];
      const seen = new Set();
      for (const l of lines) {
        const b = l.k ? bookByKey.get(String(l.k)) : null;
        if (l.k) seen.add(String(l.k));
        const bUp = b ? Math.round(Number(b[li.unitPrice]) * 100) : null;
        const bQty = b ? Number(b[li.qty]) : null;
        const same = b && bUp === Number(l.up) && bQty === Number(l.qty);
        const mark = !l.k ? "NO KEY " : b ? (same ? "match  " : "DIFFERS") : "NO BOOK";
        log(`      ${mark} line ${String(l.line_no).padStart(2)} key=${l.k ?? "-"} ${String(l.item_code).slice(0, 26).padEnd(26)} ` +
            `ERP ${Number(l.qty)} x ${rm(l.up)} = ${rm(l.total)}` +
            (b ? `   book ${bQty} x ${rm(bUp)}` : ""));
      }
      const missing = bl.filter((r) => !seen.has(String(r[li.dtlKey])));
      for (const r of missing) {
        log(`      NOT IN ERP  key=${r[li.dtlKey]} ${String(r[li.itemKey]).slice(0, 26).padEnd(26)} book ${Number(r[li.qty])} x ${rm(Math.round(Number(r[li.unitPrice]) * 100))}`);
      }
      log("");
    }
  }

  if (CENSUS) {
    log("=".repeat(78));
    log("CENSUS - lines where the BOOK states 0.00 and the ERP holds a real price");
    log("=".repeat(78));
    log("A blank never overwrites a value is the owner's standing default. He granted ONE");
    log("exception tonight, on HC-SO-010916 line 2. Everything else below is LISTED FOR HIM,");
    log("not touched. A decision per line is his, not this probe's.");
    log("");
    const all = await sql`
      SELECT i.doc_no, i.line_no, i.item_code, i.qty::numeric AS qty,
             i.unit_price_sen::bigint AS up, i.total_sen::bigint AS total,
             i.linked_ac_dtlkey AS k
        FROM scm.mfg_sales_order_items i
        JOIN scm.mfg_sales_orders o ON o.doc_no = i.doc_no
       WHERE o.company_id = 1 AND i.linked_ac_dtlkey IS NOT NULL AND i.unit_price_sen <> 0
       ORDER BY i.doc_no, i.line_no`;
    const perKey = new Map();
    for (const r of all) perKey.set(String(r.k), (perKey.get(String(r.k)) ?? 0) + 1);

    const single = [], decomposed = new Map(), foreign = [];
    for (const r of all) {
      const b = bookByKey.get(String(r.k));
      if (!b) continue;
      if (Math.round(Number(b[li.unitPrice]) * 100) !== 0) continue;
      const acDoc = String(b[li.docNo]);
      const bh2 = bookHead.get(acDoc);
      const cur = String(bh2?.[hi.currency] ?? "").trim();
      if (cur && cur !== "MYR") { foreign.push({ ...r, acDoc, cur }); continue; }
      if ((perKey.get(String(r.k)) ?? 0) > 1) {
        const g = decomposed.get(String(r.k)) ?? { k: r.k, doc: r.doc_no, rows: [] };
        g.rows.push(r); decomposed.set(String(r.k), g); continue;
      }
      single.push({ ...r, acDoc });
    }
    log(`ONE book line, ONE ERP row - these are the real candidates: ${single.length}`);
    for (const s of single) {
      log(`   ${s.doc_no} line ${s.line_no} key=${s.k} ${String(s.item_code).slice(0, 30).padEnd(30)} ERP keeps ${Number(s.qty)} x ${rm(s.up)} = ${rm(s.total)}; the book states no price`);
    }
    log("");
    log(`ONE book line decomposed into SEVERAL ERP rows (a sofa's compartments): ${decomposed.size} book line(s)`);
    log("   The book's price sits on the FIRST piece and its siblings are 0.00 BY DESIGN, so the");
    log("   group already sums to the book's line. These are NOT of the same shape. (docs/bugs/0673)");
    for (const g of [...decomposed.values()].slice(0, 10)) {
      log(`   ${g.doc} key=${g.k} -> ${g.rows.length} ERP rows: ${g.rows.map((r) => r.item_code).slice(0, 4).join(", ")}`);
    }
    if (decomposed.size > 10) log(`   ... and ${decomposed.size - 10} more`);
    if (foreign.length) {
      log("");
      log(`NOT IN MYR - reported, never compared: ${foreign.length}`);
      for (const f of foreign) log(`   ${f.doc_no} line ${f.line_no} key=${f.k} (AutoCount ${f.acDoc}, ${f.cur})`);
    }
  }

  log("");
  log("READ-ONLY. Nothing above was written. Every amount is MYR; every time is UTC+8.");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
