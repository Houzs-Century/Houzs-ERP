// report-expired-so — READ-ONLY. Every live sales order whose delivery date has
// passed while goods are still owed, with what stands behind each one (lines
// still owed, delivery orders, purchase orders, stock readiness), for the owner
// to review. Owner 2026-09-15: 「把这些 delivery date 已经 expired 很久了的单全部给我，
// 我要看一下还有什么问题」.
//
// A line is OWED when it is not cancelled, not a service line, and its qty is
// more than what live delivery orders (not DRAFT / CANCELLED) carry for it. An
// order is listed when it has an owed line and its effective delivery date — the
// header date, else the earliest owed line date — is before today (MYT).
// Output: one JSON object per order on lines starting "ROW ", for the export.
// RE-RUN: read-only and idempotent.
import postgres from "postgres";
const DSN = process.env.DATABASE_URL;
if (!DSN) { console.error("DATABASE_URL missing"); process.exit(2); }
const COMPANY = Number(process.env.COMPANY || 1);
const { SO_TERMINAL_STATES } = await import("./lib/so-terminal-states.mjs");
const sql = postgres(DSN, { ssl: "require", prepare: false, max: 1, idle_timeout: 20, connect_timeout: 120 });
try { await sql`SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`; } catch { /* SELECT only */ }
const rows = await sql`
  WITH owed AS (
    SELECT i.doc_no, i.id, i.item_code, i.item_group, i.qty, i.line_delivery_date, i.stock_status::text AS stock,
           coalesce((SELECT sum(di.qty) FROM scm.delivery_order_items di JOIN scm.delivery_orders o ON o.id = di.delivery_order_id
                     WHERE di.so_item_id = i.id AND o.status::text NOT IN ('DRAFT','CANCELLED')), 0) AS delivered
      FROM scm.mfg_sales_order_items i JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
     WHERE h.company_id = ${COMPANY} AND NOT i.cancelled AND h.status::text <> ALL(${SO_TERMINAL_STATES})
       AND lower(coalesce(i.item_group,'')) <> 'service' AND upper(i.item_code) NOT LIKE 'SVC-%'
  ), per_so AS (
    SELECT doc_no,
           count(*) FILTER (WHERE qty > delivered) AS owed_lines,
           sum(qty) AS ordered_units,
           sum(least(delivered, qty)) AS delivered_units,
           sum(greatest(qty - delivered, 0)) AS owed_units,
           min(line_delivery_date) FILTER (WHERE qty > delivered) AS earliest_owed_line_date,
           count(*) FILTER (WHERE qty > delivered AND stock = 'READY') AS owed_ready_lines,
           string_agg(DISTINCT CASE WHEN qty > delivered THEN item_code END, ' | ') AS owed_items
      FROM owed GROUP BY doc_no
  )
  SELECT h.doc_no, h.debtor_name, h.status::text AS status, h.so_date::text AS so_date, h.processing_date::text AS processing_date,
         h.customer_delivery_date::text AS header_delivery, p.earliest_owed_line_date::text AS line_delivery,
         coalesce(h.customer_delivery_date, p.earliest_owed_line_date)::text AS effective_delivery,
         ((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date - coalesce(h.customer_delivery_date, p.earliest_owed_line_date)) AS days_overdue,
         p.owed_lines, p.ordered_units, p.delivered_units, p.owed_units, p.owed_ready_lines, p.owed_items,
         h.agent, h.venue, h.balance_sen, h.local_total_sen, h.linked_ac_docno,
         (SELECT string_agg(DISTINCT o.do_number || ' ' || o.status::text, ', ') FROM scm.delivery_orders o WHERE o.so_doc_no = h.doc_no AND o.status::text <> 'CANCELLED') AS dos,
         (SELECT string_agg(DISTINCT po.po_number || ' ' || po.status::text, ', ') FROM scm.purchase_order_items it JOIN scm.purchase_orders po ON po.id = it.purchase_order_id
           JOIN scm.mfg_sales_order_items si ON si.id = it.so_item_id WHERE si.doc_no = h.doc_no AND po.status::text <> 'CANCELLED') AS pos,
         left(coalesce(h.note, h.remark2, ''), 160) AS note
    FROM per_so p JOIN scm.mfg_sales_orders h ON h.doc_no = p.doc_no
   WHERE p.owed_lines > 0 AND coalesce(h.customer_delivery_date, p.earliest_owed_line_date) < (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   ORDER BY days_overdue DESC, h.doc_no`;
console.log(`::notice::expired sales orders still owing goods, company ${COMPANY}: ${rows.length}`);
for (const r of rows) console.log("ROW " + JSON.stringify(r));
if (process.env.OUT_FILE) { const fs = await import("node:fs"); fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(rows)); }
console.log("::notice::READ-ONLY — nothing was written.");
await sql.end();
