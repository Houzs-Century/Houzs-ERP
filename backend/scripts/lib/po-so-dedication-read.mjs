// ---------------------------------------------------------------------------
// po-so-dedication-read — the ONE read behind every question about a
// (sales order, purchase order) dedication pair.
//
// WHY THIS IS A MODULE AND NOT A COPY. lib/po-so-dedication-plan.mjs settles a
// bucket of same-code, same-seat rows only when every candidate in it is
// INDISTINGUISHABLE, and "indistinguishable" is defined there as "the
// `fingerprint` the CALLER built from every column it read". The columns the
// caller reads therefore ARE the comparison. A second caller that reads a
// different set does not ask a slightly different question — it reports a
// different answer to the SAME one, confidently.
//
// Two callers exist and they must never drift:
//   · repair-po-so-item-dedication.mjs — the writer, which decides.
//   · probe-dedication-bucket-diff.mjs — the read-only explainer, which says
//     WHICH column made the planner refuse. Its whole value is that it looks at
//     exactly what the planner looked at; a probe reading its own column list
//     would name a column the planner never compared, or miss the one it did.
//
// So the SELECT, the seat derivation and the fingerprint live here, once.
// Widening the SELECT automatically makes the comparison stricter for the
// writer and visible to the probe, in the same edit.
//
// NO WRITES, NO DDL, NO TRANSACTION. The client is the caller's.
// ---------------------------------------------------------------------------

/** `variants.seatHeight` as a string, or null when the line carries none. */
export const seatOf = (v) => {
  const s = v && typeof v === 'object' ? v.seatHeight : null;
  return s === null || s === undefined || s === '' ? null : String(s);
};

/* The three columns that must stay OUT of the fingerprint: `id` and `line_no`
   are the row's own identity, `so_item_id` is the thing being decided. `seat`
   and `fingerprint` are derived here rather than read, and `seat` is already
   half of the bucket key, so neither is a column of its own. */
export const OUT_OF_FINGERPRINT = new Set(['id', 'line_no', 'so_item_id', 'seat', 'fingerprint']);

/**
 * Everything a row was READ as, column by column, sorted by name — so two rows
 * that agree cannot disagree on key ordering, and a caller can diff PER COLUMN
 * instead of only comparing the whole string.
 *
 * @returns {Array<[string, string|null]>}
 */
export const fingerprintFields = (row) =>
  Object.keys(row)
    .filter((k) => !OUT_OF_FINGERPRINT.has(k))
    .sort()
    .map((k) => [
      k,
      row[k] === null || row[k] === undefined
        ? null
        : typeof row[k] === 'object'
          ? JSON.stringify(row[k])
          : String(row[k]),
    ]);

/** The fingerprint lib/po-so-dedication-plan.mjs compares. */
export const fingerprintOf = (row) => JSON.stringify(fingerprintFields(row));

/**
 * Resolve a purchase order by its number OR by the AutoCount document it links
 * to — the migrated purchase orders are being renumbered so every number
 * follows AutoCount, which makes the number alone an unstable handle.
 */
export async function resolvePo(client, co, poDoc) {
  const ac = poDoc.replace(/^HC-/, '');
  const rows = await client`SELECT id, po_number, status FROM scm.purchase_orders
     WHERE company_id = ${co} AND (po_number = ${poDoc} OR linked_ac_docno = ${ac})`;
  if (rows.length !== 1) return { po: null, why: `${poDoc}: ${rows.length} purchase order(s) match on company ${co}` };
  return { po: rows[0], why: null };
}

/**
 * Every line of both documents, with the seat and the fingerprint the planner
 * compares. Sales lines in line order, purchase lines in id order.
 */
export async function readPair(client, co, poId, soDoc) {
  const soRaw = await client`SELECT i.id, i.line_no, i.item_group, i.item_code, i.qty, i.unit_price_sen,
                                    i.total_sen, i.cancelled, i.variants, i.po_qty_picked, i.description2
                               FROM scm.mfg_sales_order_items i
                               JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
                              WHERE h.company_id = ${co} AND i.doc_no = ${soDoc}
                              ORDER BY i.line_no`;
  const poRaw = await client`SELECT i.id, i.item_group, i.item_code, i.qty, i.unit_price_sen,
                                    i.line_total_sen, i.so_item_id, i.variants, i.received_qty, i.description2
                               FROM scm.purchase_order_items i
                              WHERE i.purchase_order_id = ${poId} AND i.company_id = ${co}
                              ORDER BY i.id`;
  return {
    soRows: soRaw.map((r) => ({ ...r, seat: seatOf(r.variants), fingerprint: fingerprintOf(r) })),
    poRows: poRaw.map((r) => ({ ...r, seat: seatOf(r.variants), fingerprint: fingerprintOf(r) })),
  };
}
