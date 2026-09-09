// ----------------------------------------------------------------------------
// sofa-piece-fold — fold the ERP's sofa PIECES back up into whole sofas, so the
// AutoCount balance and the ERP balance become commensurable.
//
// THE OWNER'S RULING, 2026-09-07 ~23:00 (+08): 「把我们的件数折回成整张沙发再比」.
// FOR THE COMPARISON ONLY. Nothing here changes how the ERP STORES sofa stock —
// the sofa MRP (sofa-set-coverage.ts findCoveringBatch) is hard-bound at piece
// level and re-modelling storage would break readiness. This module is read-only
// arithmetic over rows somebody else already read.
//
// WHY A FOLD IS POSSIBLE AT ALL, when decomposing is not.
// AutoCount tracks a sofa as ONE unit of one model ("AMN-SF9028 SOFA" x 6). The
// ERP tracks it per COMPARTMENT (9028-1A(LHF), 9028-CNR, 9028-2A(RHF)) and knows
// which compartments belong to the SAME physical build, because
// import-ac-sofa-stock.mjs stamped every compartment lot of one build with the
// same `batch_no` = its source PO number. That is not a convention invented here:
// it is what a GRN stamps (grns.ts resolvePoBatchByItem -> purchase_orders
// .po_number, migration 0120) and what sofa-set-coverage.ts documents as the
// batch identity ("batch_no = source PO number = one dye lot").
//
// So: batch = build. Going the other way — one AutoCount balance row into
// compartments — is impossible without inventing which build it is, which is why
// import-ac-stock-balance.mjs has always refused to. Folding needs no invention.
//
// THE FOLD RULE IS `MIN`, AND THE CHOICE MATTERS.
// A whole sofa is only whole while every one of its pieces is still on the shelf.
// Within one build, the number of complete sofas is therefore the MINIMUM
// quantity across the distinct compartment SKUs of that build, not the maximum
// and not an average. The importer wrote `qty = the build's unit count` onto
// every compartment line, so an untouched build reads the same number on all of
// them and min == max; they diverge exactly when pieces have been shipped or
// consumed unevenly, and that divergence is a finding, not noise. Both numbers
// are returned so the caller can report the gap instead of hiding it.
// ----------------------------------------------------------------------------

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * The ERP model behind a sofa's binding target.
 *
 * The binding CSV maps every AutoCount sofa item to the model's `-1S`
 * compartment ("AMN-SF9028 SOFA" -> "9028-1S"), which is a PIECE code standing
 * in for the model. The model is that code with the trailing `-1S` removed.
 * Verified against the binding on 2026-09-07: all 86 SOFA-category rows end in
 * `-1S`, and one model legitimately contains its own dash ("SOFA-333 44-1S"),
 * which is why the suffix is stripped from the END and never split on the first
 * dash.
 *
 * Anything that does not end in `-1S` returns null — REPORTED by the caller,
 * never guessed into a model.
 */
export function sofaModelOf(erpCode) {
  const c = norm(erpCode);
  return c.endsWith("-1S") ? c.slice(0, -3) : null;
}

/**
 * Longest-prefix matcher from an ERP piece code to its model.
 *
 * `startsWith(model + "-")` alone is ambiguous: the binding holds BOTH `SOFA`
 * and `SOFA-333 44` as models, so `SOFA-333 44-CNR` matches the first as well as
 * the second. Longest match wins, which is the only reading that can be right.
 */
export function makeModelMatcher(models) {
  const sorted = [...new Set([...models].map(norm))].sort((a, b) => b.length - a.length);
  return (itemCode) => {
    const c = norm(itemCode);
    for (const m of sorted) if (c === m || c.startsWith(`${m}-`)) return m;
    return null;
  };
}

/**
 * Fold compartment rows into whole sofas per model + warehouse.
 *
 * @param rows [{ model, warehouseId, batchNo, itemCode, qty }] — one row per
 *        (compartment SKU, warehouse, batch). Variant keys must already be
 *        summed by the caller: two fabric variants of one compartment in one
 *        build are still that build's one piece.
 * @returns Map `${model}|${warehouseId}` -> {
 *            whole,      complete sofas (sum over builds of the build's MIN)
 *            ceiling,    the same sum taken over the build's MAX
 *            builds,     how many batches contributed
 *            incomplete, builds whose min < max (pieces shipped unevenly)
 *            noBatch,    builds folded from rows carrying NO batch_no
 *            negative,   builds whose min is below zero
 *          }
 */
export function foldSofaPieces(rows) {
  const NO_BATCH = "(no batch)";
  /** `${model}|${wh}|${batch}` -> Map itemCode -> qty */
  const builds = new Map();
  for (const r of rows) {
    if (!r.model) continue;
    const batch = r.batchNo == null || String(r.batchNo).trim() === "" ? NO_BATCH : String(r.batchNo);
    const bk = `${r.model}|${r.warehouseId}|${batch}`;
    if (!builds.has(bk)) builds.set(bk, new Map());
    const pieces = builds.get(bk);
    const ik = norm(r.itemCode);
    pieces.set(ik, (pieces.get(ik) ?? 0) + Number(r.qty ?? 0));
  }

  const out = new Map();
  for (const [bk, pieces] of builds) {
    const i = bk.lastIndexOf("|");
    const cellKey = bk.slice(0, i);
    const batch = bk.slice(i + 1);
    const qs = [...pieces.values()];
    if (qs.length === 0) continue;
    const lo = Math.min(...qs), hi = Math.max(...qs);
    const cell = out.get(cellKey) ?? { whole: 0, ceiling: 0, builds: 0, incomplete: 0, noBatch: 0, negative: 0 };
    cell.whole += lo;
    cell.ceiling += hi;
    cell.builds += 1;
    if (lo !== hi) cell.incomplete += 1;
    if (batch === NO_BATCH) cell.noBatch += 1;
    if (lo < 0) cell.negative += 1;
    out.set(cellKey, cell);
  }
  return out;
}
