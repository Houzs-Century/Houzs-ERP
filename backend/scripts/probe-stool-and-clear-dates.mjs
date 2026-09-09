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
    h2("the parent sales-order line each DO line points at (so_item_id)");
    const soIds = doLines.map((l) => l.so_item_id).filter(Boolean);
    if (!soIds.length) log("  NONE — no DO line carries so_item_id.");
    else {
      const parents = await sql`SELECT i.id, i.doc_no, i.line_no, i.item_code, i.description,
                                       i.description2, i.linked_ac_dtlkey, i.qty, i.cancelled,
                                       i.unit_price_sen, i.line_total_sen, i.item_group
                                  FROM scm.mfg_sales_order_items i
                                 WHERE i.id = ANY(${soIds})`;
      for (const p of parents) {
        log(`  · SO line id=${p.id}`);
        for (const k of Object.keys(p).sort()) log(`      ${k.padEnd(32)} ${show(p[k])}`);
      }
      const parentDocs = [...new Set(parents.map((p) => p.doc_no))];
      h2("parent sales-order header(s)");
      for (const d of parentDocs) {
        const hh = await sql`SELECT doc_no, status, processing_date, customer_delivery_date,
                                    amended_delivery_date, company_id
                               FROM scm.mfg_sales_orders WHERE doc_no = ${d}`;
        log(`  ${d}: ${JSON.stringify(hh[0] ?? null)}`);
        h2(`  every sofa-ish line on ${d} (so the build can be seen whole)`);
        const sib = await sql`SELECT id, line_no, item_code, description2, qty, cancelled,
                                     linked_ac_dtlkey, item_group, unit_price_sen, line_total_sen
                                FROM scm.mfg_sales_order_items
                               WHERE doc_no = ${d} ORDER BY line_no NULLS LAST, id`;
        for (const s of sib) log(`    ${JSON.stringify(s)}`);
      }
    }

    h2("did real stock move under this delivery note?");
    const mv = await sql`SELECT count(*)::int n FROM scm.inventory_movements
                          WHERE company_id = ${CO} AND source_doc_no = ${DO_DOC}`;
    log(`  inventory_movements naming ${DO_DOC}: ${mv[0].n}`);
    log(`  migrated_no_stock on the header: ${show(r.migrated_no_stock)}`);
  }

  /* Is a STOOL piece minted for the model the BOOK states? The brief's ruling
     gives no model, so the book's own item code DSL-8051 is what governs, and
     the applier builds the target SKU as `<model>-STOOL`. Ask widely rather
     than for one guessed string — a nil answer to one spelling proves nothing
     about the catalogue. */
  h2("STOOL piece SKUs in the catalogue (company + shared)");
  const stools = await sql`SELECT company_id, item_code, name, item_group, is_active
                             FROM scm.products
                            WHERE item_code ILIKE '%STOOL%'
                            ORDER BY company_id, item_code LIMIT 60`;
  log(`  ${stools.length} row(s) whose code contains STOOL`);
  for (const s of stools) log(`    ${JSON.stringify(s)}`);

  h2("anything in the catalogue for model 8051 / DSL-8051");
  const m8051 = await sql`SELECT company_id, item_code, name, item_group, is_active
                            FROM scm.products
                           WHERE item_code ILIKE '%8051%'
                           ORDER BY company_id, item_code LIMIT 60`;
  log(`  ${m8051.length} row(s)`);
  for (const s of m8051) log(`    ${JSON.stringify(s)}`);

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

    h2("lines — the delivery mirror and the colour");
    const lines = await sql`SELECT id, line_no, item_code, description, description2,
                                   qty, cancelled, line_delivery_date,
                                   line_delivery_date_overridden, variants, linked_ac_dtlkey
                              FROM scm.mfg_sales_order_items
                             WHERE doc_no = ${SO_DOC}
                             ORDER BY line_no NULLS LAST, id`;
    log(`  ${lines.length} line(s)`);
    for (const l of lines) {
      log(`  · id=${l.id} line_no=${show(l.line_no)} code=${show(l.item_code)} cancelled=${show(l.cancelled)}`);
      log(`      description2                  ${show(l.description2)}`);
      log(`      line_delivery_date            ${show(l.line_delivery_date)}`);
      log(`      line_delivery_date_overridden ${show(l.line_delivery_date_overridden)}`);
      log(`      variants                      ${show(l.variants)}`);
      log(`      linked_ac_dtlkey              ${show(l.linked_ac_dtlkey)}`);
    }

    /* statusAfterProcessingDateCleared refuses to demote an order that has
       already shipped or been invoiced — `hasDownstream`. Measure it, do not
       assume it. */
    h2("downstream — is anything raised off this order?");
    const lineIds = lines.map((l) => l.id);
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
    const mv2 = await sql`SELECT count(*)::int n FROM scm.inventory_movements
                           WHERE company_id = ${CO} AND source_doc_no = ${SO_DOC}`;
    log(`  inventory_movements naming ${SO_DOC}: ${mv2[0].n}`);
    const pay = await sql`SELECT count(*)::int n FROM scm.mfg_sales_order_payments
                           WHERE doc_no = ${SO_DOC}`;
    log(`  payment rows: ${pay[0].n}`);
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
    h2(`triggers on ${t}`);
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
    if (!trg.length) { log("  (none)"); continue; }
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
  }

  h1("DONE — nothing was written.");
} finally {
  await sql.end({ timeout: 5 });
}
