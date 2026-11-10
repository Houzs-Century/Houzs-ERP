// Read-only, second pass on the four half-done documents: which lots the
// downstream DOs consumed, DO-319's ship-from warehouse and batch per line and
// its items' ledgers there, and whether each GRN line has a cost (yes/no only).
// Quantities, document numbers and dates only: Actions logs are public.
//   Actions -> "Run a backend script on production": check-half-done-evidence2.mjs, mode plan, env COMPANY_ID=1
import "./lib/public-log-guard.mjs";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { variantKeyMirror } from "./lib/ledger-repair-core.mjs";

function resolveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try { return readFileSync(".dev.vars", "utf8").match(/DATABASE_URL="([^"]+)"/)?.[1]; } catch { return undefined; }
}
const url = resolveUrl();
const CO = Number(process.env.COMPANY_ID ?? "");
if (!url || !Number.isInteger(CO) || CO <= 0) { console.error("Needs DATABASE_URL, COMPANY_ID"); process.exit(1); }
const iso = (t) => (t ? new Date(t).toISOString().replace(".000Z", "Z") : "-");
const s8 = (x) => String(x ?? "").slice(0, 8);

const pg = postgres(url, { ssl: "require", prepare: false, max: 1 });
try {
  await pg.begin("read only", async (sql) => {
    const tryq = (label, fn) => sql.savepoint(fn).catch((e) => console.log(`  [${label}] query failed: ${e.message}`));
    const wh = new Map((await sql`SELECT id, code, name FROM scm.warehouses WHERE company_id = ${CO}`).map((w) => [w.id, w.code || w.name]));
    const whOf = (id) => wh.get(id) ?? s8(id);

    console.log("== A. consumptions of the downstream DO OUTs");
    await tryq("A", async (sql) => {
      const rows = await sql`
        SELECT m.source_doc_no, m.item_code, m.variant_key, m.batch_no, m.qty, m.id AS mov, m.warehouse_id,
               (m.total_cost_sen > 0) AS costed,
               c.qty_consumed, c.lot_id, l.source_doc_type AS lot_src, l.source_doc_no AS lot_no, l.variant_key AS lot_vk,
               l.batch_no AS lot_batch, l.qty_received, l.qty_remaining
          FROM scm.inventory_movements m
          LEFT JOIN scm.inventory_lot_consumptions c ON c.movement_id = m.id
          LEFT JOIN scm.inventory_lots l ON l.id = c.lot_id
         WHERE m.company_id = ${CO} AND m.movement_type = 'OUT' AND m.source_doc_type = 'DO'
           AND m.source_doc_no IN ('HC-DO-2610-329', 'HC-DO-2610-343', 'HC-DO-2610-420')
           AND (m.item_code LIKE '8030%' OR m.item_code = 'ELEPHANE-(K)')
         ORDER BY m.source_doc_no, m.item_code`;
      for (const r of rows) console.log(`  ${r.source_doc_no} ${r.item_code} @${whOf(r.warehouse_id)} vk=${r.variant_key} batch=${r.batch_no ?? ""} qty=${r.qty} costed=${r.costed} mov=${s8(r.mov)} -> ${r.lot_id ? `lot ${s8(r.lot_id)} ${r.lot_src}:${r.lot_no} vk=${r.lot_vk} batch=${r.lot_batch ?? ""} recv=${r.qty_received} left=${r.qty_remaining} took=${r.qty_consumed}` : "NO CONSUMPTION"}`);
    });

    console.log("\n== B. lots in the target buckets (any source) and who consumed them");
    await tryq("B", async (sql) => {
      const targets = [
        ["8030-2A(LHF)", 'fabriccode=bo315-05|seatheight=28|legheight=6"'],
        ["8030-1A(LHF)", "fabriccode=hi-01|seatheight=30|legheight=default"],
        ["8030-2A(RHF)", "fabriccode=hi-01|seatheight=30|legheight=default"],
        ["ELEPHANE-(K)", 'fabriccode=cx1211-11|gap=12"|divanheight=8"|legheight=no leg|totalheight=20"'],
      ];
      for (const [code, vk] of targets) {
        const lots = await sql`
          SELECT l.id, l.warehouse_id, l.source_doc_type, l.source_doc_no, l.batch_no, l.qty_received, l.qty_remaining, l.received_at,
                 (l.unit_cost_sen > 0) AS costed,
                 (SELECT string_agg(COALESCE(c.source_doc_no, '?') || ' x' || c.qty_consumed || ' mov ' || LEFT(c.movement_id::text, 8), '; ')
                    FROM scm.inventory_lot_consumptions c WHERE c.lot_id = l.id) AS used_by
            FROM scm.inventory_lots l
           WHERE l.company_id = ${CO} AND l.item_code = ${code} AND COALESCE(l.variant_key, '') = ${vk}
           ORDER BY l.received_at`;
        console.log(`  ${code} vk=${vk}: ${lots.length} lot(s)`);
        for (const l of lots) console.log(`    lot ${s8(l.id)} @${whOf(l.warehouse_id)} ${l.source_doc_type}:${l.source_doc_no} batch=${l.batch_no ?? ""} recv=${l.qty_received} left=${l.qty_remaining} costed=${l.costed} at ${iso(l.received_at)} used_by=${l.used_by ?? "-"}`);
      }
    });

    console.log("\n== C. DO-319 lines: ship-from warehouse and batch, per the app's resolution");
    await tryq("C", async (sql) => {
      const [h] = await sql`SELECT id, warehouse_id, is_dropship, status::text AS status, so_doc_no FROM scm.delivery_orders WHERE company_id = ${CO} AND do_number = 'HC-DO-2610-319'`;
      const [so] = await sql`SELECT status::text AS status, updated_at FROM scm.mfg_sales_orders WHERE company_id = ${CO} AND doc_no = ${h.so_doc_no}`;
      console.log(`  DO status ${h.status} header wh ${h.warehouse_id ? whOf(h.warehouse_id) : "null"} dropship=${h.is_dropship} | SO ${h.so_doc_no} status ${so?.status} updated ${iso(so?.updated_at)}`);
      const [dw] = await sql`SELECT id FROM scm.warehouses WHERE company_id = ${CO} AND is_default = true ORDER BY code LIMIT 1`;
      console.log(`  company default warehouse: ${dw ? whOf(dw.id) : "none"}`);
      const lines = await sql`
        SELECT i.id, i.item_code, i.item_group, i.variants, i.qty, i.committed_po_batch_no, i.committed_variant_key,
               si.warehouse_id AS so_wh, si.allocated_batch_no, si.stock_status, si.stock_qty_ready
          FROM scm.delivery_order_items i
          LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id AND si.company_id = ${CO}
         WHERE i.delivery_order_id = ${h.id} ORDER BY i.line_no`;
      for (const l of lines) {
        const vk = variantKeyMirror(l.item_group, l.variants);
        const w = l.so_wh ?? h.warehouse_id ?? dw?.id ?? null;
        console.log(`  line ${s8(l.id)} ${l.item_code} qty=${l.qty} vk=${vk} so_wh=${l.so_wh ? whOf(l.so_wh) : "null"} -> ship-from ${w ? whOf(w) : "NONE"} allocated_batch=${l.allocated_batch_no ?? ""} committed_batch=${l.committed_po_batch_no ?? ""} committed_vk=${l.committed_variant_key ?? ""} so_stock=${l.stock_status}/${l.stock_qty_ready}`);
        if (!w) continue;
        const b = await sql`
          WITH mv AS (SELECT COALESCE(variant_key, '') vk,
                             SUM(CASE WHEN movement_type = 'OUT' THEN -qty WHEN movement_type IN ('IN', 'ADJUSTMENT', 'TRANSFER') THEN qty ELSE 0 END)::int net
                        FROM scm.inventory_movements WHERE company_id = ${CO} AND warehouse_id = ${w} AND item_code = ${l.item_code} GROUP BY 1),
               lt AS (SELECT COALESCE(variant_key, '') vk, SUM(qty_remaining)::int open
                        FROM scm.inventory_lots WHERE company_id = ${CO} AND warehouse_id = ${w} AND item_code = ${l.item_code} GROUP BY 1)
          SELECT COALESCE(mv.vk, lt.vk) vk, COALESCE(mv.net, 0) net, COALESCE(lt.open, 0) open FROM mv FULL JOIN lt ON lt.vk = mv.vk
           WHERE COALESCE(mv.net, 0) <> 0 OR COALESCE(lt.open, 0) <> 0 OR COALESCE(mv.vk, lt.vk) = ${vk} ORDER BY 1`;
        for (const r of b) console.log(`      bucket vk=${r.vk}${r.vk === vk ? " <== this line" : ""} movements=${r.net} lots=${r.open}${r.net === r.open ? "" : " DIFFERS"}`);
        const open = await sql`
          SELECT l.id, l.source_doc_type, l.source_doc_no, l.batch_no, l.qty_remaining, l.received_at
            FROM scm.inventory_lots l
           WHERE l.company_id = ${CO} AND l.warehouse_id = ${w} AND l.item_code = ${l.item_code}
             AND COALESCE(l.variant_key, '') = ${vk} AND l.qty_remaining > 0 ORDER BY l.received_at`;
        for (const o of open) console.log(`      open lot ${s8(o.id)} ${o.source_doc_type}:${o.source_doc_no} batch=${o.batch_no ?? ""} left=${o.qty_remaining} at ${iso(o.received_at)}`);
        const later = await sql`
          SELECT m.created_at, m.movement_type, m.qty, m.source_doc_no, m.batch_no FROM scm.inventory_movements m
           WHERE m.company_id = ${CO} AND m.warehouse_id = ${w} AND m.item_code = ${l.item_code}
             AND COALESCE(m.variant_key, '') = ${vk} ORDER BY m.created_at`;
        for (const m of later) console.log(`      mov ${iso(m.created_at)} ${m.movement_type} ${m.qty} ${m.source_doc_no} batch=${m.batch_no ?? ""}`);
        const others = await sql`
          SELECT si.doc_no, h2.status::text AS st, si.qty, si.stock_status, si.stock_qty_ready, si.allocated_batch_no
            FROM scm.mfg_sales_order_items si JOIN scm.mfg_sales_orders h2 ON h2.doc_no = si.doc_no AND h2.company_id = ${CO}
           WHERE si.company_id = ${CO} AND si.item_code = ${l.item_code} AND si.warehouse_id = ${w} AND si.cancelled = false
             AND si.stock_status IN ('READY', 'PARTIAL')`;
        const same = others.filter((o) => true);
        console.log(`      SO lines READY/PARTIAL on this item here: ${same.length} ${same.slice(0, 12).map((o) => `${o.doc_no}(${o.st},${o.stock_status}/${o.stock_qty_ready},batch ${o.allocated_batch_no ?? "-"})`).join(" ")}`);
      }
    });

    console.log("\n== D. GRN lines: cost present, and the cost an IN would carry vs the IN that exists");
    await tryq("D", async (sql) => {
      const rows = await sql`
        SELECT g.grn_number, gi.id, gi.item_code, gi.qty_accepted, (COALESCE(gi.unit_cost_sen, 0) > 0) AS has_cost,
               g.currency, (COALESCE(g.exchange_rate, 1) = 1) AS rate_is_1,
               (SELECT bool_and(m.unit_cost_sen = gi.unit_cost_sen) FROM scm.inventory_movements m
                 WHERE m.company_id = ${CO} AND m.source_doc_type = 'GRN' AND m.source_doc_id = g.id AND m.item_code = gi.item_code AND m.movement_type = 'IN') AS in_cost_eq_line,
               (SELECT bool_and(m.unit_cost_sen = gi.unit_price_sen) FROM scm.inventory_movements m
                 WHERE m.company_id = ${CO} AND m.source_doc_type = 'GRN' AND m.source_doc_id = g.id AND m.item_code = gi.item_code AND m.movement_type = 'IN') AS in_cost_eq_price
          FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
         WHERE g.company_id = ${CO} AND g.grn_number IN ('HC-GRN-2609-118', 'HC-GRN-2610-045', 'HC-GRN-2610-030', 'HC-GRN-2610-207')
         ORDER BY g.grn_number, gi.item_code`;
      for (const r of rows) console.log(`  ${r.grn_number} ${r.item_code} acc=${r.qty_accepted} has_cost=${r.has_cost} currency=${r.currency} rate_is_1=${r.rate_is_1} existing IN cost == line unit_cost: ${r.in_cost_eq_line ?? "no IN"} == unit_price: ${r.in_cost_eq_price ?? "no IN"}`);
    });

    console.log("\n== E. later documents on the GRN lines (returns, invoices) and rack placement");
    await tryq("E", async (sql) => {
      const rows = await sql`
        SELECT g.grn_number, gi.item_code, gi.invoiced_qty, gi.returned_qty,
               (SELECT COUNT(*)::int FROM scm.purchase_invoice_items p WHERE p.grn_item_id = gi.id) AS pi_lines
          FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
         WHERE g.company_id = ${CO} AND g.grn_number IN ('HC-GRN-2609-118', 'HC-GRN-2610-045')`;
      for (const r of rows) console.log(`  ${r.grn_number} ${r.item_code} invoiced=${r.invoiced_qty} returned=${r.returned_qty} PI lines=${r.pi_lines}`);
    });

    console.log("\n== F. DO status changes recorded for DO-329 / DO-343 / DO-319 / DO-420");
    await tryq("F", async (sql) => {
      const rows = await sql`
        SELECT a.entity_doc_no, a.created_at, a.action, a.status_snapshot
          FROM scm.entity_audit_log a
         WHERE a.company_id = ${CO} AND a.entity_doc_no IN ('HC-DO-2610-329', 'HC-DO-2610-343', 'HC-DO-2610-420')
           AND a.action <> 'UPDATE' ORDER BY a.entity_doc_no, a.created_at`;
      for (const r of rows) console.log(`  ${r.entity_doc_no} ${iso(r.created_at)} ${r.action} ${r.status_snapshot ?? ""}`);
      const st = await sql`SELECT do_number, status::text AS s, dispatched_at, delivered_at FROM scm.delivery_orders
                            WHERE company_id = ${CO} AND do_number IN ('HC-DO-2610-329', 'HC-DO-2610-343', 'HC-DO-2610-420', 'HC-DO-2610-319')`;
      for (const r of st) console.log(`  ${r.do_number} now ${r.s} dispatched ${iso(r.dispatched_at)} delivered ${iso(r.delivered_at)}`);
    });
  });
} finally {
  await pg.end({ timeout: 5 });
}
