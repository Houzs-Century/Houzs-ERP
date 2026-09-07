/* migrated-grn-source — the ONE reading of "what a migrated goods receipt would
 * bill", shared by the converter that writes the invoice and the diagnostic
 * that explains why it did not.
 *
 * WHY IT IS A FILE. `create-migrated-invoices.mjs` held this inline. A second
 * reader that restated it would be a second statement of one rule, and this
 * repo has already paid for that shape twice: `ac-scope.mjs` exists because the
 * in-scope population was written down twice and the checker ended up measuring
 * a population no importer ever carried. A diagnostic that computes "ours"
 * differently from the converter does not explain the converter — it invents a
 * second answer and calls it evidence.
 *
 * READ-ONLY. SELECT only, no writes, no decisions: the decisions live in
 * src/scm/lib/migrated-chain.ts and both callers pass this straight into it.
 */

/**
 * Every migrated goods receipt of one company, shaped as
 * `MigratedSourceDoc[]` for `planMigratedInvoices`.
 *
 * @param sql            a `postgres` tagged-template client
 * @param companyId      the company (1 = Houzs Century)
 * @param grToPi         AutoCount receipt number -> the invoice numbers raised
 *                       from it (`ac-invoice-refs.json.gz`)
 * @param isCancelled    predicate: did AutoCount cancel this invoice
 */
export async function loadMigratedGrnSources(sql, { companyId, grToPi, isCancelled }) {
  const n = (x) => Number(x || 0);
  const live = (list) => (list ?? []).filter((x) => !isCancelled(x));
  const dead = (list) => (list ?? []).filter((x) => isCancelled(x));

  const rows = await sql`
    SELECT g.id, g.grn_number, g.supplier_id, g.currency, g.exchange_rate, g.received_at,
           g.purchase_order_id, p.linked_ac_grn_docnos AS ac_grs
    FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
    WHERE g.company_id = ${companyId} AND g.migrated_no_stock = true
    ORDER BY g.grn_number`;
  const items = await sql`
    SELECT i.id, i.grn_id, i.material_kind, i.item_code, i.material_name, i.item_group,
           i.description, i.description2, i.uom, i.unit_price_sen, i.discount_sen,
           i.qty_accepted, i.invoiced_qty, i.returned_qty, i.purchase_order_item_id,
           i.variants, i.gap_inches, i.divan_height_inches, i.divan_price_sen,
           i.leg_height_inches, i.leg_price_sen, i.custom_specials, i.line_suffix,
           i.special_order_price_sen
    FROM scm.grn_items i JOIN scm.grns g ON g.id = i.grn_id
    WHERE g.company_id = ${companyId} AND g.migrated_no_stock = true`;
  const byDoc = new Map();
  for (const it of items) {
    if (!byDoc.has(it.grn_id)) byDoc.set(it.grn_id, []);
    byDoc.get(it.grn_id).push(it);
  }

  return rows.map((g) => {
    /* The AutoCount receipt number is the head of our GRN number: HC-<GR> when
       that receipt covers one imported PO, HC-<GR>-<PO> when it covers more.
       Derived rather than read from grns.linked_ac_docno, which holds the PO's
       AutoCount number and not the receipt's despite what migration 0276's
       comment says. */
    const acGr = (g.ac_grs ?? []).find(
      (gr) => g.grn_number === `HC-${gr}` || g.grn_number.startsWith(`HC-${gr}-`)) ?? null;
    const raw = grToPi[acGr] ?? [];
    const lines = (byDoc.get(g.id) ?? []).map((i) => ({
      lineId: i.id,
      itemCode: i.item_code,
      /* Remaining, not accepted: a receipt can be invoiced across several
         invoices, and anything returned to the supplier is not billable. */
      qty: n(i.qty_accepted) - n(i.invoiced_qty) - n(i.returned_qty),
      unitPriceSen: n(i.unit_price_sen),
      discountSen: n(i.discount_sen),
      sourceLineKey: i.purchase_order_item_id,
      _row: i,
    }));
    return {
      docNo: g.grn_number, acDocNo: acGr,
      acInvoiceNos: live(raw), acCancelledInvoiceNos: dead(raw),
      /* Rule 5 — the merged header names one supplier, and writePi takes it from
         whichever source document sorts first. Hand the planner the party so a
         disagreement is refused instead of resolved by sort order. */
      partyKey: g.supplier_id ?? null,
      /* One ERP receipt can fold SEVERAL AutoCount receipts — HC-GR-004996-PO-009304
         holds 172 units that AutoCount split across GR-004996 (14) and GR-005018
         (158), both billed on PI-007471. The invoice is still right, because the
         total gate reconciles the money end to end, but the plan must SAY so
         rather than let a reader think one receipt maps to one receipt. */
      _acGrsAll: (g.ac_grs ?? []).filter(Boolean),
      lines, _head: g,
    };
  });
}
