// probe-colour-codes — READ-ONLY. Where do the colour codes named on the
// unresolved pillow lines live, if anywhere? Searches scm.fabric_colours and
// scm.fabric_trackings (company 1) by a loose pattern per code, and prints the
// colour-related fields of the ten sales-order lines. RE-RUN: idempotent.
import postgres from "postgres";
const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
const say = (m) => console.log(m);
const PATS = { "GD526-16": ["GD526", "526"], "CH151-5": ["CH151", "151"], "KN390-11": ["KN390", "390"], "MEKA-09": ["MEKA"], "M2401-1": ["M2401", "2401"],
  "M2402-9": ["M2402-9", "M2402-09"], "M2402-15": ["M2402-15"], "BO315-27": ["BO315-27"], "BO315-28": ["BO315-28"], "CH141-5": ["CH141-5", "CH141-05"], "CH141-1": ["CH141-1", "CH141-01"] };
for (const [code, pats] of Object.entries(PATS)) {
  say(`\n=== ${code} ===`);
  for (const p of pats) {
    const like = `%${p.replace(/-/g, "%")}%`;
    for (const r of await sql`SELECT fabric_id, colour_id, label, active, company_id FROM scm.fabric_colours WHERE colour_id ILIKE ${like} OR label ILIKE ${like} OR fabric_id ILIKE ${like} LIMIT 10`)
      say(`  colours  co${r.company_id} fabric=${r.fabric_id} colour=${r.colour_id} label=${r.label} active=${r.active}`);
    for (const r of await sql`SELECT fabric_code, fabric_description, supplier_code, is_active, company_id FROM scm.fabric_trackings WHERE fabric_code ILIKE ${like} OR supplier_code ILIKE ${like} OR fabric_description ILIKE ${like} LIMIT 10`)
      say(`  tracking co${r.company_id} code=${r.fabric_code} sup=${r.supplier_code} desc=${r.fabric_description} active=${r.is_active}`);
  }
}
say("\n=== the ten SO lines now ===");
for (const r of await sql`SELECT doc_no, line_no, item_code, variants->>'fabricCode' AS fc, variants->>'extraAddonNote' AS note, description2, left(remark, 60) AS remark
  FROM scm.mfg_sales_order_items WHERE company_id = 1 AND doc_no = ANY(${["HC-SO-2609-071","HC-SO-010214","HC-SO-012048","HC-SO-012686","HC-SO-012900","HC-SO-012046","HC-SO-012927","HC-SO-011561"]})
  AND upper(item_code) IN ('SQUARE PILLOW','LONG PILLOW','AR01','AR02','BC04','BC04-MF','BC05','BC05-MF','SB02') ORDER BY doc_no, line_no`)
  say(`  ${r.doc_no} ln${r.line_no} ${r.item_code} fabricCode=${r.fc ?? "-"} note="${r.note ?? ""}" d2="${(r.description2 ?? "").slice(0, 70)}" remark="${r.remark ?? ""}"`);
say("\n=== the two-colour lines and typo lines across the chain ===");
for (const r of await sql`SELECT i.doc_no, i.line_no, i.item_code, i.qty, i.cancelled, i.stock_status::text AS st, i.id::text AS id, i.unit_price_sen, i.linked_ac_dtlkey, h.status::text AS so_status, h.processing_date::text AS proc
  FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
  WHERE i.company_id = 1 AND i.doc_no = ANY(${["HC-SO-012046","HC-SO-012927","HC-SO-011561","HC-SO-010214","HC-SO-012900"]}) AND upper(i.item_code) IN ('SQUARE PILLOW','LONG PILLOW')`) {
  say(`  SO ${r.doc_no} ln${r.line_no} ${r.item_code} qty ${r.qty} price ${r.unit_price_sen} cancelled=${r.cancelled} stock=${r.st} so=${r.so_status} proc=${r.proc} key=${r.linked_ac_dtlkey ?? "-"}`);
  for (const p of await sql`SELECT p.po_number, p.status::text AS st, it.id::text AS id, it.qty, it.received_qty, it.linked_ac_dtlkey FROM scm.purchase_order_items it JOIN scm.purchase_orders p ON p.id = it.purchase_order_id WHERE it.so_item_id::text = ${r.id}`) {
    say(`     PO ${p.po_number} ${p.st} qty ${p.qty} recv ${p.received_qty} key ${p.linked_ac_dtlkey ?? "-"}`);
    for (const g of await sql`SELECT g.grn_number, g.status::text AS st, gi.id::text AS id, gi.qty_accepted FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id WHERE gi.purchase_order_item_id::text = ${p.id}`) {
      say(`        GRN ${g.grn_number} ${g.st} accepted ${g.qty_accepted}`);
      for (const pi of await sql`SELECT v.invoice_number, v.status::text AS st, x.qty FROM scm.purchase_invoice_items x JOIN scm.purchase_invoices v ON v.id = x.purchase_invoice_id WHERE x.grn_item_id::text = ${g.id}`)
        say(`           PI ${pi.invoice_number} ${pi.st} qty ${pi.qty}`);
      for (const l of await sql`SELECT variant_key, qty_received, qty_remaining FROM scm.inventory_lots WHERE source_doc_type = 'GRN' AND upper(btrim(item_code)) = upper(btrim(${r.item_code})) AND source_doc_no = ${g.grn_number}`)
        say(`           LOT key="${l.variant_key}" rcv ${l.qty_received} rem ${l.qty_remaining}`);
    }
  }
  for (const d of await sql`SELECT o.do_number, o.status::text AS st, it.qty FROM scm.delivery_order_items it JOIN scm.delivery_orders o ON o.id = it.delivery_order_id WHERE it.so_item_id::text = ${r.id}`)
    say(`     DO ${d.do_number} ${d.st} qty ${d.qty}`);
}
for (const r of await sql`SELECT fabric_id, colour_id, label, active FROM scm.fabric_colours WHERE company_id = 1 AND (colour_id ILIKE 'M2402-0%1%' OR colour_id ILIKE 'M2402-1%' OR label ILIKE '%PEARL%') ORDER BY colour_id LIMIT 30`)
  say(`  pearl/M2402: ${r.fabric_id} ${r.colour_id} "${r.label}" active=${r.active}`);
say("\nREAD-ONLY — nothing was written.");
await sql.end();
