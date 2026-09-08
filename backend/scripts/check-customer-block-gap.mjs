#!/usr/bin/env node
/* check-customer-block-gap — READ-ONLY.  How many documents a driver cannot use.
 *
 * WHY.  Delivery orders opened to the shop floor on 2026-09-08 and the owner
 * sent two screens.  One is a DELIVERY ORDER whose phone, email and address all
 * render "—": a driver cannot deliver from that document whatever its figures
 * say.  The other is the Create-DO banner naming three fields its SOURCE SALES
 * ORDER does not carry.  He has seen two documents and does not know whether the
 * class is two or two thousand.  This counts both, before anything is repaired.
 *
 * THEY ARE DIFFERENT CAUSES AND THE COUNTS MUST NOT BE ADDED TOGETHER:
 *
 *   A  THE MIGRATED DELIVERY ORDER NEVER HAD A CUSTOMER BLOCK.
 *      lib/migrated-do-writer.mjs's insert names 14 columns and not one of them
 *      is phone / email / address1 / address2 / city / state / postcode, all of
 *      which scm.delivery_orders HAS and the interactive create path fills
 *      (delivery-orders-mfg.ts:3459).  So every delivery order that writer made
 *      shows "—" for the whole customer block.  The parent sales order holds it,
 *      because the SO importer copied it from the book.
 *
 *   B  A DERIVED FIELD ON THE SALES ORDER.  `city` is not copied from the book,
 *      it is COMPUTED by import-ac-outstanding-so.mjs:308 — the text after the
 *      5-digit postcode, up to the first comma, with the STATE name removed.
 *      Where the city and the state are the same word (Kuala Lumpur, Putrajaya,
 *      Labuan) that subtraction leaves the empty string and the city is lost,
 *      even though the book's InvAddr4 states it.
 *
 * AND ONE THING THAT IS NOT A GAP AT ALL.  `Email` and `Customer Type` are in
 * the banner because the ERP has those columns, not because the migration
 * dropped them: NO AutoCount export in backend/scripts/data/ carries an email or
 * a debtor-type column, and the sales-order "customer master" is the prior sales
 * orders themselves (mfg-sales-orders.ts:11405 autocompletes from
 * mfg_sales_orders).  There is nowhere to have carried them FROM.  This probe
 * counts them so the number is on the record and nobody goes looking again.
 *
 * READ-ONLY BY CONSTRUCTION: every statement here is a SELECT and there is no
 * APPLY flag, so no path through this file writes.
 *
 * PERSONAL DATA.  This prints COUNTS and DOCUMENT NUMBERS.  It never prints a
 * phone number, an address or an email — only whether one is present.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
/* The city rule is stated ONCE, in lib/customer-block.mjs, and shared with
   repair-customer-block.mjs — a probe that counts a gap by one rule while the
   repair closes it by another produces a before/after nobody can read. */
import { cityFromBook, vacant } from "./lib/customer-block.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 30);
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));
const blank = (v) => v == null || String(v).trim() === "";
const has = (v) => !blank(v);

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

async function main() {
  // ── the book: one row per sales order, the RICHEST header cut we hold ──────
  const dh = gz("ac-doc-headers.json.gz").rows;
  const soF = Object.fromEntries(dh.so_fields.map((f, i) => [f, i]));
  const book = new Map();
  for (const r of dh.so) {
    const no = r[soF.DocNo];
    if (!no) continue;
    book.set(no, {
      debtorName: r[soF.DebtorName], debtorCode: r[soF.DebtorCode],
      phone: r[soF.Phone1], deliverPhone: r[soF.DeliverPhone1],
      a1: r[soF.InvAddr1], a2: r[soF.InvAddr2], a3: r[soF.InvAddr3], a4: r[soF.InvAddr4],
      cancelled: r[soF.Cancelled],
    });
  }
  log(`book sales-order headers: ${book.size} (cut ${dh.exportedAt})`);
  log(`book header columns: ${dh.so_fields.length} — email column present: ${dh.so_fields.some((f) => /email/i.test(f))}; debtor-type column present: ${dh.so_fields.some((f) => /(CustomerType|DebtorType|AccType)/i.test(f))}`);

  // ── which customer columns each table actually has ────────────────────────
  const cols = async (t) => new Set((await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${t}`).map((r) => r.column_name));
  const doCols = await cols("delivery_orders");
  const soCols = await cols("mfg_sales_orders");
  const WANT = ["phone", "email", "customer_type", "address1", "address2", "city", "state", "customer_state", "postcode"];
  log("");
  log(`delivery_orders has: ${WANT.filter((c) => doCols.has(c)).join(", ")}`);
  log(`mfg_sales_orders has: ${WANT.filter((c) => soCols.has(c)).join(", ")}`);

  // ── A. DELIVERY ORDERS ────────────────────────────────────────────────────
  const dos = await sql`
    SELECT d.do_number, d.so_doc_no, d.linked_ac_docno, d.status,
           COALESCE(d.migrated_no_stock, false) AS migrated,
           d.phone, d.email, d.customer_type, d.address1, d.address2,
           d.city, d.state, d.postcode,
           s.phone AS so_phone, s.address1 AS so_a1, s.address2 AS so_a2,
           s.address3 AS so_a3, s.address4 AS so_a4, s.city AS so_city,
           s.customer_state AS so_state, s.postcode AS so_pc,
           s.email AS so_email, s.customer_type AS so_ctype,
           s.linked_ac_docno AS so_ac
      FROM scm.delivery_orders d
      LEFT JOIN scm.mfg_sales_orders s
             ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
     WHERE d.company_id = ${CO}
       AND COALESCE(UPPER(d.status::text), '') <> 'CANCELLED'`;

  const noContact = dos.filter((d) => blank(d.phone) && blank(d.address1) && blank(d.address2));
  const soHasBlock = (d) => has(d.so_phone) || has(d.so_a1) || has(d.so_a2) || has(d.so_a3) || has(d.so_a4);
  const bookOf = (d) => book.get(String(d.so_ac || "").trim()) || book.get(String(d.so_doc_no || "").replace(/^HC-/, ""));
  const bookHasBlock = (d) => { const b = bookOf(d); return !!b && (has(b.phone) || has(b.deliverPhone) || has(b.a1) || has(b.a2) || has(b.a3) || has(b.a4)); };

  const fromParent = noContact.filter(soHasBlock);
  const fromBookOnly = noContact.filter((d) => !soHasBlock(d) && bookHasBlock(d));
  const unanswerable = noContact.filter((d) => !soHasBlock(d) && !bookHasBlock(d));

  log("");
  log("=== A - DELIVERY ORDERS A DRIVER CANNOT USE ===");
  log(`company-${CO} delivery orders, not cancelled            ${dos.length}`);
  log(`  no phone AND no address line at all                   ${noContact.length}`);
  log(`    of them migrated (migrated_no_stock)                ${noContact.filter((d) => d.migrated).length}`);
  log(`    of them created in the ERP by a human               ${noContact.filter((d) => !d.migrated).length}`);
  log(`  REPAIRABLE from the parent sales order                ${fromParent.length}`);
  log(`  parent is blank too but the BOOK holds it             ${fromBookOnly.length}`);
  log(`  neither the ERP parent nor the book holds anything    ${unanswerable.length}   <- leave blank`);
  log(`  partial: has a phone or an address but not both       ${dos.filter((d) => !(blank(d.phone) && blank(d.address1) && blank(d.address2)) && (blank(d.phone) || (blank(d.address1) && blank(d.address2)))).length}`);
  if (unanswerable.length) log(`  unanswerable, first ${TOP}: ${unanswerable.slice(0, TOP).map((d) => d.do_number).join(" ")}`);

  // Per-field, over the whole non-cancelled DO population.
  log("");
  log("  field-by-field on ALL company-1 delivery orders (blank -> can the parent answer it?)");
  const FIELDS = [
    ["phone", (d) => d.phone, (d) => d.so_phone],
    ["address1", (d) => d.address1, (d) => d.so_a1],
    ["address2", (d) => d.address2, (d) => d.so_a2 || [d.so_a3, d.so_a4].filter(Boolean).join(", ")],
    ["city", (d) => d.city, (d) => d.so_city],
    ["state", (d) => d.state, (d) => d.so_state],
    ["postcode", (d) => d.postcode, (d) => d.so_pc],
    ["email", (d) => d.email, (d) => d.so_email],
    ["customer_type", (d) => d.customer_type, (d) => d.so_ctype],
  ];
  for (const [name, cur, src] of FIELDS) {
    const empty = dos.filter((d) => blank(cur(d)));
    const answerable = empty.filter((d) => has(src(d)));
    log(`    ${name.padEnd(14)} blank ${String(empty.length).padStart(6)}   parent has it ${String(answerable.length).padStart(6)}`);
  }

  // ── B. SALES ORDERS — the DERIVED field, and the two that never existed ───
  const sos = await sql`
    SELECT doc_no, linked_ac_docno, status, phone, email, customer_type,
           address1, address2, address3, address4, city, customer_state, postcode
      FROM scm.mfg_sales_orders
     WHERE company_id = ${CO}
       AND COALESCE(UPPER(status::text), '') <> 'CANCELLED'`;

  // The ERP's own postcode -> city master (mig 0022, editable at /localities).
  const locRows = await sql`SELECT postcode, city FROM scm.my_localities WHERE postcode IS NOT NULL AND city IS NOT NULL`;
  const byPc = new Map();
  for (const r of locRows) {
    const pc = String(r.postcode).trim();
    if (!byPc.has(pc)) byPc.set(pc, []);
    if (!byPc.get(pc).includes(r.city)) byPc.get(pc).push(r.city);
  }
  const cityOf = (pc) => byPc.get(String(pc).trim()) ?? [];

  const bookSo = (s) => book.get(String(s.linked_ac_docno || "").trim()) || book.get(String(s.doc_no || "").replace(/^HC-/, ""));
  const cityNull = sos.filter((s) => vacant(s.city));
  const cityJunk = sos.filter((s) => !blank(s.city) && vacant(s.city));
  const cityDecided = cityNull.map((s) => cityFromBook([s.address1, s.address2, s.address3, s.address4].map((v) => (v == null ? "" : String(v).trim())).filter(Boolean).join(", "), cityOf));
  const cityRepairable = cityDecided.filter((d) => d.city !== null);
  const cityRefused = new Map();
  for (const d of cityDecided) {
    if (d.city) continue;
    const k = d.reason.replace(/"[^"]*"/, '"…"').replace(/\d{5}/g, "NNNNN");
    cityRefused.set(k, (cityRefused.get(k) ?? 0) + 1);
  }
  const bookA4IsAState = new Map();
  for (const s of sos) { const b = bookSo(s); if (b && has(b.a4)) bookA4IsAState.set(String(b.a4).trim(), (bookA4IsAState.get(String(b.a4).trim()) ?? 0) + 1); }
  const pcNull = sos.filter((s) => blank(s.postcode));
  const pcFromBook = pcNull.filter((s) => { const b = bookSo(s); return !!b && /\b\d{5}\b/.test([b.a1, b.a2, b.a3, b.a4].filter(Boolean).join(", ")); });
  const noAddrAtAll = sos.filter((s) => blank(s.address1) && blank(s.address2) && blank(s.address3) && blank(s.address4));
  const noAddrBookHas = noAddrAtAll.filter((s) => { const b = bookSo(s); return !!b && (has(b.a1) || has(b.a2) || has(b.a3) || has(b.a4)); });
  const noPhone = sos.filter((s) => blank(s.phone));
  const noPhoneBookHas = noPhone.filter((s) => { const b = bookSo(s); return !!b && (has(b.phone) || has(b.deliverPhone)); });
  const noBookRow = sos.filter((s) => !bookSo(s));

  log("");
  log("=== B - SALES ORDERS: the DERIVED field, and the two that never existed ===");
  log(`company-${CO} sales orders, not cancelled               ${sos.length}`);
  log(`  no matching row in the committed book cut             ${noBookRow.length}`);
  log(`  city blank or nothing but punctuation                 ${cityNull.length}`);
  log(`    of those, a stored value with no letter in it       ${cityJunk.length}   ("." — what the state subtraction left)`);
  log(`    the order's own address states it AND the master confirms it  ${cityRepairable.length}   <- repairable`);
  for (const [r, n] of [...cityRefused].sort((a, b) => b[1] - a[1])) log(`    refused ${String(n).padStart(6)}  ${r}`);
  log(`  InvAddr4 is the STATE, not the city — top book values on these orders:`);
  log(`    ${[...bookA4IsAState].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k}=${n}`).join("  ")}`);
  log(`  postcode blank                                        ${pcNull.length}`);
  log(`    the book's address carries a 5-digit postcode       ${pcFromBook.length}`);
  log(`  address blank on ALL FOUR lines                       ${noAddrAtAll.length}`);
  log(`    the book holds an address for it                    ${noAddrBookHas.length}`);
  log(`  phone blank                                           ${noPhone.length}`);
  log(`    the book holds a phone for it                       ${noPhoneBookHas.length}`);
  log(`  email blank                                           ${sos.filter((s) => blank(s.email)).length}   <- NOT a migration loss: no AutoCount export has an email column`);
  log(`  customer_type blank                                   ${sos.filter((s) => blank(s.customer_type)).length}   <- NOT a migration loss: AutoCount has no debtor-type column here`);

  // ── C. the two documents the owner sent ───────────────────────────────────
  const NAMED_DO = (process.env.NAMED_DO || "HC-DO-011556").split(",").map((x) => x.trim()).filter(Boolean);
  const NAMED_SO = (process.env.NAMED_SO || "HC-SO-013124,HC-SO-012565").split(",").map((x) => x.trim()).filter(Boolean);
  log("");
  log("=== C - the documents the owner sent (present/blank only; no personal data printed) ===");
  for (const n of NAMED_DO) {
    const d = dos.find((x) => x.do_number === n);
    if (!d) { log(`  ${n}: NOT FOUND among non-cancelled company-${CO} delivery orders`); continue; }
    log(`  ${n} <- ${d.so_doc_no ?? "(no parent)"}  migrated=${d.migrated}  DO: phone=${has(d.phone)} addr=${has(d.address1) || has(d.address2)} city=${has(d.city)} email=${has(d.email)} | parent SO: phone=${has(d.so_phone)} addr=${has(d.so_a1) || has(d.so_a2) || has(d.so_a3) || has(d.so_a4)} city=${has(d.so_city)}`);
    const b = bookOf(d);
    log(`     book row for its sales order: ${b ? `present  phone=${has(b.phone)} addr=${has(b.a1) || has(b.a2) || has(b.a3)} a4=${has(b.a4)}` : "ABSENT"}`);
  }
  for (const n of NAMED_SO) {
    const s = sos.find((x) => x.doc_no === n);
    if (!s) { log(`  ${n}: NOT FOUND among non-cancelled company-${CO} sales orders`); continue; }
    const b = bookSo(s);
    log(`  ${n} status=${s.status}  ERP: phone=${has(s.phone)} addr=${has(s.address1) || has(s.address2) || has(s.address3) || has(s.address4)} city=${has(s.city)} state=${has(s.customer_state)} pc=${has(s.postcode)} email=${has(s.email)} ctype=${has(s.customer_type)}`);
    log(`     book: ${b ? `present  phone=${has(b.phone)} a1=${has(b.a1)} a3=${has(b.a3)} a4=${has(b.a4)}` : "ABSENT"}`);
  }

  // ── D. CONTROL — the numbers this work must not move ──────────────────────
  const [ctl] = await sql`
    SELECT (SELECT count(*) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_docs,
           (SELECT count(*) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO}) AS so_lines,
           (SELECT COALESCE(SUM(i.qty), 0) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO}) AS so_qty,
           (SELECT COALESCE(SUM(local_total_sen), 0) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_total_sen,
           (SELECT COALESCE(SUM(paid_sen), 0) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_paid_sen,
           (SELECT count(*) FROM scm.delivery_orders WHERE company_id = ${CO}) AS do_docs,
           (SELECT count(*) FROM scm.delivery_order_items WHERE company_id = ${CO}) AS do_lines,
           (SELECT COALESCE(SUM(qty), 0) FROM scm.delivery_order_items WHERE company_id = ${CO}) AS do_qty,
           (SELECT COALESCE(SUM(local_total_sen), 0) FROM scm.delivery_orders WHERE company_id = ${CO}) AS do_total_sen,
           (SELECT count(*) FROM scm.inventory_movements) AS movements,
           (SELECT COALESCE(SUM(qty), 0) FROM scm.inventory_movements) AS movement_qty`;
  const alloc = await sql`
    SELECT COALESCE(i.stock_status, '(null)') AS s, count(*) AS n
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${CO} GROUP BY 1 ORDER BY 1`;
  log("");
  log("=== D - CONTROL: none of these may move ===");
  for (const [k, v] of Object.entries(ctl)) log(`  ${String(k).padEnd(14)} ${v}`);
  log(`  allocation      ${alloc.map((r) => `${r.s}=${r.n}`).join(" | ")}`);

  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* closing */ } process.exit(1); });
