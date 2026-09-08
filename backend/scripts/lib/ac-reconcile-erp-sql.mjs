// ---------------------------------------------------------------------------
// ac-reconcile-erp-sql — the ERP side of the AutoCount reconcile, stated ONCE.
//
// WHY THIS MODULE EXISTS. These SELECTs are the definition of "what the ERP
// holds for an AutoCount document": which table, which company filter, which
// column carries the line key, which rows count as cancelled. That definition
// used to live inline in check-ac-erp-reconcile.mjs, so a second checker
// wanting the same population had to restate it — and two statements of one
// rule is how a checker comes to measure a population no importer ever carried
// (the same failure `lib/ac-scope.mjs` was extracted to prevent, and the same
// one `lib/ac-mapping-csv.mjs` records: two parsers for one CSV invented 40 of
// 111 item-code "defects").
//
// check-keyless-lines.mjs verifies the documents the reconcile has to refuse to
// line-match. It must look at EXACTLY the rows the reconcile looked at, or its
// verdict describes a different set of documents than the one being reported
// as unverified. Hence one module, two callers.
//
// PURE CONFIG: it builds tagged-template thunks and runs nothing. The caller
// owns the connection and decides which types to read.
//
// NO SHEBANG: tests import this module (see lib/ac-mapping-csv.mjs for the
// Windows vitest reason).
// ---------------------------------------------------------------------------

/**
 * @param {object} a
 * @param {import('postgres').Sql} a.sql   an open postgres.js connection
 * @param {number} a.CO                    company_id (AED_HOUZS is 1)
 * @param {*} a.PDATE                      the ONE name of the SO Processing Date
 *   column, spliced as SQL TEXT — see lib/so-processing-date.mjs. Migration 0286
 *   renamed it and eleven scripts went on naming the old one, which fails the
 *   WHOLE statement.
 * @returns {Array<object>} one config per document type, in reconcile order.
 */
export function erpReconcileTypes({ sql, CO, PDATE }) {
  return [
  {
    t: "SO",
    label: "Sales Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT doc_no AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, subtotal_sen) AS total_sen
      FROM scm.mfg_sales_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        (h.${PDATE} IS NOT NULL) AS proceeded
      FROM scm.mfg_sales_order_items i
      JOIN scm.mfg_sales_orders h ON h.doc_no = i.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PO",
    label: "Purchase Order",
    absenceIs: "GAP",
    docs: () => sql`SELECT po_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        /* A PO line dedicated to an SO line inherits that order's state, because
           the customer's "not chosen yet" is what makes a blank legitimate. A
           PO line with no dedication is PROCEEDED: every purchase order in this
           ERP is at least SUBMITTED (measured 2026-09-07: 296 RECEIVED, 180
           SUBMITTED, 23 PARTIALLY_RECEIVED, nothing in a draft state), so the
           supplier is already being asked to build it. */
        (si.id IS NULL OR sh.${PDATE} IS NOT NULL) AS proceeded
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders h ON h.id = i.purchase_order_id
      LEFT JOIN scm.mfg_sales_order_items si ON si.id = i.so_item_id
      LEFT JOIN scm.mfg_sales_orders sh ON sh.doc_no = si.doc_no
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "GR",
    label: "Goods Received",
    absenceIs: "GAP",
    /* GOODS RECEIPTS ARE COMPARED AT PAIR GRAIN, and that is a decision worth
       reading before changing.

       This section used to print "line and money comparison NOT APPLICABLE" and
       stop, for two reasons that were both true: `grn_items.qty_received` was
       DERIVED from the purchase-order line rather than copied from the book, and
       ONE ERP goods receipt covered a whole purchase order while an AutoCount
       receipt can span several. Comparing those would have measured our own
       derivation. But "not applicable" then read as "checked", and the contents
       of the migrated receipts went unexamined right up to go-live.

       Both reasons were removed by `reshape-migrated-grns.mjs` (owner 2026-09-07:
       「是 A 的，不过只是把那些需要的搬进来，不需要的不需要搬」): the ERP now holds one document per
       (AutoCount receipt × purchase order), carrying the book's own receipt date
       and the book's own received quantity, and each one names its receipt in
       `scm.grns.linked_ac_gr_docno`.

       PAIR, not receipt, because `scm.grns.purchase_order_id` is a SINGLE
       purchase order and 51 of the 214 in-scope receipts cover more than one.
       Comparing at RECEIPT grain would report every one of those 51 as short by
       the part of it raised against another purchase order — a shortfall the ERP
       is structurally incapable of not having. The pair is the finest grain both
       sides can state, and at that grain the comparison is like-for-like. */
    pairGrain: true,
    sofaAware: true,
    /* The MULTISET verdict on this type's keyless documents compares item and
       QUANTITY only. `priceDeclared` below says the price is taken from the
       purchase order, so comparing money here would measure our own derivation
       and report it as the book being wrong. */
    keylessMoney: false,
    /* THE OWNER'S STANDING DECISION about a migrated receipt that carries no
       money, 2026-09-08: 「GR 0 没关系」. Declared HERE, per type, so it can
       never leak to a document type he never ruled on — and honoured only where
       the run can PROVE the receipt is migrated paperwork. `zeroMoneyProof`
       below is that proof; without it nothing is reclassified. */
    zeroMoneyDecision: {
      label: "GR 0 没关系",
      ruling:
        "the owner ruled 2026-09-08 that a MIGRATED goods receipt may carry RM 0.00. It moves no stock, no " +
        "cost and no MRP — the units were already brought in by the balance snapshot, and the receipt is " +
        "paperwork recording that the book has one",
      consequence:
        "a PURCHASE INVOICE cannot be raised off a RM 0.00 receipt. That is the whole cost of this decision " +
        "and it is named here so nobody rediscovers it as a surprise",
    },
    /* One row per migrated receipt, carrying the two facts the decision rests
       on. Read-only. `source_doc_no` is how every other script in this repo
       asks "did this document move stock" (apply-sofa-compartment-corrections
       .mjs:90), so the question is asked the same way here. */
    zeroMoneyProof: () => sql`SELECT g.grn_number AS erp_no,
        COALESCE(g.migrated_no_stock, false) AS migrated_no_stock,
        (SELECT count(*)::int FROM scm.inventory_movements m
          WHERE m.company_id = g.company_id AND m.source_doc_no = g.grn_number) AS movements
      FROM scm.grns g
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED' AND g.linked_ac_gr_docno IS NOT NULL`,
    priceDeclared:
      "grn_items.unit_price_sen is taken from the PURCHASE ORDER line by design, not from GRDTL.UnitPrice — " +
      "reshape-migrated-grns.mjs copies the book's item, quantity and date, and leaves price to the order",
    docs: () => sql`SELECT g.grn_number AS erp_no,
        g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
        COALESCE(g.total_sen, 0) AS total_sen
      FROM scm.grns g JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
        AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`,
    lines: () => sql`SELECT g.linked_ac_gr_docno || '|' || p.linked_ac_docno AS ac_no,
        i.item_code, i.qty_accepted::float8 AS qty, i.unit_price_sen,
        NULL::bigint AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.grn_items i
      JOIN scm.grns g ON g.id = i.grn_id
      JOIN scm.purchase_orders p ON p.id = g.purchase_order_id
      WHERE g.company_id = ${CO} AND g.status <> 'CANCELLED'
        AND g.linked_ac_gr_docno IS NOT NULL AND p.linked_ac_docno IS NOT NULL`,
    /* The other half of the presence axis: receipt numbers stamped on the
       purchase order by stamp-ac-grn-refs.mjs, which carry no ERP document.
       Restated at pair grain so it is commensurable with the documents. */
    pointers: () => sql`SELECT DISTINCT g || '|' || p.linked_ac_docno AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_grn_docnos) g
      WHERE p.company_id = ${CO} AND p.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "DO",
    label: "Delivery Order",
    /* CORRECTED 2026-09-07 (the second go-live round). This said DECISION, and
       printed every absent delivery order as "(owner-declined)". The owner
       declined importing the DELIVERY HISTORY — 11,443 documents — and that
       still stands; it never meant that a delivery raised against an order the
       ERP holds stays behind. `ac-scope.mjs` has always given DO a real,
       non-empty population (84 documents), so the label was describing a
       population that does not exist: it read a GAP out as a decision, which is
       precisely the failure this reconcile exists to prevent. Measured the same
       day: DO-001800 -> SO-002281 and DO-005583 -> SO-007435, both un-cancelled,
       both against orders with undelivered lines, both printed as "declined".
       The invariant below now refuses the label over a non-empty scope, so the
       constant and `ac-scope.mjs` cannot drift apart again. */
    absenceIs: "GAP",
    sofaAware: true,
    /* A migrated delivery order carries no money at all — the reconcile counts
       that as a POPULATION property, not per-document drift — so the multiset
       verdict on its keyless documents is item and QUANTITY only. */
    keylessMoney: false,
    itemCodeDeclared:
      "delivery_order_items.item_code is taken from the SALES ORDER line by design, not from DODTL.ItemCode",
    docs: () => sql`SELECT do_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(local_total_sen, 0) AS total_sen
      FROM scm.delivery_orders WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.delivery_order_items i
      JOIN scm.delivery_orders h ON h.id = i.delivery_order_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "IV",
    label: "Sales Invoice",
    /* Its lines come from OUR delivery order, not from AutoCount IVDTL. */
    migratedChainLineShape: true,
    /* Same correction, same day, same reason as DO above. `ac-scope.mjs` was
       already corrected on 2026-09-07 with the owner's own ruling —
       「没有的 SO DO 何来发票？有的 SO DO 自然要发票」 — and gave IV a 47-document
       population; this constant went on saying DECISION, so all 7 absentees
       printed as "owner-declined". */
    absenceIs: "GAP",
    sofaAware: true,
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no,
        COALESCE(total_sen, local_total_sen) AS total_sen
      FROM scm.sales_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        COALESCE(i.line_no, 0) AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.sales_invoice_items i
      JOIN scm.sales_invoices h ON h.id = i.sales_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
  },
  {
    t: "PI",
    label: "Purchase Invoice",
    /* Its lines come from OUR goods receipt, not from AutoCount PIDTL. */
    migratedChainLineShape: true,
    /* Same correction as DO and IV. 192 in the population, 21 absent — a gap,
       not a decision. What blocks the 21 is the money gate inside
       create-migrated-invoices.mjs, not the absence of a source to convert
       from; see docs/autocount-cutover-ledger.md. */
    absenceIs: "GAP",
    docs: () => sql`SELECT invoice_number AS erp_no, linked_ac_docno AS ac_no, total_sen
      FROM scm.purchase_invoices WHERE company_id = ${CO}`,
    lines: () => sql`SELECT h.linked_ac_docno AS ac_no, i.item_code, i.qty::float8 AS qty,
        i.unit_price_sen, i.linked_ac_dtlkey AS ac_dtlkey, i.line_suffix,
        0 AS line_no, i.created_at, i.id::text AS id,
        i.item_group, i.variants, i.custom_specials, i.description2,
        TRUE AS proceeded
      FROM scm.purchase_invoice_items i
      JOIN scm.purchase_invoices h ON h.id = i.purchase_invoice_id
      WHERE h.company_id = ${CO} AND h.linked_ac_docno IS NOT NULL`,
    /* The other half of the purchase-invoice link: pointers stamped on the PO
       by stamp-ac-grn-refs.mjs, which carry no ERP document. */
    pointers: () => sql`SELECT DISTINCT g AS ac_no, p.po_number AS erp_no
      FROM scm.purchase_orders p, unnest(p.linked_ac_pinv_docnos) g
      WHERE p.company_id = ${CO}`,
  },
  ];
}
