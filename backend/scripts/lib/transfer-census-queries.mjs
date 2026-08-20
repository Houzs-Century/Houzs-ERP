// ----------------------------------------------------------------------------
// transfer-census-queries — every statement behind `probe-transfer-census.mjs`.
//
// WHY THE SQL LIVES IN ITS OWN MODULE. A `workflow_dispatch` probe cannot be
// dispatched until it is on the default branch, and there is no local database,
// so "node --check passes" is the only evidence a probe has before its first
// production run. That is not enough: `probe-undated-demand.mjs` died mid-run on
// its first dispatch (run 31962771658) on SQL that had never been parsed by
// Postgres. Only Postgres can parse Postgres, CI already runs one, so every
// query here is EXECUTED by `tests-pg/probeTransferCensusSql.pg.test.ts`. The
// probe imports this module, so there is no second copy to drift.
//
// ── WHAT IT MEASURES, and the question each answer settles ──────────────────
//
// 1. THE GRN PICKER'S OLD WINDOW (owner, 2026-08-17: a PO that had never been
//    received showed zero outstanding lines). `GET /grns/outstanding-po-items`
//    ran `.limit(500)` on the RAW `purchase_order_items` select and applied BOTH
//    filters afterwards in JavaScript, ordered by `purchase_order_id DESC`. So
//    the window was spent on every PO line in the company, received or not, and
//    which 500 you got was a uuid ordering. `oldWindowBlastRadius` replays that
//    exact query and counts the outstanding lines and whole POs it hid.
//
// 2. THE STATUS HISTOGRAM. The picker shows lines only from SUBMITTED /
//    PARTIALLY_RECEIVED parents. The AutoCount import writes PO rows, so what
//    statuses live POs actually carry is a question about production, not about
//    `purchase-doc-vocab.ts`. `poStatusHistogram` marks which are excluded.
//
// 3. THE DOUBLE-TRANSFER CENSUS. The owner: everything except the PO is
//    once-only per LINE. A missing guard lets one source line be transferred
//    twice, producing duplicate downstream documents — the direction he has NOT
//    noticed yet. `doubleTransferred` finds source lines whose downstream sum
//    EXCEEDS the source quantity, and `unboundDestLines` counts the destination
//    lines whose binding is NULL, which no ceiling can see at all.
//
// ── EVERY QUERY IS READ-ONLY. One statement each, no DDL, no transaction. ────
//
// COLUMN NAMES ARE VERIFIED AT RUNTIME, not trusted. `scm`'s DDL is not in this
// repo — `backend/scripts/scm-schema/2990s-full-schema.sql` is a dump of the 2990
// SOURCE system and is already known to be behind production (it has no
// `sales_invoice_items.do_item_id`, which the SI converter writes on every
// DO-derived line). So `hasColumn` gates each pair and a pair whose columns are
// absent is REPORTED AS ABSENT rather than crashing the run or, worse, being
// silently counted as zero.
// ----------------------------------------------------------------------------

/** Does a column exist? The gate in front of every census below. */
export const hasColumn = (sql, schema, table, column) => sql`
  SELECT count(*)::int AS n
    FROM information_schema.columns
   WHERE table_schema = ${schema} AND table_name = ${table} AND column_name = ${column}
`;

/** Does a table exist at all? A pair whose destination table is missing is a
 *  different answer from one whose binding column is missing. */
export const hasTable = (sql, schema, table) => sql`
  SELECT count(*)::int AS n
    FROM information_schema.tables
   WHERE table_schema = ${schema} AND table_name = ${table}
`;

/** Companies, so every figure below can be reported per company rather than
 *  summed across books — CLAUDE.md's standing correction on audit numbers. */
export const companies = (sql) => sql`
  SELECT id::int AS id, code, name, COALESCE(is_active, 0)::int AS is_active
    FROM public.companies
   ORDER BY id
`;

// ── 1. The GRN picker's old 500-row window ──────────────────────────────────

/**
 * The blast radius of the cap that was removed.
 *
 * `win` replays the OLD read verbatim: every `purchase_order_items` row for the
 * company, ordered by `purchase_order_id DESC`, capped at `$limit`. Then:
 *   · outstanding_total     — outstanding lines in the company (any live status)
 *   · outstanding_in_window — how many of them the picker could actually see
 *   · outstanding_hidden    — the ones it could not, with NO signal on screen
 *   · pos_hidden            — whole POs that had outstanding lines and were
 *                             completely invisible. Each one is an operator
 *                             being told "every line has been received".
 *
 * `$limit` is a parameter so the same query answers "what did 500 cost" and
 * "would 1000 have been enough" — a fix justified by arithmetic alone is what
 * CLAUDE.md forbids.
 */
/* PLAIN JOINS AND AGGREGATES ONLY, on purpose. The obvious way to write this is
   `HAVING count(*) FILTER (WHERE o.id IN (SELECT id FROM win)) = 0` — a subquery
   inside an aggregate's FILTER, inside a HAVING. That is precisely the family of
   construct that killed the last probe's first production dispatch, and neither
   `node --check` nor typecheck can see a planner-level failure. So membership is
   resolved once by a LEFT JOIN into a boolean, and every figure below is a count
   over that. It also sidesteps `NOT IN`'s NULL semantics, which would silently
   return zero hidden rows if the window ever contained a NULL id. */
export const oldWindowBlastRadius = (sql, companyId, limit) => sql`
  WITH win AS (
    SELECT i.id
      FROM scm.purchase_order_items i
     WHERE i.company_id = ${companyId}
     ORDER BY i.purchase_order_id DESC
     LIMIT ${limit}
  ), outstanding AS (
    SELECT i.id, i.purchase_order_id
      FROM scm.purchase_order_items i
      JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
     WHERE i.company_id = ${companyId}
       AND UPPER(COALESCE(p.status::text, '')) IN ('SUBMITTED', 'PARTIALLY_RECEIVED')
       AND (i.qty - COALESCE(i.received_qty, 0)) > 0
  ), flagged AS (
    SELECT o.id, o.purchase_order_id, (w.id IS NOT NULL) AS in_window
      FROM outstanding o
      LEFT JOIN win w ON w.id = o.id
  ), per_po AS (
    SELECT f.purchase_order_id, bool_or(f.in_window) AS any_visible
      FROM flagged f
     GROUP BY f.purchase_order_id
  )
  SELECT
    (SELECT count(*)::int FROM scm.purchase_order_items WHERE company_id = ${companyId}) AS po_lines_total,
    (SELECT count(*)::int FROM flagged)                          AS outstanding_total,
    (SELECT count(*)::int FROM flagged WHERE in_window)           AS outstanding_in_window,
    (SELECT count(*)::int FROM flagged WHERE NOT in_window)       AS outstanding_hidden,
    (SELECT count(*)::int FROM per_po)                            AS pos_with_outstanding,
    (SELECT count(*)::int FROM per_po WHERE NOT any_visible)       AS pos_hidden
`;

/** Statuses of POs holding at least one line with qty > received_qty, with the
 *  picker's verdict on each. `excluded_by_picker` is the column that answers
 *  "what is the status filter silently costing us". */
export const poStatusHistogram = (sql, companyId) => sql`
  SELECT
    COALESCE(NULLIF(UPPER(COALESCE(p.status::text, '')), ''), '(null)') AS status,
    count(DISTINCT p.id)::int                                          AS pos,
    count(*)::int                                                      AS unreceived_lines,
    (UPPER(COALESCE(p.status::text, '')) NOT IN ('SUBMITTED', 'PARTIALLY_RECEIVED')) AS excluded_by_picker
    FROM scm.purchase_order_items i
    JOIN scm.purchase_orders p ON p.id = i.purchase_order_id
   WHERE i.company_id = ${companyId}
     AND (i.qty - COALESCE(i.received_qty, 0)) > 0
   GROUP BY 1, 4
   ORDER BY pos DESC
`;

/** The owner's PO by document number, in full: its status, and per line what has
 *  been received and what the picker would therefore show. This is the query
 *  that separates "never received" from "received" for the screenshot. */
export const poByDocNo = (sql, docNo) => sql`
  SELECT p.id::text        AS po_id,
         p.po_number,
         p.company_id::int AS company_id,
         UPPER(COALESCE(p.status::text, '(null)')) AS status,
         i.id::text        AS po_item_id,
         i.item_code,
         i.qty::numeric                            AS qty,
         COALESCE(i.received_qty, 0)::numeric      AS received_qty,
         (i.qty - COALESCE(i.received_qty, 0))::numeric AS remaining,
         (SELECT count(*)::int FROM scm.grn_items gi WHERE gi.purchase_order_item_id = i.id) AS grn_lines
    FROM scm.purchase_orders p
    LEFT JOIN scm.purchase_order_items i ON i.purchase_order_id = p.id
   WHERE UPPER(p.po_number) = UPPER(${docNo})
   ORDER BY i.item_code
`;

// ── 2. The double-transfer census, per pair ─────────────────────────────────

/**
 * Source lines transferred MORE than their own quantity.
 *
 * Generic over the pair, because the shape is identical across ten of them and a
 * hand-written copy per pair is how two of them end up disagreeing. Every
 * identifier is interpolated with `sql()` (an identifier binding, not a string
 * concat), and every one comes from the frozen `PAIRS` table below — never from
 * input.
 *
 * `liveStatuses` is the destination parent's set that COUNTS. A cancelled or
 * draft downstream document releases its quantity in every converter in this
 * system, so counting it would manufacture false positives. Passing `null` means
 * "the destination has no parent status to filter on" and is a decision, stated:
 * the caller must say so rather than leave it off.
 */
export const doubleTransferred = (sql, pair, companyId) => {
  const { srcTable, srcQty, dstTable, dstQty, binding, dstParent, dstParentFk, liveStatuses } = pair;
  const statusFilter = liveStatuses
    ? sql`AND UPPER(COALESCE(par.status::text, '')) = ANY(${liveStatuses})`
    : sql``;
  const parentJoin = liveStatuses
    ? sql`JOIN scm.${sql(dstParent)} par ON par.id = d.${sql(dstParentFk)}`
    : sql``;
  return sql`
    WITH moved AS (
      SELECT d.${sql(binding)} AS src_id, SUM(COALESCE(d.${sql(dstQty)}, 0))::numeric AS qty_moved
        FROM scm.${sql(dstTable)} d
        ${parentJoin}
       WHERE d.${sql(binding)} IS NOT NULL
         ${statusFilter}
       GROUP BY 1
    )
    SELECT count(*)::int                                       AS lines_over,
           COALESCE(SUM(m.qty_moved - s.${sql(srcQty)}), 0)::numeric AS units_over,
           COALESCE(MAX(m.qty_moved - s.${sql(srcQty)}), 0)::numeric AS worst_line
      FROM moved m
      JOIN scm.${sql(srcTable)} s ON s.id = m.src_id
     WHERE s.company_id = ${companyId}
       AND m.qty_moved > s.${sql(srcQty)}
  `;
};

/** The worst offenders by name, so a non-zero census is actionable rather than
 *  just alarming. Same predicate as above; capped, because a report nobody can
 *  read is not evidence. */
export const doubleTransferredRows = (sql, pair, companyId, cap) => {
  const { srcTable, srcQty, dstTable, dstQty, binding, dstParent, dstParentFk, liveStatuses } = pair;
  const statusFilter = liveStatuses
    ? sql`AND UPPER(COALESCE(par.status::text, '')) = ANY(${liveStatuses})`
    : sql``;
  const parentJoin = liveStatuses
    ? sql`JOIN scm.${sql(dstParent)} par ON par.id = d.${sql(dstParentFk)}`
    : sql``;
  return sql`
    WITH moved AS (
      SELECT d.${sql(binding)} AS src_id, SUM(COALESCE(d.${sql(dstQty)}, 0))::numeric AS qty_moved
        FROM scm.${sql(dstTable)} d
        ${parentJoin}
       WHERE d.${sql(binding)} IS NOT NULL
         ${statusFilter}
       GROUP BY 1
    )
    SELECT s.id::text                                AS src_id,
           s.${sql(srcQty)}::numeric                 AS src_qty,
           m.qty_moved::numeric                      AS qty_moved,
           (m.qty_moved - s.${sql(srcQty)})::numeric AS over_by
      FROM moved m
      JOIN scm.${sql(srcTable)} s ON s.id = m.src_id
     WHERE s.company_id = ${companyId}
       AND m.qty_moved > s.${sql(srcQty)}
     ORDER BY over_by DESC
     LIMIT ${cap}
  `;
};

/**
 * Destination lines whose binding is NULL — invisible to every quantity ceiling
 * in the system.
 *
 * `convert-ceilings.test.ts` names this twice as a KNOWN EXPOSURE ("an UNLINKED
 * DO line (so_item_id NULL) is invisible to the ceiling", and the GRN twin). It
 * has never been counted in production. Every binding column in this tree is
 * `ON DELETE SET NULL`, so deleting one source line silently blanks the pointer
 * on all its downstream documents and re-opens the source for transfer.
 */
export const unboundDestLines = (sql, pair, companyId) => {
  const { dstTable, binding, dstParent, dstParentFk, liveStatuses } = pair;
  const statusFilter = liveStatuses
    ? sql`AND UPPER(COALESCE(par.status::text, '')) = ANY(${liveStatuses})`
    : sql``;
  const parentJoin = liveStatuses
    ? sql`JOIN scm.${sql(dstParent)} par ON par.id = d.${sql(dstParentFk)}`
    : sql``;
  return sql`
    SELECT count(*)::int                                                        AS total,
           count(*) FILTER (WHERE d.${sql(binding)} IS NULL)::int               AS unbound,
           count(*) FILTER (WHERE d.${sql(binding)} IS NOT NULL)::int           AS bound
      FROM scm.${sql(dstTable)} d
      ${parentJoin}
     WHERE d.company_id = ${companyId}
       ${statusFilter}
  `;
};

/**
 * THE PAIR TABLE. Frozen, and the only source of the identifiers above.
 *
 * `liveStatuses` per pair is taken from the converter that WRITES the tally, not
 * guessed: each one excludes exactly what its own release path excludes (a
 * cancelled downstream document gives its quantity back, a draft has not
 * committed it). Where a status set is stated as `null`, the destination has no
 * parent status gate and that is recorded rather than assumed.
 *
 * SO -> PO is deliberately ABSENT. The owner ruled 2026-08-17 that the Purchase
 * Order is not once-only — it follows MRP's shortage, so "transferred twice" is
 * not a defect there and counting it would report noise as a bug. Its own
 * measurement belongs with MRP.
 */
export const PAIRS = Object.freeze([
  {
    key: 'po_to_grn',
    label: 'PO line -> GRN',
    srcTable: 'purchase_order_items', srcQty: 'qty',
    dstTable: 'grn_items', dstQty: 'qty_accepted', binding: 'purchase_order_item_id',
    dstParent: 'grns', dstParentFk: 'grn_id',
    liveStatuses: ['POSTED'],
  },
  {
    key: 'grn_to_pi',
    label: 'GRN line -> Purchase Invoice',
    srcTable: 'grn_items', srcQty: 'qty_accepted',
    dstTable: 'purchase_invoice_items', dstQty: 'qty', binding: 'grn_item_id',
    dstParent: 'purchase_invoices', dstParentFk: 'purchase_invoice_id',
    liveStatuses: ['SUBMITTED', 'POSTED', 'PARTIALLY_PAID', 'PAID'],
  },
  {
    key: 'grn_to_pr',
    label: 'GRN line -> Purchase Return',
    srcTable: 'grn_items', srcQty: 'qty_accepted',
    dstTable: 'purchase_return_items', dstQty: 'qty_returned', binding: 'grn_item_id',
    dstParent: 'purchase_returns', dstParentFk: 'purchase_return_id',
    liveStatuses: ['DRAFT', 'SUBMITTED', 'POSTED', 'CREDIT_NOTED'],
  },
  {
    key: 'so_to_do',
    label: 'SO line -> Delivery Order',
    srcTable: 'mfg_sales_order_items', srcQty: 'qty',
    dstTable: 'delivery_order_items', dstQty: 'qty', binding: 'so_item_id',
    dstParent: 'delivery_orders', dstParentFk: 'delivery_order_id',
    liveStatuses: ['SUBMITTED', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED'],
  },
  {
    key: 'do_to_si',
    label: 'DO line -> Sales Invoice',
    srcTable: 'delivery_order_items', srcQty: 'qty',
    dstTable: 'sales_invoice_items', dstQty: 'qty', binding: 'do_item_id',
    dstParent: 'sales_invoices', dstParentFk: 'sales_invoice_id',
    liveStatuses: ['DRAFT', 'SUBMITTED', 'POSTED', 'PARTIALLY_PAID', 'PAID'],
  },
  {
    key: 'do_to_dr',
    label: 'DO line -> Delivery Return',
    srcTable: 'delivery_order_items', srcQty: 'qty',
    dstTable: 'delivery_return_items', dstQty: 'qty_returned', binding: 'do_item_id',
    dstParent: 'delivery_returns', dstParentFk: 'delivery_return_id',
    liveStatuses: ['DRAFT', 'SUBMITTED', 'POSTED', 'CREDIT_NOTED'],
  },
  {
    key: 'co_to_cn',
    label: 'Consignment Order line -> Consignment Note',
    srcTable: 'consignment_sales_order_items', srcQty: 'qty',
    dstTable: 'consignment_delivery_order_items', dstQty: 'qty',
    binding: 'consignment_so_item_id',
    dstParent: 'consignment_delivery_orders', dstParentFk: 'consignment_do_id',
    liveStatuses: ['SUBMITTED', 'SHIPPED', 'DELIVERED', 'PARTIALLY_DELIVERED'],
  },
  {
    key: 'cn_to_cr',
    label: 'Consignment Note line -> Consignment Return',
    srcTable: 'consignment_delivery_order_items', srcQty: 'qty',
    dstTable: 'consignment_delivery_return_items', dstQty: 'qty_returned',
    binding: 'consignment_do_item_id',
    dstParent: 'consignment_delivery_returns', dstParentFk: 'consignment_delivery_return_id',
    liveStatuses: ['DRAFT', 'SUBMITTED', 'POSTED', 'CREDIT_NOTED'],
  },
  {
    key: 'pco_to_pcr',
    label: 'PC Order line -> PC Receive',
    srcTable: 'purchase_consignment_order_items', srcQty: 'qty',
    dstTable: 'purchase_consignment_receive_items', dstQty: 'qty_accepted',
    binding: 'pc_order_item_id',
    dstParent: 'purchase_consignment_receives', dstParentFk: 'pc_receive_id',
    liveStatuses: ['POSTED'],
  },
  {
    key: 'pcr_to_pcrt',
    label: 'PC Receive line -> PC Return',
    srcTable: 'purchase_consignment_receive_items', srcQty: 'qty_accepted',
    dstTable: 'purchase_consignment_return_items', dstQty: 'qty_returned',
    binding: 'pc_receive_item_id',
    dstParent: 'purchase_consignment_returns', dstParentFk: 'pc_return_id',
    liveStatuses: ['DRAFT', 'SUBMITTED', 'POSTED'],
  },
]);

/** Every identifier a pair will interpolate, so the caller can verify the whole
 *  set exists before running any census over it. Returned as a flat list of
 *  `{ table, column }`; `null` column means "the table itself". */
export function pairIdentifiers(pair) {
  const out = [
    { table: pair.srcTable, column: null },
    { table: pair.srcTable, column: pair.srcQty },
    { table: pair.srcTable, column: 'company_id' },
    { table: pair.dstTable, column: null },
    { table: pair.dstTable, column: pair.dstQty },
    { table: pair.dstTable, column: pair.binding },
    { table: pair.dstTable, column: 'company_id' },
  ];
  if (pair.liveStatuses) {
    out.push({ table: pair.dstParent, column: null });
    out.push({ table: pair.dstParent, column: 'status' });
    out.push({ table: pair.dstTable, column: pair.dstParentFk });
  }
  return out;
}
