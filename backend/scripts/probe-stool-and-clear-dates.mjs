#!/usr/bin/env node
// ---------------------------------------------------------------------------
// probe-stool-and-clear-dates.mjs — READ-ONLY. What production actually holds
// for the owner's two rulings of 2026-09-09, before anything is written.
//
//   1. HC-DO-2609-011 / DSL-8051 SOFA — 「这个是stool」.
//      Where does that line live, what carries it, and is a STOOL piece SKU
//      minted for the model the BOOK's own item code states? The precedent
//      (HC-SO-011657) was REFUSED three times on prod for exactly that —
//      "piece SKU not minted: 9838-STOOL" — so the SKU question is asked here,
//      before a correction entry is written, not after.
//
//   2. HC-SO-013495 — 「这个remove掉processing date和delivery date」.
//      The FULL header row (every column, so the apply can be proven to have
//      changed exactly two of them), the line-level delivery mirror, whether a
//      delivery note or invoice hangs off it, and — the question the owner's
//      「库存先不看」 makes load-bearing — WHAT TRIGGERS FIRE on the tables this
//      would touch, read out of pg_trigger with the function source, not
//      assumed from the tree.
//
// This script only reads. No mode gate, no confirm phrase: there is nothing to
// gate. RE-RUN: freely, as often as you like — it holds no state and changes
// nothing, so two runs on the same minute answer the same thing.
//
//   DATABASE_URL=... node backend/scripts/probe-stool-and-clear-dates.mjs
// ---------------------------------------------------------------------------
import postgres from "postgres";

import { HEADER_CHANGED_COLUMNS, stableDigest, planClear } from "./lib/so-date-clear-plan.mjs";

const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("need DATABASE_URL"); process.exit(2); }
const CO = Number(process.env.COMPANY || 1);
const SO_DOC = (process.env.SO_DOC || "HC-SO-013495").trim();
const DO_DOC = (process.env.DO_DOC || "HC-DO-2609-011").trim();

const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1 });
const log = (m) => console.log(m);
const h1 = (m) => log(`\n${"=".repeat(78)}\n${m}\n${"=".repeat(78)}`);
const h2 = (m) => log(`\n--- ${m} ---`);
/* Dates arrive as JS Date objects through postgres.js and as strings through
   PostgREST; print the day, never the object, so two runs are comparable. */
const show = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
/* ONE SECTION'S 42703 MUST NOT BLIND THE WHOLE RUN. Run 34315527361 named
   `i.line_total_sen` on scm.mfg_sales_order_items — a column that lives on the
   purchase-order and delivery-order line tables but not that one — and the
   uncaught throw took every later section with it, including the trigger read
   the whole write is gated on. A probe that answers eight of nine questions is
   worth eight; a probe that answers none because of a typo in the third is
   worth nothing, and each round trip costs a merge to the default branch.
   Hence: catch, print, carry on. And every row dump below is `SELECT *`, so
   this class of mistake cannot recur — the columns come from the table. */
const section = async (title, fn) => {
  h2(title);
  try { await fn(); } catch (e) {
    log(`  !! FAILED: ${e.code ? `[${e.code}] ` : ""}${e.message}`);
  }
};
/** Every column of every row, sorted, one per line. */
const dumpRows = (rows, indent = "  ") => {
  log(`${indent}${rows.length} row(s)`);
  for (const r of rows) {
    log(`${indent}·`);
    for (const k of Object.keys(r).sort()) log(`${indent}    ${k.padEnd(32)} ${show(r[k])}`);
  }
};

try {
  // ═══════════════════════════════════════════════════════════════════════
  h1(`PART 1 — the stool: ${DO_DOC}`);

  const doHdr = await sql`SELECT * FROM scm.delivery_orders
                           WHERE do_number = ${DO_DOC} AND company_id = ${CO}`;
  if (!doHdr.length) {
    log(`NOT FOUND in scm.delivery_orders for company ${CO}.`);
    /* Do not stop: the number may exist under another company, and knowing
       that is the difference between "wrong company" and "not imported". */
    const any = await sql`SELECT company_id, id, status FROM scm.delivery_orders
                           WHERE do_number = ${DO_DOC}`;
    log(`  same number under any company: ${JSON.stringify(any)}`);
  } else {
    const r = doHdr[0];
    h2("delivery order header (every column)");
    for (const k of Object.keys(r).sort()) log(`  ${k.padEnd(34)} ${show(r[k])}`);

    h2("delivery order lines");
    const doLines = await sql`SELECT * FROM scm.delivery_order_items
                               WHERE delivery_order_id = ${r.id}
                               ORDER BY line_no NULLS LAST, id`;
    log(`  ${doLines.length} line(s)`);
    for (const l of doLines) {
      log(`  · id=${l.id}`);
      for (const k of Object.keys(l).sort()) log(`      ${k.padEnd(32)} ${show(l[k])}`);
    }

    /* THE QUESTION THAT DECIDES WHERE THE RULING GOES. The compartment
       applier addresses HC-PO-… and HC-SO-… only (isPo = /^HC-PO-/, else the
       sales-order table): it has no delivery-order arm at all. So if this DO
       line hangs off a sales-order line, the ruling belongs on the PARENT and
       the DO follows it; if it hangs off nothing, this lane cannot write it
       with the machinery that exists. */
    const soIds = doLines.map((l) => l.so_item_id).filter(Boolean);
    await section("the parent sales-order line each DO line points at (so_item_id)", async () => {
      if (!soIds.length) { log("  NONE — no DO line carries so_item_id."); return; }
      const parents = await sql`SELECT * FROM scm.mfg_sales_order_items WHERE id = ANY(${soIds})`;
      dumpRows(parents);
      const parentDocs = [...new Set(parents.map((p) => p.doc_no))];
      for (const d of parentDocs) {
        await section(`parent sales-order header ${d}`, async () => {
          const hh = await sql`SELECT * FROM scm.mfg_sales_orders WHERE doc_no = ${d}`;
          dumpRows(hh, "    ");
        });
        await section(`every line on ${d} (so the build can be seen whole)`, async () => {
          const sib = await sql`SELECT * FROM scm.mfg_sales_order_items WHERE doc_no = ${d}`;
          dumpRows(sib, "    ");
        });
      }
    });

    await section("did real stock move under this delivery note?", async () => {
      const mv = await sql`SELECT count(*)::int n FROM scm.inventory_movements
                            WHERE company_id = ${CO} AND source_doc_no = ${DO_DOC}`;
      log(`  inventory_movements naming ${DO_DOC}: ${mv[0].n}`);
      log(`  migrated_no_stock on the header: ${show(r.migrated_no_stock)}`);
      log(`  status on the header:            ${show(r.status)}`);
    });
  }

  /* Is a STOOL piece minted for the model the BOOK states? The brief's ruling
     gives no model, so the book's own item code DSL-8051 is what governs, and
     the applier builds the target SKU as `<model>-STOOL`. Ask widely rather
     than for one guessed string — a nil answer to one spelling proves nothing
     about the catalogue. */
  await section("STOOL piece SKUs in the catalogue", async () => {
    const stools = await sql`SELECT * FROM scm.products
                              WHERE item_code ILIKE '%STOOL%' LIMIT 40`;
    dumpRows(stools);
  });

  await section("anything in the catalogue for model 8051 / DSL-8051", async () => {
    const m8051 = await sql`SELECT * FROM scm.products
                             WHERE item_code ILIKE '%8051%' LIMIT 40`;
    dumpRows(m8051);
  });

  /* Every other ERP row that carries this piece code, so "is 8051-STOOL a real
     product or a code somebody typed onto one line" is answered by counting,
     not by inference. */
  await section("who else carries the code 8051-STOOL", async () => {
    const so = await sql`SELECT doc_no, id, qty FROM scm.mfg_sales_order_items
                          WHERE item_code = '8051-STOOL' LIMIT 30`;
    log(`  sales-order lines:   ${so.length} ${JSON.stringify(so)}`);
    const po = await sql`SELECT id, qty FROM scm.purchase_order_items
                          WHERE item_code = '8051-STOOL' LIMIT 30`;
    log(`  purchase-order lines:${po.length}`);
    const di = await sql`SELECT id, qty FROM scm.delivery_order_items
                          WHERE item_code = '8051-STOOL' LIMIT 30`;
    log(`  delivery-note lines: ${di.length}`);
  });

  // ═══════════════════════════════════════════════════════════════════════
  h1(`PART 2 — the two dates: ${SO_DOC}`);

  const soHdr = await sql`SELECT * FROM scm.mfg_sales_orders
                           WHERE doc_no = ${SO_DOC} AND company_id = ${CO}`;
  if (!soHdr.length) {
    log(`NOT FOUND in scm.mfg_sales_orders for company ${CO}.`);
  } else {
    const r = soHdr[0];
    h2("FULL header row — every column, so 'the rest is unchanged' can be PROVEN");
    for (const k of Object.keys(r).sort()) log(`  ${k.padEnd(34)} ${show(r[k])}`);

    h2("the three date facts that matter");
    log(`  processing_date          ${show(r.processing_date)}`);
    log(`  customer_delivery_date   ${show(r.customer_delivery_date)}`);
    log(`  amended_delivery_date    ${show(r.amended_delivery_date)}`);
    log(`  status                   ${show(r.status)}`);
    log(`  version                  ${show(r.version)}`);
    log(`  PROCEEDED (processing_date IS NOT NULL) = ${r.processing_date !== null}`);

    let lineIds = [];
    await section("lines — the delivery mirror and the colour (every column)", async () => {
      const lines = await sql`SELECT * FROM scm.mfg_sales_order_items WHERE doc_no = ${SO_DOC}`;
      lineIds = lines.map((l) => l.id);
      dumpRows(lines);
    });

    /* statusAfterProcessingDateCleared refuses to demote an order that has
       already shipped or been invoiced — `hasDownstream`. Measure it, do not
       assume it. */
    await section("downstream — is anything raised off this order?", async () => {
      const dos = lineIds.length
        ? await sql`SELECT DISTINCT d.do_number, d.status, d.migrated_no_stock
                      FROM scm.delivery_order_items di
                      JOIN scm.delivery_orders d ON d.id = di.delivery_order_id
                     WHERE di.so_item_id = ANY(${lineIds})`
        : [];
      log(`  delivery orders: ${dos.length} ${JSON.stringify(dos)}`);
      const pos = lineIds.length
        ? await sql`SELECT DISTINCT p.po_number, p.status
                      FROM scm.purchase_order_items pi
                      JOIN scm.purchase_orders p ON p.id = pi.purchase_order_id
                     WHERE pi.so_item_id = ANY(${lineIds})`
        : [];
      log(`  purchase orders dedicated to its lines: ${pos.length} ${JSON.stringify(pos)}`);
      const inv = await sql`SELECT invoice_number, status FROM scm.sales_invoices
                             WHERE company_id = ${CO} AND so_doc_no = ${SO_DOC}`;
      log(`  sales invoices: ${inv.length} ${JSON.stringify(inv)}`);
      const mv2 = await sql`SELECT count(*)::int n FROM scm.inventory_movements
                             WHERE company_id = ${CO} AND source_doc_no = ${SO_DOC}`;
      log(`  inventory_movements naming ${SO_DOC}: ${mv2[0].n}`);
      const pay = await sql`SELECT count(*)::int n FROM scm.mfg_sales_order_payments
                             WHERE doc_no = ${SO_DOC}`;
      log(`  payment rows: ${pay[0].n}`);
    });

    /* The amendment door and the audit log both key off this order; if a live
       amendment is pending, clearing the dates underneath it is a different
       conversation. Count, do not assume. */
    await section("is an amendment pending on this order?", async () => {
      const am = await sql`SELECT id, status, created_at FROM scm.so_amendments
                            WHERE doc_no = ${SO_DOC}`;
      log(`  amendments: ${am.length} ${JSON.stringify(am)}`);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  h1("PART 3 — pg_trigger: what actually fires on the tables a clear would touch");
  /* The owner's 「库存先不看」 makes this the gate on the whole write: if
     clearing a date can move an on-hand figure, this lane stops. Read the
     catalogue, and read the FUNCTION BODY too — a trigger's name is not its
     behaviour. */
  const tables = [
    "scm.mfg_sales_orders",
    "scm.mfg_sales_order_items",
  ];
  for (const t of tables) {
    await section(`triggers on ${t}`, async () => {
    const trg = await sql`
      SELECT tg.tgname,
             tg.tgenabled,
             tg.tgtype,
             p.proname,
             n.nspname AS fn_schema,
             pg_get_triggerdef(tg.oid) AS def
        FROM pg_trigger tg
        JOIN pg_class c ON c.oid = tg.tgrelid
        JOIN pg_namespace cn ON cn.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = tg.tgfoid
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE NOT tg.tgisinternal
         AND cn.nspname || '.' || c.relname = ${t}
       ORDER BY tg.tgname`;
    if (!trg.length) { log("  (none)"); return; }
    for (const g of trg) {
      log(`  · ${g.tgname}  enabled=${g.tgenabled}  fn=${g.fn_schema}.${g.proname}`);
      log(`      ${g.def}`);
      const src = await sql`SELECT prosrc FROM pg_proc p
                              JOIN pg_namespace n ON n.oid = p.pronamespace
                             WHERE p.proname = ${g.proname} AND n.nspname = ${g.fn_schema}`;
      const body = String(src[0]?.prosrc ?? "");
      log(`      --- function body (${body.length} chars) ---`);
      for (const ln of body.split("\n")) log(`      | ${ln}`);
    }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  h1("PART 4 — the digest the apply will be gated on");
  /* clear-so-dates.mjs refuses at MODE=apply unless the live row still hashes
     to the digest committed in data/clear-so-dates-plan.json — so the row that
     gets written is the row somebody reviewed. That digest has to be OBSERVED
     before it can be committed, and the clear-so-dates workflow is not on the
     default branch yet, so it is computed here instead: same library, same
     function, read-only. Paste it into the plan file's `headerDigest`. */
  await section(`stableDigest for ${SO_DOC}`, async () => {
    const h = (await sql`SELECT * FROM scm.mfg_sales_orders
                          WHERE doc_no = ${SO_DOC} AND company_id = ${CO}`)[0] ?? null;
    const l = await sql`SELECT * FROM scm.mfg_sales_order_items
                         WHERE doc_no = ${SO_DOC} AND company_id = ${CO}`;
    const p = planClear({ docNo: SO_DOC, companyId: CO, header: h, lines: l });
    log(`  refusal        ${p.refusal ?? "(none)"}`);
    log(`  alreadyClear   ${p.alreadyClear}`);
    log(`  headerSets     ${JSON.stringify(p.headerSets)}`);
    log(`  skipped cols   ${HEADER_CHANGED_COLUMNS.join(", ")}`);
    log(`  headerDigest   ${p.digest}`);
    log(`  (cross-check)  ${stableDigest(h, HEADER_CHANGED_COLUMNS)}`);
  });

  h1("DONE — nothing was written.");
} finally {
  await sql.end({ timeout: 5 });
}
