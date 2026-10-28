#!/usr/bin/env node
/* probe-doc-alignment — what the ERP actually holds for the SEVEN documents the
 * alignment lane is closing, and whether any of them has moved stock.
 *
 * WHY IT EXISTS. Every one of those seven was measured on an earlier run and
 * the numbers were then carried forward in prose. Prose decays: the owner's own
 * standing rule is 「库存先不看」 — do not move an on-hand figure — and a lane
 * that writes a line onto a document which has since acquired a stock movement
 * would be moving one. Lanes have been writing this database all night, so the
 * zero-movement fact is RE-MEASURED here, immediately before any write, rather
 * than quoted.
 *
 * It also prints the ERP rows themselves beside the book's, because two
 * separate repairs in this batch turn on WHICH of our rows answers which of the
 * book's lines, and a summary cannot settle that.
 *
 * READ-ONLY, and enforced as such: one REPEATABLE READ **READ ONLY** snapshot,
 * so the server itself refuses a write and every figure below describes the
 * same instant. (The snapshot is also the fix in this same branch — a report
 * assembled from seven separate snapshots is how the tally came to refuse.)
 *
 * BOUNDED. It names seven documents. Nothing here scans a table.
 *
 * RE-RUN: read-only and idempotent; run it as often as you like. It is
 * expected to be run IMMEDIATELY BEFORE an apply, and its stock-movement
 * figures quoted in that apply's PR.
 */
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("REFUSED: DATABASE_URL not set.");
  process.exit(2);
}
const CO = Number(process.env.COMPANY_ID || 1);

/* The seven, by ERP document number. HC-DO-011470 and HC-SO-2609-002 are
   DELIBERATELY ABSENT: the first is the sofa lane's and the second was ruled
   left alone. */
const DOCS = {
  do: ["HC-DO-010104", "HC-DO-011371", "HC-DO-011465", "HC-DO-010332"],
  iv: ["HC-I-2605-0294", "HC-I-2606-0047", "HC-I-2506-0056"],
};

const sql = postgres(url, { ssl: "require", prepare: false, max: 1, connect_timeout: 30 });
const out = (m) => console.log(m);

/* A column list is read from information_schema and never assumed: naming a
   column that does not exist kills the whole statement, and this probe's job is
   to answer rather than to die. */
async function colsOf(tx, table) {
  const rows = await tx.unsafe(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = '${table}' ORDER BY ordinal_position`,
  );
  return rows.map((r) => r.column_name);
}

const lit = (xs) => xs.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");

try {
  await sql.begin("read only isolation level repeatable read", async (tx) => {
    const [{ now }] = await tx.unsafe("SELECT now() AS now");
    out(`═══ ERP rows for the seven, company ${CO} — one snapshot at ${new Date(now).toISOString()} ═══`);

    const doiCols = await colsOf(tx, "delivery_order_items");
    const iviCols = await colsOf(tx, "sales_invoice_items");
    out(`delivery_order_items columns: ${doiCols.join(", ")}`);
    out(`sales_invoice_items columns: ${iviCols.join(", ")}`);
    out("");

    /* ── DELIVERY ORDERS ─────────────────────────────────────────────────── */
    out("─── DELIVERY ORDERS ───");
    const dos = await tx.unsafe(
      /* row_to_json rather than a column list: naming a column that does not
         exist kills the statement, and the shape of these tables is part of
         what is being asked. */
      `SELECT row_to_json(h) AS r FROM scm.delivery_orders h
        WHERE h.company_id = ${CO} AND h.do_number IN (${lit(DOCS.do)})
        ORDER BY h.do_number`,
    );
    for (const { r: d } of dos) {
      out(`\n  ${d.do_number}  ac=${d.linked_ac_docno ?? "-"}  so=${d.so_doc_no ?? "-"}  status=${d.status ?? "-"}`);
      const items = await tx.unsafe(
        `SELECT row_to_json(i) AS r FROM scm.delivery_order_items i
          WHERE i.delivery_order_id = '${d.id}'
          ORDER BY COALESCE(i.line_no, 0), i.id`,
      );
      out(`     ${items.length} line(s):`);
      for (const { r } of items) {
        out(`       line_no=${r.line_no} item=${r.item_code} qty=${r.qty} unit_price_sen=${r.unit_price_sen}`);
        out(`         description : ${JSON.stringify(r.description ?? null)}`);
        if ("description2" in r) out(`         description2: ${JSON.stringify(r.description2 ?? null)}`);
        if ("linked_ac_dtlkey" in r) out(`         ac_dtlkey   : ${JSON.stringify(r.linked_ac_dtlkey ?? null)}`);
        if ("variants" in r) out(`         variants    : ${JSON.stringify(r.variants ?? null)}`);
        if ("custom_specials" in r) out(`         custom_spec : ${JSON.stringify(r.custom_specials ?? null)} (DERIVED — never write here)`);
      }

      /* 「库存先不看」 — the figure that decides whether a write is allowed. */
      const [{ n }] = await tx.unsafe(
        `SELECT COUNT(*)::int AS n FROM scm.inventory_movements m
          WHERE m.source_doc_type = 'DO' AND m.source_doc_id::text = '${d.id}'`,
      );
      out(`     STOCK MOVEMENTS: ${n}${n === 0 ? "  (safe to write — nothing on hand moves)" : "  ← STOP. A write here moves an on-hand figure."}`);
    }
    const missingDo = DOCS.do.filter((n) => !dos.some((x) => x.r.do_number === n));
    if (missingDo.length) out(`\n  NOT FOUND in the ERP: ${missingDo.join(", ")}`);

    /* ── SALES INVOICES ──────────────────────────────────────────────────── */
    out("");
    out("─── SALES INVOICES ───");
    const ivs = await tx.unsafe(
      `SELECT row_to_json(h) AS r FROM scm.sales_invoices h
        WHERE h.company_id = ${CO} AND h.invoice_number IN (${lit(DOCS.iv)})
        ORDER BY h.invoice_number`,
    );
    for (const { r: v } of ivs) {
      out(`\n  ${v.invoice_number}  ac=${v.linked_ac_docno ?? "-"}`);
      const items = await tx.unsafe(
        `SELECT row_to_json(i) AS r FROM scm.sales_invoice_items i
          WHERE i.sales_invoice_id = '${v.id}'
          ORDER BY COALESCE(i.line_no, 0), i.id`,
      );
      out(`     ${items.length} line(s):`);
      for (const { r } of items) {
        out(`       line_no=${r.line_no} item=${r.item_code} qty=${r.qty} unit_price_sen=${r.unit_price_sen}`);
        out(`         description : ${JSON.stringify(r.description ?? null)}`);
        if ("description2" in r) out(`         description2: ${JSON.stringify(r.description2 ?? null)}`);
        if ("linked_ac_dtlkey" in r) out(`         ac_dtlkey   : ${JSON.stringify(r.linked_ac_dtlkey ?? null)}`);
        if ("do_item_id" in r) out(`         do_item_id  : ${JSON.stringify(r.do_item_id ?? null)}`);
        if ("variants" in r) out(`         variants    : ${JSON.stringify(r.variants ?? null)}`);
        if ("custom_specials" in r) out(`         custom_spec : ${JSON.stringify(r.custom_specials ?? null)} (DERIVED — never write here)`);
      }
    }
    const missingIv = DOCS.iv.filter((n) => !ivs.some((x) => x.r.invoice_number === n));
    if (missingIv.length) out(`\n  NOT FOUND in the ERP: ${missingIv.join(", ")}`);

    /* ── the trigger census 「库存先不看」 asks for ────────────────────────── */
    out("");
    out("─── TRIGGERS on the two line tables (a write can move stock without saying so) ───");
    const trg = await tx.unsafe(
      `SELECT c.relname AS tbl, t.tgname, p.proname AS fn, t.tgenabled
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND n.nspname = 'scm'
          AND c.relname IN ('delivery_order_items', 'sales_invoice_items',
                            'delivery_orders', 'sales_invoices')
        ORDER BY c.relname, t.tgname`,
    );
    if (!trg.length) out("   none — a line write on these tables fires nothing.");
    for (const t of trg) out(`   ${t.tbl}.${t.tgname} -> ${t.fn} (enabled=${t.tgenabled})`);
  });
} finally {
  await sql.end({ timeout: 5 });
}
