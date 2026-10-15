// The SQL half of repair-hc0106-stale-po-received.mjs, importable so
// tests-pg/poReceivedRecountRepairSql.pg.test.ts can run it on a real
// postgres with the real enum columns. The first prod run died on
// `COALESCE(g.status, '')`: '' is not a scm.grn_status label. Every status
// comparison here goes through ::text for that reason.

/** Every PO line with at least one DRAFT / CANCELLED GRN line, all the GRN
 *  lines on those PO lines, and the SO line each one is bound to. */
export async function readStaleState(db, companyId) {
  const poLines = await db`
    SELECT poi.id::text AS "poItemId", po.id::text AS "poId", po.po_number AS "poNumber",
           po.status::text AS "poStatus", po.linked_ac_docno AS "linkedAcDocno",
           poi.item_code AS "itemCode", poi.qty::float8 AS qty,
           COALESCE(poi.received_qty, 0)::float8 AS "receivedQty",
           si.doc_no AS "soDocNo", si.stock_status::text AS "soStockStatus"
      FROM scm.purchase_order_items poi
      JOIN scm.purchase_orders po ON po.id = poi.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = poi.so_item_id
     WHERE po.company_id = ${companyId}
       AND EXISTS (SELECT 1 FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
                    WHERE gi.purchase_order_item_id = poi.id
                      AND g.status::text IN ('DRAFT', 'CANCELLED'))`;
  const ids = poLines.map((p) => p.poItemId);
  const grnLines = ids.length === 0 ? [] : await db`
    SELECT gi.purchase_order_item_id::text AS "poItemId", g.grn_number AS "grnNumber",
           g.status::text AS "grnStatus", COALESCE(gi.qty_accepted, 0)::float8 AS "qtyAccepted",
           COALESCE(gi.returned_qty, 0)::float8 AS "returnedQty"
      FROM scm.grn_items gi JOIN scm.grns g ON g.id = gi.grn_id
     WHERE gi.purchase_order_item_id = ANY(${ids}::uuid[])`;
  return { poLines, grnLines };
}

/** Each PO's status and all of its lines, keyed by PO id. */
export async function readPoLines(db, companyId, poIds) {
  if (poIds.length === 0) return new Map();
  const rows = await db`
    SELECT po.id::text AS "poId", po.status::text AS "poStatus",
           poi.id::text AS "poItemId", poi.qty::float8 AS qty,
           COALESCE(poi.received_qty, 0)::float8 AS "receivedQty"
      FROM scm.purchase_orders po JOIN scm.purchase_order_items poi ON poi.purchase_order_id = po.id
     WHERE po.id = ANY(${poIds}::uuid[]) AND po.company_id = ${companyId}`;
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.poId)) out.set(r.poId, { status: r.poStatus, lines: [] });
    out.get(r.poId).lines.push(r);
  }
  return out;
}

/** The writes, inside the caller's transaction. Throws (and so rolls back)
 *  when a line moved since it was read. */
export async function writeRepair(tx, companyId, fixes, poPlan, token, reason) {
  for (const f of fixes) {
    const back = await tx`
      UPDATE scm.purchase_order_items SET received_qty = ${f.newReceivedQty}
       WHERE id = ${f.poItemId}::uuid AND COALESCE(received_qty, 0) = ${f.receivedQty}
      RETURNING id`;
    if (back.length !== 1) throw new Error(`${f.poNumber} ${f.itemCode} changed since it was read; nothing written`);
  }
  for (const p of poPlan) {
    if (!p.to) continue;
    await tx`
      UPDATE scm.purchase_orders
         SET status = ${p.to}, updated_at = now(),
             received_at = CASE WHEN ${p.fully} THEN COALESCE(received_at, now()) ELSE NULL END
       WHERE id = ${p.poId}::uuid AND company_id = ${companyId}
         AND status::text NOT IN ('CANCELLED', 'ON_HOLD')`;
  }
  await tx`
    INSERT INTO scm.stock_allocation_recompute_queue (job_key, request_token, requested_at, reason)
    VALUES ('GLOBAL', ${token}, now(), ${reason})
    ON CONFLICT (job_key) DO UPDATE SET request_token = EXCLUDED.request_token,
      requested_at = EXCLUDED.requested_at, reason = EXCLUDED.reason`;
}
