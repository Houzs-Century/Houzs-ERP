#!/usr/bin/env node
// ----------------------------------------------------------------------------
// CARRY THE CUSTOMER BLOCK ONTO THE DOCUMENTS THAT NEVER GOT ONE, AND PUT BACK
// THE CITY A SUBTRACTION DELETED.
//
// WHAT THE OWNER SAW, 2026-09-08, the day delivery orders opened to staff:
// a delivery order whose phone, email and address all render "—". A driver
// cannot deliver from that document whatever its figures say. And the Create-DO
// banner naming three fields its source sales order does not carry.
//
// TWO ARMS, TWO CAUSES, NEITHER INHERITED FROM THE OTHER:
//
//   SO  THE CITY. `city` is not a book column — AutoCount has none, and
//       `InvAddr4` is the STATE (2,647 "Selangor", 1,797 "Penang" on the
//       committed cut). The city, where the book has one, is the text after the
//       5-digit postcode inside the address. import-ac-outstanding-so.mjs:308
//       reads it and then SUBTRACTS the state name from it, which is right on
//       914 addresses ("PADANG SERAI KEDAH" -> "PADANG SERAI") and deletes the
//       whole city on 1,935 — every address whose city and state are the same
//       word (Kuala Lumpur, Melaka, Putrajaya, Penang), plus a few left holding
//       nothing but a full stop ("KUALA LUMPUR." -> ".").
//
//       This re-reads that text from the order's OWN address lines — which are
//       the book's InvAddr1..4 copied verbatim by that importer — and accepts it
//       only when `scm.my_localities`, the ERP's own postcode -> city master,
//       lists it as a city of that exact postcode. What is written is the
//       master's spelling. "Selangor" at 40000 is REFUSED (the master says Shah
//       Alam), a postcode with nothing after it is REFUSED, and "KL" is REFUSED
//       — the book has to say it and the master has to confirm it. The rule and
//       its refusals live in lib/customer-block.mjs, shared with the probe that
//       counts the gap, so the two cannot answer differently.
//
//   DO  THE WHOLE BLOCK. lib/migrated-do-writer.mjs's INSERT names 14 columns
//       and not one of them is phone / email / address / city / state /
//       postcode, all of which scm.delivery_orders HAS and the interactive
//       create path fills (delivery-orders-mfg.ts:3459). Every delivery order
//       that writer made therefore shows "—" for the entire customer block. The
//       parent sales order holds it, because the SO importer copied it from the
//       book; where the parent is blank too, the book's own sales-order header
//       is read directly. Field map: `DO_CARRY` in lib/customer-block.mjs, a
//       SUBSET of src/scm/lib/so-to-do-fields.ts — the file that already owns
//       "what an SO carries into a DO" for both live converters.
//
// THE OWNER'S DELIVERED-ORDER RULING, AND ITS LIMIT. He ruled today
// 「已经出货了的就随便把 不去关注了 留个底记录而已 数据对不对不重要了」 — for lines
// already delivered, do not spend effort on accuracy. `SO-013124` is fully
// delivered, so that ruling covers its DATA. This lane deliberately reads the
// line he is pointing at as a DIFFERENT one: a delivery order with no phone and
// no address is unusable as PAPERWORK even when its figures do not matter. So
// the customer BLOCK is carried onto delivered orders, and nothing else about
// them is touched — no line, no quantity, no price, no payment, no status.
//
// WHAT THIS NEVER DOES:
//   · never overwrites a value. Every UPDATE carries its own emptiness
//     predicate, so a field a human filled in the ERP is invisible to it.
//   · never writes a value neither the sales order nor the book states. Where
//     both are silent the field stays blank and the count is printed.
//   · never touches a line, a quantity, a price, a payment column or a status,
//     and never enqueues an AutoCount outbox row. Owner 2026-09-08:
//     「写回autocount的你不需要理了」.
//   · never prints a phone number, an address or an email. Counts and document
//     numbers only — these are customer records.
//
// RE-RUN: idempotent and inert on a second run. Every UPDATE requires the target
// column to be empty and the source to be present, so once a field is filled
// this script cannot see it again; a re-run writes 0 rows and says so. It is
// also safe to run beside the other cutover lanes — it takes no lock beyond its
// own rows and touches no column any of them writes.
//
// ONE THING THE VERIFICATION WILL FLAG AND IT IS NOT A BUG: if somebody fills one
// of these fields by hand in the seconds between the plan and the apply, the
// per-column guard KEEPS their value and the re-read then disagrees with what
// this run planned. That is reported as a wrong value on purpose - a
// disagreement between what a write intended and what the row now holds is
// always worth a person looking, and quietly excusing the one benign shape would
// excuse the malignant ones with it.
//
//   MODE=plan (default)  read, classify, print every count, write NOTHING.
//   MODE=apply           needs CONFIRM="CARRY THE CUSTOMER BLOCK". Writes in ONE
//                        transaction, then re-reads on a FRESH connection and
//                        asserts the SHAPE — each written delivery-order value
//                        against the sales-order value it was taken from, and
//                        each written city against the address master — not a
//                        row count.
//   ARM=both|so|do       which arm to run (default both; the SO arm runs first
//                        so the DO arm can carry the city it just put back).
//   COMPANY_ID=1         AED_HOUZS.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { DO_CARRY, cityFromBook, clean, has, vacant } from "./lib/customer-block.mjs";

const url = process.env.DATABASE_URL;
if (!url) { console.error("need DATABASE_URL"); process.exit(2); }
const MODE = (process.env.MODE || "plan").toLowerCase();
const APPLY = MODE === "apply";
const ARM = (process.env.ARM || "both").toLowerCase();
const CO = Number(process.env.COMPANY_ID ?? 1);
const TOP = Number(process.env.TOP ?? 25);
const CONFIRM_PHRASE = "CARRY THE CUSTOMER BLOCK";
const here = path.dirname(fileURLToPath(import.meta.url));
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const gz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, "data", f))).toString("utf8").replace(/^﻿/, ""));

if (APPLY && (process.env.CONFIRM ?? "").trim() !== CONFIRM_PHRASE) {
  console.error(`MODE=apply requires CONFIRM="${CONFIRM_PHRASE}" — refusing to write.`);
  process.exit(2);
}

const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });

/** The book's sales-order headers, keyed by AutoCount DocNo. */
function loadBook() {
  const dh = gz("ac-doc-headers.json.gz").rows;
  const F = Object.fromEntries(dh.so_fields.map((f, i) => [f, i]));
  const book = new Map();
  for (const r of dh.so) {
    const no = r[F.DocNo];
    if (!no) continue;
    book.set(no, {
      phone: clean(r[F.Phone1]) ?? clean(r[F.DeliverPhone1]),
      a1: clean(r[F.InvAddr1]), a2: clean(r[F.InvAddr2]),
      a3: clean(r[F.InvAddr3]), a4: clean(r[F.InvAddr4]),
    });
  }
  return { book, exportedAt: dh.exportedAt };
}

const joinAddr = (...parts) => parts.map(clean).filter(Boolean).join(", ");

async function main() {
  log(`mode=${MODE} arm=${ARM} company=${CO}`);
  const { book, exportedAt } = loadBook();
  log(`book sales-order headers: ${book.size} (cut ${exportedAt})`);

  /* Every column DO_CARRY names has to exist on BOTH tables before anything is
     planned. Half of the delivery order's block (email, customer_type,
     building_type, customer_country, the emergency contacts) came in with the
     2990 port rather than a numbered migration in this tree, so the schema files
     here do not describe it — the live table is the authority. Asserted rather
     than assumed: a missing column would otherwise surface as a raw SQL error
     halfway through a plan. */
  const columnsOf = async (t) => new Set((await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'scm' AND table_name = ${t}`).map((r) => r.column_name));
  {
    const doCols = await columnsOf("delivery_orders");
    const soCols = await columnsOf("mfg_sales_orders");
    const soNeeds = ["phone", "email", "customer_type", "building_type", "address1", "address2",
      "address3", "address4", "city", "customer_state", "postcode", "customer_country",
      "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relationship"];
    const missingDo = DO_CARRY.map(([c]) => c).filter((c) => !doCols.has(c));
    const missingSo = soNeeds.filter((c) => !soCols.has(c));
    if (missingDo.length || missingSo.length) {
      console.error(`REFUSING: scm.delivery_orders lacks [${missingDo.join(", ")}]; scm.mfg_sales_orders lacks [${missingSo.join(", ")}]`);
      await sql.end();
      process.exit(2);
    }
    log(`schema check: all ${DO_CARRY.length} delivery-order columns and all ${soNeeds.length} sales-order columns present`);
  }

  // The ERP's own postcode -> city master (mig 0022, editable at /localities).
  const locRows = await sql`SELECT postcode, city FROM scm.my_localities WHERE postcode IS NOT NULL AND city IS NOT NULL`;
  const byPc = new Map();
  for (const r of locRows) {
    const pc = String(r.postcode).trim();
    if (!byPc.has(pc)) byPc.set(pc, []);
    if (!byPc.get(pc).includes(r.city)) byPc.get(pc).push(r.city);
  }
  const cityOf = (pc) => byPc.get(String(pc).trim()) ?? [];
  log(`address master: ${locRows.length} rows over ${byPc.size} postcodes`);

  // ── the CONTROL, before ───────────────────────────────────────────────────
  const control = async (client) => {
    const [r] = await client`
      SELECT (SELECT count(*) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_docs,
             (SELECT count(*) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO}) AS so_lines,
             (SELECT COALESCE(SUM(i.qty), 0) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO}) AS so_qty,
             (SELECT COALESCE(SUM(local_total_sen), 0) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_total_sen,
             (SELECT COALESCE(SUM(paid_sen), 0) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_paid_sen,
             (SELECT COALESCE(SUM(balance_sen), 0) FROM scm.mfg_sales_orders WHERE company_id = ${CO}) AS so_balance_sen,
             (SELECT count(*) FROM scm.delivery_orders WHERE company_id = ${CO}) AS do_docs,
             (SELECT count(*) FROM scm.delivery_order_items WHERE company_id = ${CO}) AS do_lines,
             (SELECT COALESCE(SUM(qty), 0) FROM scm.delivery_order_items WHERE company_id = ${CO}) AS do_qty,
             (SELECT COALESCE(SUM(local_total_sen), 0) FROM scm.delivery_orders WHERE company_id = ${CO}) AS do_total_sen,
             (SELECT count(*) FROM scm.inventory_movements) AS movements,
             (SELECT COALESCE(SUM(qty), 0) FROM scm.inventory_movements) AS movement_qty,
             (SELECT count(*) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO} AND i.stock_status = 'READY') AS ready,
             (SELECT count(*) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO} AND i.stock_status = 'PENDING') AS pending,
             (SELECT count(*) FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no WHERE h.company_id = ${CO} AND i.stock_status = 'PARTIAL') AS partial`;
    return r;
  };
  const before = await control(sql);

  // ── ARM SO — the city ─────────────────────────────────────────────────────
  const soPlan = [];
  const soRefused = new Map();
  let soBookDisagrees = 0;
  if (ARM === "both" || ARM === "so") {
    const rows = await sql`
      SELECT doc_no, linked_ac_docno, address1, address2, address3, address4, city, postcode
        FROM scm.mfg_sales_orders
       WHERE company_id = ${CO}
         AND COALESCE(UPPER(status::text), '') <> 'CANCELLED'`;
    for (const s of rows) {
      if (!vacant(s.city)) continue;
      const addr = joinAddr(s.address1, s.address2, s.address3, s.address4);
      if (!addr) { soRefused.set("the order carries no address at all", (soRefused.get("the order carries no address at all") ?? 0) + 1); continue; }
      const { city, reason } = cityFromBook(addr, cityOf);
      if (!city) { soRefused.set(reason.replace(/"[^"]*"/, '"…"').replace(/\d{5}/g, "NNNNN"), (soRefused.get(reason.replace(/"[^"]*"/, '"…"').replace(/\d{5}/g, "NNNNN")) ?? 0) + 1); continue; }
      /* The order's address lines ARE the book's InvAddr1..4, copied verbatim.
         Where they are NOT — somebody corrected the address in the ERP — the
         ERP's is the better source and the divergence is COUNTED, not hidden. */
      const b = book.get(String(s.linked_ac_docno ?? "").trim()) || book.get(String(s.doc_no).replace(/^HC-/, ""));
      if (b) { const bookAddr = joinAddr(b.a1, b.a2, b.a3, b.a4); if (bookAddr && bookAddr !== addr) soBookDisagrees++; }
      soPlan.push({ docNo: s.doc_no, city });
    }
  }

  // ── ARM DO — the whole block ──────────────────────────────────────────────
  const doPlan = [];
  const doSourceTally = { parent: 0, book: 0 };
  let doNoSource = 0;
  if (ARM === "both" || ARM === "do") {
    const rows = await sql`
      SELECT d.id, d.do_number, d.so_doc_no,
             d.phone, d.email, d.customer_type, d.building_type, d.address1, d.address2,
             d.city, d.state, d.customer_state, d.postcode, d.customer_country,
             d.emergency_contact_name, d.emergency_contact_phone, d.emergency_contact_relationship,
             s.doc_no AS so_doc, s.linked_ac_docno AS so_ac,
             s.phone AS s_phone, s.email AS s_email, s.customer_type AS s_customer_type,
             s.building_type AS s_building_type, s.address1 AS s_address1, s.address2 AS s_address2,
             s.address3 AS s_address3, s.address4 AS s_address4, s.city AS s_city,
             s.customer_state AS s_customer_state, s.postcode AS s_postcode,
             s.customer_country AS s_customer_country,
             s.emergency_contact_name AS s_emergency_contact_name,
             s.emergency_contact_phone AS s_emergency_contact_phone,
             s.emergency_contact_relationship AS s_emergency_contact_relationship
        FROM scm.delivery_orders d
        LEFT JOIN scm.mfg_sales_orders s
               ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
       WHERE d.company_id = ${CO}
         AND COALESCE(UPPER(d.status::text), '') <> 'CANCELLED'`;
    for (const d of rows) {
      /* The sales order as the carry map expects it. The city the SO arm is
         about to write is applied here in memory so ONE run closes both. */
      const soCity = soPlan.find((p) => p.docNo === d.so_doc)?.city ?? d.s_city;
      const parent = d.so_doc
        ? {
          phone: d.s_phone, email: d.s_email, customer_type: d.s_customer_type,
          building_type: d.s_building_type, address1: d.s_address1, address2: d.s_address2,
          address3: d.s_address3, address4: d.s_address4, city: soCity,
          customer_state: d.s_customer_state, postcode: d.s_postcode,
          customer_country: d.s_customer_country,
          emergency_contact_name: d.s_emergency_contact_name,
          emergency_contact_phone: d.s_emergency_contact_phone,
          emergency_contact_relationship: d.s_emergency_contact_relationship,
        }
        : null;
      /* The book's own sales-order header, folded into the same shape, for a
         delivery order whose ERP parent is missing or blank. */
      const b = book.get(String(d.so_ac ?? "").trim()) || book.get(String(d.so_doc_no ?? "").replace(/^HC-/, ""));
      const fromBook = b
        ? {
          phone: b.phone, email: null, customer_type: null, building_type: null,
          address1: b.a1, address2: b.a2, address3: b.a3, address4: b.a4,
          city: null, customer_state: null, postcode: null, customer_country: null,
          emergency_contact_name: null, emergency_contact_phone: null,
          emergency_contact_relationship: null,
        }
        : null;

      const set = {};
      let usedParent = false, usedBook = false;
      for (const [col, pick] of DO_CARRY) {
        if (!vacant(d[col])) continue;
        const pv = parent ? clean(pick(parent)) : null;
        if (pv !== null) { set[col] = pv; usedParent = true; continue; }
        const bv = fromBook ? clean(pick(fromBook)) : null;
        if (bv !== null) { set[col] = bv; usedBook = true; }
      }
      if (Object.keys(set).length === 0) {
        if (vacant(d.phone) && vacant(d.address1) && vacant(d.address2)) doNoSource++;
        continue;
      }
      if (usedParent) doSourceTally.parent++;
      if (usedBook && !usedParent) doSourceTally.book++;
      doPlan.push({ id: d.id, doNumber: d.do_number, soDoc: d.so_doc_no, set });
    }
  }

  // ── the plan ──────────────────────────────────────────────────────────────
  log("");
  log("=== PLAN ===");
  log(`SALES ORDERS — city to write            ${soPlan.length}`);
  for (const [r, n] of [...soRefused].sort((a, b) => b[1] - a[1])) log(`  refused ${String(n).padStart(6)}  ${r}`);
  log(`  of the writes, the book's address differs from the ERP's: ${soBookDisagrees}`);
  if (soPlan.length) log(`  first ${TOP}: ${soPlan.slice(0, TOP).map((p) => p.docNo).join(" ")}`);
  log("");
  log(`DELIVERY ORDERS — headers to fill       ${doPlan.length}`);
  log(`  answered by the parent sales order    ${doSourceTally.parent}`);
  log(`  answered by the book alone            ${doSourceTally.book}`);
  log(`  still with no phone and no address    ${doNoSource}   <- neither source has one; stays blank`);
  const perCol = new Map();
  for (const p of doPlan) for (const k of Object.keys(p.set)) perCol.set(k, (perCol.get(k) ?? 0) + 1);
  for (const [k, n] of [...perCol].sort((a, b) => b[1] - a[1])) log(`    ${k.padEnd(32)} ${n}`);
  if (doPlan.length) log(`  first ${TOP}: ${doPlan.slice(0, TOP).map((p) => p.doNumber).join(" ")}`);

  if (!APPLY) {
    log("");
    log("MODE=plan — nothing was written.");
    await sql.end();
    return;
  }

  // ── the write, one transaction ────────────────────────────────────────────
  /* Batched with a VALUES join rather than one statement per row: a per-row loop
     over a few thousand documents is a few thousand round trips inside ONE
     transaction, from a hosted runner, against a pooled connection — minutes of
     open transaction for a header edit. The EMPTINESS PREDICATE is carried into
     every batched statement unchanged, so batching never widens what is touched. */
  const CHUNK = 200;
  /* NO TABLE ALIAS on the UPDATE target, and that is not a style choice.
     `audit:release-discipline` matches `UPDATE <name> SET`; `UPDATE scm.t d SET`
     does not match it, so aliasing here made this script read as a NON-writer and
     silently exempted it from all four release rules. Measured: the auditor's
     write count fell 244 -> 243 the moment the alias went in. A gate that cannot
     match reports a pass (CLAUDE.md), so the target is spelled out. */
  const EMPTY = (t, c) => `(${t}.${c} IS NULL OR btrim(${t}.${c}) !~ '[A-Za-z0-9]')`;
  let soWritten = 0, doWritten = 0;
  await sql.begin(async (tx) => {
    for (let i = 0; i < soPlan.length; i += CHUNK) {
      const batch = soPlan.slice(i, i + CHUNK);
      const vals = batch.map((_, k) => `($${k * 2 + 1}::text, $${k * 2 + 2}::text)`).join(",");
      const r = await tx.unsafe(
        `UPDATE scm.mfg_sales_orders SET city = v.city
           FROM (VALUES ${vals}) AS v(doc_no, city)
          WHERE scm.mfg_sales_orders.doc_no = v.doc_no
            AND scm.mfg_sales_orders.company_id = ${CO}
            AND ${EMPTY("scm.mfg_sales_orders", "city")}`,
        batch.flatMap((p) => [p.docNo, p.city]),
      );
      soWritten += r.count;
    }
    /* Grouped by the exact SET of columns being filled, so one statement serves
       every document needing the same fields. Column names come from DO_CARRY, a
       literal list in lib/customer-block.mjs — never from a row — so nothing here
       can be steered by data. */
    const groups = new Map();
    for (const p of doPlan) {
      const key = Object.keys(p.set).sort().join(",");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const [key, rows] of groups) {
      const cols = key.split(",");
      for (let i = 0; i < rows.length; i += CHUNK) {
        const batch = rows.slice(i, i + CHUNK);
        const width = cols.length + 1;
        const vals = batch.map((_, k) => `($${k * width + 1}::uuid, ${cols.map((__, j) => `$${k * width + 2 + j}::text`).join(",")})`).join(",");
        const r = await tx.unsafe(
          /* PER-COLUMN guard, not one guard for the statement. A row is grouped
             by the SET of columns it needs, so an OR-joined WHERE would let a
             row through on ONE still-empty column and then assign ALL of them -
             overwriting a value somebody filled between the plan and the apply.
             That is the one promise this script makes, so the guard is repeated
             inside every assignment and the WHERE only decides which rows to
             visit. */
          `UPDATE scm.delivery_orders SET ${cols.map((c) => `${c} = CASE WHEN ${EMPTY("scm.delivery_orders", c)} THEN v.${c} ELSE scm.delivery_orders.${c} END`).join(", ")}
             FROM (VALUES ${vals}) AS v(id, ${cols.join(",")})
            WHERE scm.delivery_orders.id = v.id
              AND (${cols.map((c) => EMPTY("scm.delivery_orders", c)).join(" OR ")})`,
          batch.flatMap((p) => [p.id, ...cols.map((c) => p.set[c])]),
        );
        doWritten += r.count;
      }
    }
  });
  log("");
  log(`WROTE: ${soWritten} sales-order cities, ${doWritten} delivery-order headers.`);

  // ── verification: FRESH connection, assert the SHAPE ──────────────────────
  const verify = postgres(url, { ssl: "require", prepare: false, max: 1 });
  try {
    /* The address master is re-read HERE too. Asserting a written city against
       the map the writing session already held would only prove the write agreed
       with itself. */
    const freshLoc = await verify`SELECT postcode, city FROM scm.my_localities WHERE postcode IS NOT NULL AND city IS NOT NULL`;
    const freshByPc = new Map();
    for (const r of freshLoc) {
      const pc = String(r.postcode).trim();
      if (!freshByPc.has(pc)) freshByPc.set(pc, []);
      if (!freshByPc.get(pc).includes(r.city)) freshByPc.get(pc).push(r.city);
    }
    const freshCityOf = (pc) => freshByPc.get(String(pc).trim()) ?? [];

    const soIds = soPlan.map((p) => p.docNo);
    const doIds = doPlan.map((p) => p.id);
    const wantCity = new Map(soPlan.map((p) => [p.docNo, p.city]));
    const soBack = soIds.length
      ? await verify`SELECT doc_no, city, postcode, address1, address2, address3, address4
                       FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ANY(${soIds})`
      : [];
    let soWrongValue = 0, soNotAMasterCity = 0;
    for (const r of soBack) {
      if (clean(r.city) !== wantCity.get(r.doc_no)) { soWrongValue++; continue; }
      const addr = joinAddr(r.address1, r.address2, r.address3, r.address4);
      const again = cityFromBook(addr, freshCityOf);
      if (again.city !== clean(r.city)) soNotAMasterCity++;
    }

    const doBack = doIds.length
      ? await verify`
        SELECT d.id, d.do_number, d.phone, d.email, d.customer_type, d.building_type,
               d.address1, d.address2, d.city, d.state, d.customer_state, d.postcode,
               d.customer_country, d.emergency_contact_name, d.emergency_contact_phone,
               d.emergency_contact_relationship,
               s.phone AS s_phone, s.address1 AS s_address1, s.address2 AS s_address2,
               s.address3 AS s_address3, s.address4 AS s_address4, s.city AS s_city,
               s.customer_state AS s_customer_state, s.postcode AS s_postcode
          FROM scm.delivery_orders d
          LEFT JOIN scm.mfg_sales_orders s ON s.doc_no = d.so_doc_no AND s.company_id = d.company_id
         WHERE d.company_id = ${CO} AND d.id = ANY(${doIds})`
      : [];
    const planById = new Map(doPlan.map((p) => [String(p.id), p]));
    let doWrongValue = 0, doDisagreesWithParent = 0, doStillBlank = 0, doTypeWrong = 0;
    for (const r of doBack) {
      const p = planById.get(String(r.id));
      for (const [col, want] of Object.entries(p.set)) {
        const got = clean(r[col]);
        if (got !== want) { doWrongValue++; continue; }
        if (typeof r[col] !== "string") doTypeWrong++;
      }
      if (vacant(r.phone) && vacant(r.address1) && vacant(r.address2)) doStillBlank++;
      /* The block is the PARENT's, so a field THIS RUN wrote must now equal the
         sales order's own value, re-read on this connection. Scoped to the
         written fields on purpose: a field somebody had already filled by hand
         is allowed to differ from the order, and flagging that would turn a
         correct human edit into a failed verification. */
      const parentAddr2 = clean(r.s_address2) ?? clean([r.s_address3, r.s_address4].filter(Boolean).join(", "));
      const parentOf = {
        phone: r.s_phone, address1: r.s_address1, address2: parentAddr2, city: r.s_city,
        state: r.s_customer_state, customer_state: r.s_customer_state, postcode: r.s_postcode,
      };
      for (const col of Object.keys(p.set)) {
        const sv = parentOf[col];
        if (sv === undefined) continue;
        if (has(sv) && clean(r[col]) !== clean(sv)) doDisagreesWithParent++;
      }
    }

    const after = await control(verify);
    log("");
    log("=== VERIFICATION (fresh connection, values not counts) ===");
    log(`  sales-order rows re-read              ${soBack.length} of ${soPlan.length}`);
    log(`  city is not the value planned         ${soWrongValue}`);
    log(`  city the address master would refuse  ${soNotAMasterCity}`);
    log(`  delivery-order rows re-read           ${doBack.length} of ${doPlan.length}`);
    log(`  a field is not the value planned      ${doWrongValue}`);
    log(`  a written field is not text           ${doTypeWrong}`);
    log(`  disagrees with its parent sales order ${doDisagreesWithParent}`);
    log(`  still no phone and no address         ${doStillBlank}`);
    log("");
    log("=== CONTROL: before -> after (every row must be UNMOVED) ===");
    let moved = 0;
    for (const k of Object.keys(before)) {
      const b = String(before[k]), a = String(after[k]);
      if (b !== a) moved++;
      log(`  ${k.padEnd(16)} ${b.padStart(16)} -> ${a.padStart(16)}${b === a ? "" : "   <<< MOVED"}`);
    }
    log(`  control rows moved: ${moved}`);
    const bad = soWrongValue + soNotAMasterCity + doWrongValue + doTypeWrong + doDisagreesWithParent + moved;
    log("");
    log(bad === 0 ? "VERIFIED: 0 wrong shape, 0 control rows moved." : `FAILED: ${bad} problems above.`);
    if (bad !== 0) process.exitCode = 1;
  } finally {
    await verify.end();
  }
  await sql.end();
}

main().catch(async (e) => { console.error(e); try { await sql.end(); } catch { /* closing */ } process.exit(1); });
