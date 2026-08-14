#!/usr/bin/env node
// Every document carried over from AutoCount must carry AutoCount's number.
//
// Owner 2026-08-10, twice: "我们从 AutoCount 搬进来的东西全部 numbering 都跟着
// AutoCount 的不是吗？" and then "要确保你从 autocount 拉进来的东西全部 numbering
// 都是要跟着那边的."
//
// It is not enough to have fixed the importers once. A number that drifts is
// invisible until someone stands at a desk holding an AutoCount document whose
// number finds nothing in the ERP. This makes the rule checkable in one run, so
// the next import cannot quietly break it.
//
// Read-only. Exit 0 for every legitimate answer - the verdict is the output.
import postgres from "postgres";

const DST = process.env.DATABASE_URL;
if (!DST) { console.error("need DATABASE_URL"); process.exit(2); }
const log = (m) => console.log(process.env.GITHUB_ACTIONS ? `::notice::${m}` : m);
const sql = postgres(DST, { ssl: "require", prepare: false, max: 1 });
const CO = 1;

async function main() {
  let bad = 0;

  const so = await sql`SELECT doc_no, linked_ac_docno FROM scm.mfg_sales_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL AND doc_no <> 'HC-' || linked_ac_docno`;
  const [{ n: soTotal }] = await sql`SELECT COUNT(*)::int n FROM scm.mfg_sales_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  log(`SALES ORDERS: ${soTotal} migrated; not carrying their AutoCount number: ${so.length}`);
  for (const r of so.slice(0, 10)) log(`   ${r.doc_no} should be HC-${r.linked_ac_docno}`);
  bad += so.length;

  const po = await sql`SELECT po_number, linked_ac_docno FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL AND po_number <> 'HC-' || linked_ac_docno`;
  const [{ n: poTotal }] = await sql`SELECT COUNT(*)::int n FROM scm.purchase_orders
    WHERE company_id = ${CO} AND linked_ac_docno IS NOT NULL`;
  log(`PURCHASE ORDERS: ${poTotal} migrated; not carrying their AutoCount number: ${po.length}`);
  for (const r of po.slice(0, 10)) log(`   ${r.po_number} should be HC-${r.linked_ac_docno}`);
  bad += po.length;

  const dos = await sql`SELECT do_number, linked_ac_docno FROM scm.delivery_orders
    WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL
      AND do_number <> 'HC-' || linked_ac_docno`;
  const [{ n: doTotal }] = await sql`SELECT COUNT(*)::int n FROM scm.delivery_orders
    WHERE company_id = ${CO} AND migrated_no_stock = true`;
  log(`DELIVERY ORDERS: ${doTotal} migrated; not carrying their AutoCount number: ${dos.length}`);
  for (const r of dos.slice(0, 10)) log(`   ${r.do_number} should be HC-${r.linked_ac_docno}`);
  bad += dos.length;

  /* A GRN belongs to ONE purchase order while an AutoCount receipt can span
     several, so its number is "HC-<AC GR>" when that receipt covers a single
     imported PO and "HC-<AC GR>-<AC PO>" when it covers more. Both start from
     the AutoCount document; anything that does not is the failure. */
  const grn = await sql`SELECT g.grn_number, p.linked_ac_docno AS ac_po, p.linked_ac_grn_docnos AS ac_grs
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${CO} AND g.migrated_no_stock = true`;
  const noRef = grn.filter((g) => !(g.ac_grs ?? []).length);
  const wrong = grn.filter((g) => (g.ac_grs ?? []).length && !(g.ac_grs ?? []).some((gr) => g.grn_number === "HC-" + gr || g.grn_number === "HC-" + gr + "-" + g.ac_po));
  log(`GOODS RECEIPTS: ${grn.length} migrated; not carrying their AutoCount number: ${wrong.length}; with NO AutoCount receipt number recorded: ${noRef.length}`);
  for (const r of wrong.slice(0, 10)) log(`   ${r.grn_number} should start from HC-${(r.ac_grs ?? [])[0]}`);
  for (const r of noRef.slice(0, 5)) log(`   no AutoCount receipt recorded for the PO behind ${r.grn_number} — re-run the GR reference stamp before renumbering`);
  bad += wrong.length;

  /* Invoices (migration 0294). Written only by create-migrated-invoices.mjs,
     one per AutoCount invoice, numbered HC-<AutoCount's number> — the same rule
     as the four document types above, and the same failure if it drifts: a
     human holding AutoCount's PI-000658 finds nothing in the ERP.

     Checked with a column guard rather than assumed, so this script still runs
     against an environment where 0280 has not been applied. Reporting "0
     migrated invoices" when the column is missing would be a lie of omission —
     it reads as "checked and clean". */
  for (const [table, col, label] of [
    ["purchase_invoices", "invoice_number", "PURCHASE INVOICES"],
    ["sales_invoices", "invoice_number", "SALES INVOICES"],
  ]) {
    const [{ present }] = await sql`
      SELECT COUNT(*)::int AS present FROM information_schema.columns
      WHERE table_schema = 'scm' AND table_name = ${table} AND column_name = 'migrated_no_stock'`;
    if (!present) {
      log(`${label}: scm.${table}.migrated_no_stock does not exist — migration 0294 not applied, nothing to check yet`);
      continue;
    }
    const rows = await sql.unsafe(
      `SELECT ${col} AS doc_no, linked_ac_docno FROM scm.${table}
       WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NOT NULL
         AND ${col} <> 'HC-' || linked_ac_docno`);
    const [{ n: total }] = await sql.unsafe(
      `SELECT COUNT(*)::int n FROM scm.${table} WHERE company_id = ${CO} AND migrated_no_stock = true`);
    const noRef = await sql.unsafe(
      `SELECT ${col} AS doc_no FROM scm.${table}
       WHERE company_id = ${CO} AND migrated_no_stock = true AND linked_ac_docno IS NULL`);
    log(`${label}: ${total} migrated; not carrying their AutoCount number: ${rows.length}`
      + `; with NO AutoCount invoice number recorded: ${noRef.length}`);
    for (const r of rows.slice(0, 10)) log(`   ${r.doc_no} should be HC-${r.linked_ac_docno}`);
    for (const r of noRef.slice(0, 5)) log(`   ${r.doc_no} is flagged migrated but names no AutoCount invoice`);
    bad += rows.length + noRef.length;
  }

  log("");
  log(bad === 0
    ? "VERDICT: every migrated document carries the AutoCount number it came from."
    : `VERDICT: ${bad} document(s) do NOT carry their AutoCount number — run renumber-migrated-docs.`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
