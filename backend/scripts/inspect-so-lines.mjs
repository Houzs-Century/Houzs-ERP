// inspect-so-lines — READ-ONLY. For named sales orders: header status, and
// every pillow / sofa-accessory line's Description 2, colour field, delivery
// and purchase chain. RE-RUN: idempotent.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
const say = (m) => console.log(m);
const DOCS = String(process.env.DOCS || "").split(",").map((s) => s.trim()).filter(Boolean);
for (const doc of DOCS) {
  const [h] = await sql`SELECT doc_no, status::text AS st, processing_date::text AS proc, customer_delivery_date::text AS cdd, debtor_name FROM scm.mfg_sales_orders WHERE doc_no = ${doc}`;
  if (!h) { say(`\n##### ${doc}: not found`); continue; }
  say(`\n##### ${doc} · status ${h.st} · proceeded ${h.proc ?? "no"} · delivery ${h.cdd ?? "-"} · ${h.debtor_name}`);
  const lines = await sql`SELECT i.id::text AS id, i.line_no, i.item_code, i.item_group, i.qty, i.cancelled, i.stock_status::text AS stock, i.description2, i.line_delivery_date::text AS ldd, i.variants->>'fabricCode' AS fc
    FROM scm.mfg_sales_order_items i WHERE i.doc_no = ${doc} ORDER BY i.line_no NULLS LAST, i.created_at`;
  for (const l of lines) {
    say(`  ln${l.line_no} ${l.item_code} [${l.item_group}] qty ${l.qty}${l.cancelled ? " CANCELLED" : ""} · stock ${l.stock} · line date ${l.ldd ?? "-"} · colour field ${l.fc ?? "(blank)"}`);
    say(`     Description 2: ${JSON.stringify(l.description2 ?? "")}`);
    for (const p of await sql`SELECT p.po_number, p.status::text AS st, it.qty, it.received_qty FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id WHERE it.so_item_id::text = ${l.id}`)
      say(`     PO ${p.po_number} ${p.st} qty ${p.qty} received ${p.received_qty}`);
    for (const d of await sql`SELECT o.do_number, o.status::text AS st, o.delivered_at::text AS delivered, it.qty FROM scm.delivery_order_items it JOIN scm.delivery_orders o ON o.id = it.delivery_order_id WHERE it.so_item_id::text = ${l.id}`)
      say(`     DO ${d.do_number} ${d.st} qty ${d.qty} delivered_at ${d.delivered ?? "-"}`);
  }
}
say("\nREAD-ONLY — nothing was written.");
await sql.end();
